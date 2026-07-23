"""FastAPI application for the Org Pulse chatbot agent."""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from pathlib import Path

import truststore
truststore.inject_into_ssl()

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import AsyncOpenAI

from agent import (
    load_config,
    resolve_env,
    create_agent,
    create_gate_agent,
    create_master_toolset,
    create_org_pulse_client,
    create_tool_selector,
)
from routers import chat
from structured_logging import setup_logging

AGENT_PORT = int(os.environ.get("CHATBOT_PORT", 8002))
_LLM_PROBE_INTERVAL = 30

logger = logging.getLogger(__name__)


async def _llm_health_probe(app: FastAPI) -> None:
    config = load_config()
    ep = config["endpoint"]
    base_url = resolve_env(ep["base_url"])
    api_key = resolve_env(ep["api_key"])
    if not base_url or not api_key:
        logger.warning("LLM endpoint not configured, health probe disabled")
        return

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=10,
        max_retries=0,
    )
    was_reachable = True

    while True:
        try:
            await client.models.list()
            app.state.llm_reachable = True
            if not was_reachable:
                logger.info("LLM recovered")
            was_reachable = True
        except Exception as exc:
            app.state.llm_reachable = False
            if was_reachable:
                logger.warning("LLM unreachable: %s", exc)
            was_reachable = False
        await asyncio.sleep(_LLM_PROBE_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    logger.info("Starting Org Pulse chatbot agent")

    org_pulse_client = create_org_pulse_client()
    app.state.org_pulse_client = org_pulse_client

    app.state.llm_reachable = True

    app.state.agent = create_agent()
    if app.state.agent:
        logger.info("Agent created")
    else:
        logger.warning("Agent not created — LLM credentials missing")

    app.state.master_toolset = create_master_toolset()
    logger.info("Master toolset created (%d tools)", len(app.state.master_toolset.tools))

    tool_selector = create_tool_selector(app.state.master_toolset)
    if tool_selector:
        try:
            await tool_selector.warm_up()
            app.state.tool_selector = tool_selector
        except Exception as exc:
            logger.warning("Tool selector warm-up failed, disabled: %s", exc)
            app.state.tool_selector = None
    else:
        app.state.tool_selector = None
        logger.info("No tool_selector config — using all tools")

    app.state.gate_agent = create_gate_agent()
    if app.state.gate_agent:
        logger.info("Gate agent created")
    else:
        logger.info("No gate config — off-topic gate disabled")

    probe_task = asyncio.create_task(_llm_health_probe(app))

    yield

    probe_task.cancel()
    try:
        await probe_task
    except asyncio.CancelledError:
        pass
    await org_pulse_client.close()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Org Pulse Chatbot Agent",
    description="AI assistant for Org Pulse data powered by Pydantic AI",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3001").split(","),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(chat.router)


@app.get("/health")
async def health():
    checks = {}

    agent = getattr(app.state, "agent", None)
    if not agent:
        checks["llm"] = "not configured"
    else:
        llm_reachable = getattr(app.state, "llm_reachable", None)
        if llm_reachable is None:
            checks["llm"] = "not initialized"
        elif llm_reachable:
            checks["llm"] = "ok"
        else:
            checks["llm"] = "unreachable"

    org_pulse = getattr(app.state, "org_pulse_client", None)
    if org_pulse:
        checks["org_pulse_api"] = "configured"
    else:
        checks["org_pulse_api"] = "not configured"

    all_ok = all(v in ("ok", "configured", "not configured") for v in checks.values())
    return JSONResponse(
        status_code=200,
        content={"status": "ok" if all_ok else "degraded", "checks": checks},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=AGENT_PORT,
        reload=True,
    )
