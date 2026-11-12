"""Telegram Bot API client (long polling + sendMessage).

Only the two calls Release 1 needs are implemented. The bot token is part of
the request path, so every error raised or logged from here is scrubbed: the
token must never reach application logs.
"""

from __future__ import annotations

from typing import Any

import httpx

DEFAULT_BASE_URL = "https://api.telegram.org"
DEFAULT_TIMEOUT_SEC = 60.0


class TelegramError(RuntimeError):
    """A Telegram request failed; the message never contains the token.

    ``status`` is the HTTP status when the API answered (``None`` for a network
    failure). ``retry_after`` is Telegram's rate-limit hint in seconds.
    ``permanent`` marks a 4xx other than 429: retrying such a request can never
    succeed (blocked bot, chat not found, malformed message, …).
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after

    @property
    def permanent(self) -> bool:
        return (
            self.status is not None and 400 <= self.status < 500 and self.status != 429
        )


class TelegramClient:
    """Bot API client.

    ``get_updates`` is async because long polling waits up to ``timeout``
    seconds and must be cancellable at shutdown. ``send_message`` is a short
    synchronous call so :meth:`TelegramBot.send_long` stays a plain function;
    the bot offloads it to a worker thread while handling an update.
    """

    def __init__(
        self,
        token: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        client: httpx.Client | None = None,
        async_client: httpx.AsyncClient | None = None,
        timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    ) -> None:
        if not token:
            raise ValueError("telegram bot token is required")
        self._token = token
        self._base_url = base_url.rstrip("/")
        self._timeout_sec = timeout_sec
        self._client = client or httpx.Client(timeout=timeout_sec)
        self._async_client = async_client or httpx.AsyncClient(timeout=timeout_sec)

    def __repr__(self) -> str:
        return f"TelegramClient(base_url={self._base_url!r})"

    def close(self) -> None:
        self._client.close()

    async def aclose(self) -> None:
        self._client.close()
        await self._async_client.aclose()

    async def get_updates(self, offset: int, timeout: int = 50) -> list[dict[str, Any]]:
        """Return pending updates starting at ``offset`` (Telegram long poll)."""
        result = await self._acall(
            "getUpdates",
            {"offset": offset, "timeout": timeout},
            timeout=timeout + 10,
        )
        return result if isinstance(result, list) else []

    def send_message(self, chat_id: int, text: str) -> dict[str, Any]:
        """Send one message; callers split anything over 4096 characters."""
        result = self._call("sendMessage", {"chat_id": chat_id, "text": text})
        return result if isinstance(result, dict) else {}

    # -- transport ------------------------------------------------------

    def _url(self, method: str) -> str:
        return f"{self._base_url}/bot{self._token}/{method}"

    def _call(
        self, method: str, payload: dict[str, Any], *, timeout: float | None = None
    ) -> Any:
        try:
            response = self._client.post(
                self._url(method),
                json=payload,
                timeout=timeout or self._timeout_sec,
            )
        except httpx.HTTPError as exc:
            # ``from None`` keeps the token-bearing URL out of the traceback.
            raise TelegramError(
                f"telegram {method} request failed ({type(exc).__name__})"
            ) from None

        return _result(method, response)

    async def _acall(
        self, method: str, payload: dict[str, Any], *, timeout: float | None = None
    ) -> Any:
        try:
            response = await self._async_client.post(
                self._url(method),
                json=payload,
                timeout=timeout or self._timeout_sec,
            )
        except httpx.HTTPError as exc:
            raise TelegramError(
                f"telegram {method} request failed ({type(exc).__name__})"
            ) from None
        return _result(method, response)


def _result(method: str, response: httpx.Response) -> Any:
    if response.status_code >= 400:
        raise TelegramError(
            f"telegram {method} returned HTTP {response.status_code}",
            status=response.status_code,
            retry_after=_retry_after(response),
        )

    try:
        body = response.json()
    except ValueError:
        raise TelegramError(f"telegram {method} returned invalid JSON") from None
    if not isinstance(body, dict) or body.get("ok") is False:
        raise TelegramError(f"telegram {method} returned an error")
    return body.get("result")


def _retry_after(response: httpx.Response) -> float | None:
    """Telegram's ``parameters.retry_after`` (or the standard header)."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        parameters = body.get("parameters")
        if isinstance(parameters, dict):
            value = parameters.get("retry_after")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
    header = response.headers.get("retry-after")
    if header:
        try:
            return float(header)
        except ValueError:
            return None
    return None
