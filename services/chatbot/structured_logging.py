"""Structured JSON logging for the chatbot agent.

Replaces free-form logs with machine-parseable JSON lines.
Each entry has a consistent schema: ts, level, logger, event, plus
event-specific fields.

Usage::

    from structured_logging import log_event, setup_logging

    setup_logging()  # call once at startup

    log_event(logger, logging.INFO, request_id=req_id,
              event="tool_executed", tool="search_people", duration_ms=142)

Query examples with jq::

    jq 'select(.request_id == "abc12345")' agent.log
    jq 'select(.event == "request_completed")' agent.log
    jq 'select(.event == "tool_executed") | {tool, duration_ms}' agent.log
"""

import json
import logging
import sys
from datetime import datetime, timezone


class StructuredFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            "ts": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
        }
        if hasattr(record, "structured"):
            entry.update(record.structured)
        else:
            entry["message"] = record.getMessage()
        return json.dumps(entry, default=str)


def setup_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(StructuredFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True


def log_event(
    logger: logging.Logger,
    level: int,
    request_id: str | None = None,
    stream: bool = False,
    **fields,
) -> None:
    structured = dict(fields)
    if request_id:
        structured["request_id"] = request_id
    if stream:
        structured["stream"] = True
    logger.log(level, "", extra={"structured": structured})
