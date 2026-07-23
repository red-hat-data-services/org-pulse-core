"""Request and response models for the chatbot API."""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

MAX_MESSAGE_LENGTH = 4000
MAX_HISTORY_MESSAGES = 50
MAX_HISTORY_MESSAGE_LENGTH = 8000


class Message(BaseModel):
    role: Literal["user", "assistant"] = Field(..., description="Message role")
    content: str = Field(
        ..., description="Message content", max_length=MAX_HISTORY_MESSAGE_LENGTH
    )
    used_tools: Optional[bool] = Field(
        default=None,
        description="Whether the assistant used tools for this response",
    )


class ChatRequest(BaseModel):
    message: str = Field(
        ...,
        description="The user's question",
        min_length=1,
        max_length=MAX_MESSAGE_LENGTH,
    )
    history: Optional[List[Message]] = Field(
        default=None,
        description="Previous conversation messages for multi-turn context",
        max_length=MAX_HISTORY_MESSAGES,
    )
    context: Optional[str] = Field(
        default=None,
        description="Accumulated tool context from previous turns",
        max_length=MAX_HISTORY_MESSAGE_LENGTH,
    )


class ChatResponse(BaseModel):
    message: str = Field(..., description="The assistant's response")
    tool_calls: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="Tools that were called to answer the question",
    )
    trace: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Structured trace with per-layer timing and decisions",
    )
    context: Optional[str] = Field(
        default=None,
        description="Updated context to send back in next request",
    )
