"""Pydantic AI Agent definition for Org Pulse chatbot.

Creates the main agent, gate agent, master toolset, and tool selector.
"""

import logging
import os
import re
from pathlib import Path

import httpx
import yaml
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel as OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings
from pydantic_ai.toolsets import FunctionToolset

from prompts.gate import GATE_PROMPT
from prompts.system import SYSTEM_PROMPT
from services.org_pulse_client import OrgPulseClient
from tool_selector import ToolSelector
from tools import ALL_TOOLS

logger = logging.getLogger(__name__)

ENV_PATTERN_RE = re.compile(r"^\$\{(\w+)\}$")


def resolve_env(value: str) -> str | None:
    if not isinstance(value, str):
        return value
    m = ENV_PATTERN_RE.match(value.strip())
    if m:
        return os.environ.get(m.group(1)) or None
    return value


config_cache: dict | None = None


def load_config() -> dict:
    global config_cache
    if config_cache is None:
        config_path = Path(__file__).resolve().parent / "agent.yaml"
        with open(config_path) as f:
            config_cache = yaml.safe_load(f)
    return config_cache


def get_max_tool_rounds() -> int:
    return load_config().get("pipeline", {}).get("max_tool_rounds", 5)


def get_max_history_tokens() -> int:
    return load_config().get("pipeline", {}).get("max_history_tokens", 2000)


def get_max_history_messages() -> int:
    return load_config().get("pipeline", {}).get("max_history_messages", 6)


def create_agent() -> Agent | None:
    config = load_config()
    ep = config["endpoint"]

    base_url = resolve_env(ep["base_url"])
    api_key = resolve_env(ep["api_key"])
    if not base_url or not api_key:
        logger.warning("LLM endpoint not configured — agent disabled")
        return None

    timeout = config.get("pipeline", {}).get("timeout", 300)
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10))

    model = OpenAIModel(
        resolve_env(ep["model"]),
        provider=OpenAIProvider(
            base_url=base_url,
            api_key=api_key,
            http_client=http_client,
        ),
    )

    temperature = ep.get("temperature", 0.3)
    settings: ModelSettings = {"temperature": temperature}
    extra_body = ep.get("extra_body")
    if extra_body:
        settings["extra_body"] = extra_body

    return Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        retries=2,
        model_settings=settings,
    )


def get_gate_threshold() -> float:
    return load_config().get("gate", {}).get("confidence_threshold", 0.5)


def create_gate_agent() -> Agent[None, str] | None:
    config = load_config()
    gate = config.get("gate", {})
    if not gate or not resolve_env(gate.get("base_url", "")):
        return None

    model = OpenAIModel(
        resolve_env(gate["model"]),
        provider=OpenAIProvider(
            base_url=resolve_env(gate["base_url"]),
            api_key=resolve_env(gate["api_key"]),
            http_client=httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5)),
        ),
    )

    return Agent(
        model=model,
        system_prompt=GATE_PROMPT,
        model_settings={
            "temperature": gate.get("temperature", 0.0),
            "max_tokens": 1,
            "openai_logprobs": True,
            "openai_top_logprobs": 5,
        },
    )


def get_model_name() -> str:
    raw = load_config().get("endpoint", {}).get("model", "unknown")
    return raw.split("/")[-1] if "/" in raw else raw


def create_master_toolset() -> FunctionToolset:
    return FunctionToolset(ALL_TOOLS)


def create_org_pulse_client() -> OrgPulseClient:
    base_url = os.environ.get("ORG_PULSE_API_URL", "http://localhost:3001")
    api_token = os.environ.get("ORG_PULSE_API_TOKEN")
    oauth_cookie = os.environ.get("ORG_PULSE_OAUTH_COOKIE")
    return OrgPulseClient(
        base_url=base_url,
        api_token=api_token,
        oauth_cookie=oauth_cookie,
    )


def create_tool_selector(toolset: FunctionToolset) -> ToolSelector | None:
    config = load_config()
    ts = config.get("tool_selector")
    if not ts or not resolve_env(ts.get("base_url", "")):
        return None

    client = AsyncOpenAI(
        api_key=resolve_env(ts["api_key"]),
        base_url=resolve_env(ts["base_url"]),
        timeout=10,
        max_retries=1,
    )

    return ToolSelector(
        client=client,
        model_id=resolve_env(ts["model"]),
        toolset=toolset,
        top_k_ratio=ts.get("top_k_ratio", 0.3),
        min_tools=ts.get("min_tools", 3),
        confidence_threshold=ts.get("confidence_threshold", 0.55),
    )
