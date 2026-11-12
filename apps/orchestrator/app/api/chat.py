"""Chat streaming (SSE) and the primary-agent endpoint.

``POST /v1/chat/stream`` streams an :class:`AgentEvent` sequence as Server-Sent
Events (``event: token|tool_call|tool_result|done|error`` + a JSON ``data``
line). It requires a paired device, validates that the conversation belongs to
the authenticated user, and refuses to interleave: a second request for a
conversation that already has an in-flight turn gets HTTP 409 ``{status:
"queued", position}``.

``GET /v1/agent`` returns the seeded primary entity (``e_potaeto``).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent.factory import build_agent_loop, choices_from_state
from app.agent.loop import AgentEvent, AgentLoop
from app.api.rate_limit import enforce_rate_limit
from app.auth.dependencies import AuthContext, get_db, require_device
from app.db.constants import PRIMARY_ENTITY_ID
from app.db.repositories.conversations import ConversationRepo
from app.db.repositories.entities import EntityRepo

router = APIRouter(prefix="/v1", tags=["chat"])


class ChatStreamRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    message: str = Field(min_length=1)
    client_message_id: str | None = Field(default=None, min_length=1)


class PrimaryAgentResponse(BaseModel):
    id: str
    name: str
    slug: str
    avatar: str | None = None


class ConversationResponse(BaseModel):
    id: str
    entity_id: str


def _resolve_loop(request: Request) -> AgentLoop:
    """Build the loop for this request from the shared app state.

    Provider candidates are resolved at startup (and by the model picker). The
    loop therefore knows the failover order and whether the chosen model
    supports tools; a per-request catalog fetch would add latency to every turn.
    """
    state = request.app.state
    registry = getattr(state, "providers", None)
    names = registry.names() if registry is not None else []
    if not names:
        raise HTTPException(status_code=503, detail="no provider configured")
    model = getattr(state, "model", "") or ""
    if not model:
        raise HTTPException(status_code=503, detail="no model configured")
    try:
        return build_agent_loop(
            state.db,
            choices_from_state(state),
            model,
            queue=state.turn_queue,
            max_tokens=state.settings.max_output_tokens,
            settings=state.settings,
        )
    except LookupError as exc:
        raise HTTPException(status_code=503, detail="no provider configured") from exc


def _avatar(entity) -> str | None:
    attributes = entity.attributes_json or {}
    appearance = entity.appearance_json or {}
    if isinstance(attributes, dict) and attributes.get("avatar"):
        return str(attributes["avatar"])
    if isinstance(appearance, dict) and appearance.get("avatar"):
        return str(appearance["avatar"])
    return None


@router.get("/agent", response_model=PrimaryAgentResponse)
def get_primary_agent(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> PrimaryAgentResponse:
    """Return the primary agent entity (seeded ``e_potaeto``)."""
    entity = EntityRepo(db).get(PRIMARY_ENTITY_ID)
    if entity is None:  # pragma: no cover - seeded by 0001_initial.sql
        raise HTTPException(status_code=404, detail="primary agent not found")
    return PrimaryAgentResponse(
        id=entity.id,
        name=entity.name,
        slug=entity.slug,
        avatar=_avatar(entity),
    )


@router.get("/chat/conversation", response_model=ConversationResponse)
def get_primary_conversation(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> ConversationResponse:
    """Ensure and return the shared (user, primary agent) conversation id.

    The PWA needs this id up front to call ``POST /v1/chat/stream``; the pair
    is created on first use so a fresh device can chat without an extra setup
    step.
    """
    conversation = ConversationRepo(db).ensure_conversation(ctx.user_id, PRIMARY_ENTITY_ID)
    return ConversationResponse(id=conversation.id, entity_id=conversation.entity_id)


def _sse_frame(event_type: str, data: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, default=str)}\n\n"


async def _event_stream(
    events: AsyncIterator[AgentEvent],
    release: Any | None = None,
) -> AsyncIterator[str]:
    """Frame AgentEvents as SSE, releasing the reservation on completion/error.

    The inner generator is explicitly closed in ``finally`` so a client
    disconnect also releases the per-conversation lock held by ``AgentLoop.run``.
    """
    try:
        async for event in events:
            yield _sse_frame(event.type, event.data)
    finally:
        close = getattr(events, "aclose", None)
        if close is not None:
            await close()
        if release is not None:
            release()


@router.post("/chat/stream")
async def chat_stream(
    req: ChatStreamRequest,
    request: Request,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
):
    """Stream one turn as SSE, or 409 when the conversation is already running."""
    # Authenticated but expensive (provider tokens): throttle per device before
    # any conversation or provider work happens.
    enforce_rate_limit(
        request,
        f"chat:{ctx.device_id}",
        request.app.state.settings.rate_limit_chat_per_min,
    )

    conversation = ConversationRepo(db).get(req.conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    if conversation.user_id != ctx.user_id:
        raise HTTPException(status_code=403, detail="conversation does not belong to this user")

    loop = _resolve_loop(request)
    # Reserve the turn slot synchronously so two concurrent requests get a
    # deterministic first-wins outcome instead of racing on the lock.
    if not loop.try_acquire_turn(req.conversation_id):
        return JSONResponse(
            status_code=409,
            content={
                "status": "queued",
                "position": loop.queued_position(req.conversation_id),
            },
        )

    return StreamingResponse(
        _event_stream(
            loop.run(
                req.conversation_id,
                req.message,
                channel="app",
                client_message_id=req.client_message_id,
            ),
            release=lambda: loop.release_turn(req.conversation_id),
        ),
        media_type="text/event-stream",
        headers={"X-Conversation-Id": req.conversation_id, "Cache-Control": "no-cache"},
    )
