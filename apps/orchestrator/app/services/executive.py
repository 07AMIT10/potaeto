"""Autonomous Executive Engine for morning briefings and memory consolidation.

Combines system vitals, unapproved actions, active scheduled tasks, and
high-importance memories into an executive briefing, and clusters candidate
memory notes to identify contradictions or proposed mergers.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.jobs import JobRepo
from app.db.repositories.memories import Memory, MemoryRepo
from app.memory.embeddings import cosine_similarity, generate_embedding
from app.tools.monitor import MonitorTools

logger = logging.getLogger(__name__)

NEGATION_WORDS = frozenset(
    {
        "not",
        "never",
        "no",
        "neither",
        "nor",
        "disabled",
        "inactive",
        "stopped",
        "failed",
        "false",
        "off",
        "disallowed",
        "rejected",
    }
)


class ExecutiveService:
    """Provides executive morning briefings and candidate memory consolidation."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.memory_repo = MemoryRepo(conn)
        self.job_repo = JobRepo(conn)
        self.approval_repo = ApprovalRepo(conn)
        self.monitor_tools = MonitorTools(conn)

    def generate_morning_briefing(
        self, user_id: str = "u_local", *, hours: int = 24
    ) -> dict[str, Any]:
        """Combine system vitals, unapproved actions, tasks, and memories into an executive briefing."""
        now_utc = datetime.now(UTC)
        timestamp_str = now_utc.strftime("%Y-%m-%d %H:%M:%S UTC")

        # 1. System vitals
        vitals = self.monitor_tools.system_health()

        # 2. Unapproved actions (pending approvals)
        pending_approvals = self.approval_repo.list_pending()

        # 3. Active tasks (enabled scheduled jobs)
        active_tasks = self.job_repo.list(enabled=True)

        # 4. Yesterday's high-importance memories
        cutoff = (now_utc - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        memory_rows = self.conn.execute(
            """
            SELECT * FROM memories
            WHERE deleted = 0 AND status = 'active' AND confidence >= 0.7
              AND (created_at >= ? OR updated_at >= ?)
              AND (user_id = ? OR user_id = 'u_local')
            ORDER BY confidence DESC, created_at DESC
            LIMIT 20
            """,
            (cutoff, cutoff, user_id),
        ).fetchall()
        high_importance_memories = [self.memory_repo._to_model(row) for row in memory_rows]

        # Format executive markdown text
        briefing_lines: list[str] = [
            "# Executive Morning Briefing",
            f"**Generated:** {timestamp_str}",
            "",
            "## System Vitals",
        ]

        load_1m = vitals.get("load_1m")
        mem_mb = vitals.get("mem_available_mb")
        cpu_temp = vitals.get("cpu_temp_c")
        disk_pct = vitals.get("disk_used_pct")

        briefing_lines.append(f"- **CPU Load (1m):** {load_1m if load_1m is not None else 'N/A'}")
        briefing_lines.append(f"- **Available RAM:** {f'{mem_mb:.1f} MB' if mem_mb is not None else 'N/A'}")
        briefing_lines.append(f"- **CPU Temperature:** {f'{cpu_temp:.1f}°C' if cpu_temp is not None else 'N/A'}")
        briefing_lines.append(f"- **Disk Usage:** {f'{disk_pct:.1f}%' if disk_pct is not None else 'N/A'}")
        briefing_lines.append("")

        briefing_lines.append("## Pending Approvals (Requires Action)")
        if pending_approvals:
            for appr in pending_approvals:
                expires_in = max(0, int(appr.get("expires_at", 0) - now_utc.timestamp()))
                args_summary = str(appr.get("arguments", {}))
                if len(args_summary) > 60:
                    args_summary = args_summary[:57] + "..."
                briefing_lines.append(
                    f"- **[{appr['id']}]** Tool: `{appr['tool_name']}` | "
                    f"Args: `{args_summary}` | Expires in: {expires_in}s"
                )
        else:
            briefing_lines.append("- *No unapproved actions pending.*")
        briefing_lines.append("")

        briefing_lines.append("## Active Tasks & Schedules")
        if active_tasks:
            for job in active_tasks:
                briefing_lines.append(
                    f"- **{job.name}** | Schedule: `{job.schedule or 'ad-hoc'}` | "
                    f"Next Run: `{job.next_run or 'none'}`"
                )
        else:
            briefing_lines.append("- *No active background tasks or schedules.*")
        briefing_lines.append("")

        briefing_lines.append("## High-Importance Memories (Last 24 Hours)")
        if high_importance_memories:
            for mem in high_importance_memories:
                content_preview = mem.content.replace("\n", " ").strip()
                if len(content_preview) > 90:
                    content_preview = content_preview[:87] + "..."
                briefing_lines.append(
                    f"- [{mem.kind}] {content_preview} (Confidence: {mem.confidence:.2f})"
                )
        else:
            briefing_lines.append("- *No high-importance memories recorded in this window.*")

        briefing_text = "\n".join(briefing_lines)

        return {
            "briefing": briefing_text,
            "generated_at": timestamp_str,
            "vitals": vitals,
            "pending_approvals_count": len(pending_approvals),
            "pending_approvals": pending_approvals,
            "active_tasks_count": len(active_tasks),
            "active_tasks": [asdict(t) for t in active_tasks],
            "high_importance_memories_count": len(high_importance_memories),
            "high_importance_memories": [
                {
                    "id": m.id,
                    "kind": m.kind,
                    "content": m.content,
                    "confidence": m.confidence,
                    "scope": m.scope,
                    "created_at": m.created_at,
                }
                for m in high_importance_memories
            ],
        }

    def consolidate_memories(
        self,
        user_id: str = "u_local",
        *,
        cluster_threshold: float = 0.65,
        merger_threshold: float = 0.85,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Cluster recent candidate notes, identifying proposed mergers and contradictions."""
        # 1. Fetch candidate memories (unconfirmed or candidate notes)
        rows = self.conn.execute(
            """
            SELECT * FROM memories
            WHERE deleted = 0 AND status = 'active' AND user_confirmed = 0
              AND (user_id = ? OR user_id = 'u_local')
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

        candidates: list[Memory] = [self.memory_repo._to_model(row) for row in rows]
        if len(candidates) < 2:
            return {
                "candidates_analyzed": len(candidates),
                "clusters_count": 0,
                "clusters": [],
                "mergers": [],
                "contradictions": [],
                "consolidated_at": datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC"),
            }

        # 2. Compute embeddings
        vectors: list[list[float]] = [generate_embedding(c.content) for c in candidates]

        # 3. Pairwise similarity & clustering (connected components)
        n = len(candidates)
        adj: dict[int, set[int]] = {i: set() for i in range(n)}
        pairwise_sim: dict[tuple[int, int], float] = {}

        for i in range(n):
            for j in range(i + 1, n):
                sim = cosine_similarity(vectors[i], vectors[j])
                pairwise_sim[(i, j)] = sim
                if sim >= cluster_threshold:
                    adj[i].add(j)
                    adj[j].add(i)

        # Find connected components
        visited: set[int] = set()
        clusters_indices: list[list[int]] = []
        for i in range(n):
            if i not in visited:
                comp = []
                queue = [i]
                visited.add(i)
                while queue:
                    curr = queue.pop(0)
                    comp.append(curr)
                    for neighbor in adj[curr]:
                        if neighbor not in visited:
                            visited.add(neighbor)
                            queue.append(neighbor)
                if len(comp) > 1:
                    clusters_indices.append(comp)

        # 4. Analyze each cluster for proposed mergers and contradictions
        mergers: list[dict[str, Any]] = []
        contradictions: list[dict[str, Any]] = []

        for comp in clusters_indices:
            for idx_a in range(len(comp)):
                for idx_b in range(idx_a + 1, len(comp)):
                    i = comp[idx_a]
                    j = comp[idx_b]
                    mem_a = candidates[i]
                    mem_b = candidates[j]
                    sim = pairwise_sim.get((min(i, j), max(i, j)), 0.0)

                    conflict = self._detect_contradiction(mem_a.content, mem_b.content)
                    if conflict:
                        contradictions.append(
                            {
                                "memory_id_a": mem_a.id,
                                "memory_id_b": mem_b.id,
                                "similarity": round(sim, 4),
                                "conflict_type": conflict["type"],
                                "reason": conflict["reason"],
                                "content_a": mem_a.content,
                                "content_b": mem_b.content,
                            }
                        )
                    elif sim >= merger_threshold:
                        # Determine primary vs secondary
                        primary, secondary = (
                            (mem_a, mem_b)
                            if mem_a.confidence >= mem_b.confidence
                            else (mem_b, mem_a)
                        )
                        mergers.append(
                            {
                                "primary_id": primary.id,
                                "secondary_id": secondary.id,
                                "similarity": round(sim, 4),
                                "reason": "High semantic overlap; candidates for deduplication / consolidation",
                                "proposed_content": primary.content
                                if len(primary.content) >= len(secondary.content)
                                else secondary.content,
                            }
                        )

        # Format cluster representations
        cluster_list = []
        for c_idx, comp in enumerate(clusters_indices):
            cluster_mems = [candidates[k] for k in comp]
            sample_words = re.findall(
                r"\b\w{4,}\b", " ".join(m.content for m in cluster_mems).lower()
            )
            summary_topic = ", ".join(list(dict.fromkeys(sample_words))[:4]) or "candidate cluster"
            cluster_list.append(
                {
                    "cluster_id": f"c_{c_idx + 1}",
                    "topic_keywords": summary_topic,
                    "memory_ids": [m.id for m in cluster_mems],
                    "size": len(cluster_mems),
                }
            )

        return {
            "candidates_analyzed": len(candidates),
            "clusters_count": len(cluster_list),
            "clusters": cluster_list,
            "mergers": mergers,
            "contradictions": contradictions,
            "consolidated_at": datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC"),
        }

    @staticmethod
    def _detect_contradiction(t1: str, t2: str) -> dict[str, str] | None:
        """Heuristic check for direct negation or conflicting numeric values."""
        w1 = set(re.findall(r"\b\w+\b", t1.lower()))
        w2 = set(re.findall(r"\b\w+\b", t2.lower()))

        n1 = w1 & NEGATION_WORDS
        n2 = w2 & NEGATION_WORDS
        if bool(n1) != bool(n2):
            common_words = (w1 - NEGATION_WORDS) & (w2 - NEGATION_WORDS)
            if len(common_words) >= 2:
                return {
                    "type": "negation_opposition",
                    "reason": (
                        f"One statement contains polarity indicators {n1 or n2} "
                        f"while discussing common concepts: {sorted(common_words)[:3]}"
                    ),
                }

        # Check numeric differences on matching entities
        nums1 = set(re.findall(r"\b\d+\b", t1))
        nums2 = set(re.findall(r"\b\d+\b", t2))
        if nums1 and nums2 and nums1 != nums2:
            common = (w1 - nums1) & (w2 - nums2)
            if len(common) >= 3:
                return {
                    "type": "divergent_values",
                    "reason": f"Divergent values ({sorted(nums1)} vs {sorted(nums2)}) for subject: {sorted(common)[:3]}",
                }

        return None


__all__ = ["ExecutiveService"]
