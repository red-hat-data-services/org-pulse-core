"""Embedding-based tool selector.

Embeds tool descriptions and user queries with an embedding model,
then selects the most relevant tools via cosine similarity.
"""

import logging
import math

import numpy as np
from openai import AsyncOpenAI
from pydantic_ai.toolsets import FunctionToolset

logger = logging.getLogger(__name__)


def _build_tool_text(
    name: str,
    description: str | None,
    params_schema: dict,
    metadata: dict | None = None,
) -> str:
    parts = [name]
    if description:
        parts.append(description)
    param_names = list(params_schema.get("properties", {}).keys())
    if param_names:
        parts.append("parameters: " + ", ".join(param_names))
    if metadata and metadata.get("embedding_hints"):
        parts.append(metadata["embedding_hints"])
    return " | ".join(parts)


class ToolSelector:
    def __init__(
        self,
        client: AsyncOpenAI,
        model_id: str,
        toolset: FunctionToolset,
        top_k_ratio: float = 0.3,
        min_tools: int = 3,
        confidence_threshold: float = 0.55,
    ):
        self._client = client
        self._model_id = model_id
        self._toolset = toolset
        self._top_k_ratio = top_k_ratio
        self._min_tools = min_tools
        self._confidence_threshold = confidence_threshold
        self._tool_names: list[str] = []
        self._tool_embeddings: np.ndarray | None = None
        self._top_k: int = 0

    async def warm_up(self) -> None:
        texts = []
        for name, tool in self._toolset.tools.items():
            self._tool_names.append(name)
            params_schema = (
                tool.function_schema.json_schema if tool.function_schema else {}
            )
            texts.append(
                _build_tool_text(name, tool.description, params_schema, tool.metadata)
            )

        response = await self._client.embeddings.create(
            model=self._model_id,
            input=texts,
        )
        emb = np.array([e.embedding for e in response.data])
        self._tool_embeddings = emb / np.linalg.norm(emb, axis=1, keepdims=True)
        self._top_k = max(
            self._min_tools,
            math.ceil(self._top_k_ratio * len(self._tool_names)),
        )
        logger.info(
            "Tool selector ready — %d tools, top_k=%d, dim=%d",
            len(self._tool_names),
            self._top_k,
            self._tool_embeddings.shape[1],
        )

    async def select(self, query: str) -> list[dict] | None:
        """Return the most relevant tools for the query, or None to use all."""
        response = await self._client.embeddings.create(
            model=self._model_id,
            input=[query],
        )
        qv = np.array(response.data[0].embedding)
        query_vec = qv / np.linalg.norm(qv)

        sims = self._tool_embeddings @ query_vec

        ranked = sorted(
            zip(self._tool_names, sims.tolist()),
            key=lambda x: x[1],
            reverse=True,
        )

        top_score = ranked[0][1] if ranked else 0.0
        if top_score < self._confidence_threshold:
            logger.debug(
                "Top score %.3f below confidence %.3f — using all tools",
                top_score,
                self._confidence_threshold,
            )
            return None

        selected = [
            {"name": name, "similarity": round(score, 3)}
            for name, score in ranked[: self._top_k]
        ]

        logger.debug(
            "Tool selection for %r: %s",
            query[:80],
            ", ".join(f"{t['name']}({t['similarity']})" for t in selected),
        )
        return selected
