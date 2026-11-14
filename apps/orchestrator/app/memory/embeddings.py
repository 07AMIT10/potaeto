"""On-device 384-dimensional embedding helper for vector memory.

Uses fastembed / ONNX bge-small-en-v1.5 if available, with a deterministic,
zero-dependency local embedding fallback that works 100% offline without
network calls.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import struct
from typing import Any

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 384

_fastembed_model: Any = None
_fastembed_failed: bool = False


def serialize_float32(vector: list[float]) -> bytes:
    """Pack a float vector into binary float32 bytes for sqlite-vec."""
    return struct.pack(f"{len(vector)}f", *vector)


def deserialize_float32(data: bytes) -> list[float]:
    """Unpack binary float32 bytes back into a float list."""
    count = len(data) // 4
    return list(struct.unpack(f"{count}f", data))


def cosine_similarity(v1: list[float], v2: list[float]) -> float:
    """Compute cosine similarity between two float vectors."""
    if len(v1) != len(v2) or not v1:
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    if norm1 <= 0.0 or norm2 <= 0.0:
        return 0.0
    return dot / (norm1 * norm2)


def _deterministic_local_embedding(text: str, dim: int = EMBEDDING_DIM) -> list[float]:
    """Generate a deterministic 384-dimensional normalized embedding offline.

    Uses feature hashing across tokens, token bigrams, and character trigrams
    with sign-hashing to minimize bucket collision artifacts and retain
    lexical and subword similarity.
    """
    if not text or not text.strip():
        return [0.0] * dim

    vec = [0.0] * dim
    words = re.findall(r"\b\w+\b", text.lower())
    if not words:
        return [0.0] * dim

    # Word unigrams
    for i, word in enumerate(words):
        digest = hashlib.md5(f"w:{word}".encode()).digest()
        h = int.from_bytes(digest[:8], byteorder="big")
        idx = h % dim
        sign = 1.0 if ((h >> 16) & 1) == 0 else -1.0
        vec[idx] += sign * 1.5

        # Word bigrams
        if i > 0:
            bg = f"{words[i-1]}_{word}"
            digest_bg = hashlib.md5(f"b:{bg}".encode()).digest()
            h_bg = int.from_bytes(digest_bg[:8], byteorder="big")
            idx_bg = h_bg % dim
            sign_bg = 1.0 if ((h_bg >> 16) & 1) == 0 else -1.0
            vec[idx_bg] += sign_bg * 2.0

    # Character trigrams for morphological and subword capture
    clean_text = " " + " ".join(words) + " "
    for j in range(len(clean_text) - 2):
        trigram = clean_text[j : j + 3]
        digest_tri = hashlib.md5(f"t:{trigram}".encode()).digest()
        h_tri = int.from_bytes(digest_tri[:8], byteorder="big")
        idx_tri = h_tri % dim
        sign_tri = 1.0 if ((h_tri >> 16) & 1) == 0 else -1.0
        vec[idx_tri] += sign_tri * 0.5

    # L2 normalize
    norm = math.sqrt(sum(x * x for x in vec))
    if norm > 0.0:
        vec = [round(x / norm, 7) for x in vec]
    return vec


def _get_fastembed_model() -> Any:
    global _fastembed_model, _fastembed_failed
    if _fastembed_failed:
        return None
    if _fastembed_model is not None:
        return _fastembed_model
    try:
        from fastembed import TextEmbedding  # type: ignore[import-not-found]

        _fastembed_model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
        return _fastembed_model
    except Exception as exc:  # noqa: BLE001
        logger.debug("Fastembed unavailable, using deterministic local embeddings: %s", exc)
        _fastembed_failed = True
        return None


def generate_embedding(text: str) -> list[float]:
    """Generate a 384-dimensional float embedding vector for `text`.

    Attempts fastembed/bge-small-en-v1.5 if available in the environment,
    otherwise cleanly falls back to deterministic local feature-hashed embedding.
    """
    model = _get_fastembed_model()
    if model is not None:
        try:
            embeddings = list(model.embed([text]))
            if embeddings and len(embeddings[0]) == EMBEDDING_DIM:
                return [float(x) for x in embeddings[0]]
        except Exception as exc:  # noqa: BLE001
            logger.debug("Fastembed inference failed, falling back to local: %s", exc)

    return _deterministic_local_embedding(text, EMBEDDING_DIM)


__all__ = [
    "EMBEDDING_DIM",
    "cosine_similarity",
    "deserialize_float32",
    "generate_embedding",
    "serialize_float32",
]
