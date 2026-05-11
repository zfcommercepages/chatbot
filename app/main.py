"""
Zoho Commerce storefront chatbot — FastAPI proxy + in-repo widget static files.

- GET /health, POST /api/chat — Anthropic (API key from env only).
- GET /widget/widget.css, GET /widget/widget.js — from repo `static/` (edit there; Zoho loads from your deployed host).

Do not use PEP 563 (`from __future__ import annotations`) in this module: with the slowapi
`@limiter.limit` wrapper, FastAPI would treat the chat JSON body as a missing query parameter (422).
"""

import json
import os
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
WIDGET_SECRET = os.environ.get("WIDGET_SECRET", "")
ALLOWED_ORIGINS = [
    x.strip()
    for x in (os.environ.get("ALLOWED_ORIGINS", "") or "").split(",")
    if x.strip()
]
RATE_LIMIT = os.environ.get("RATE_LIMIT_PER_MIN", "30")

MAX_MESSAGES = 24
MAX_MESSAGE_CHARS = 12000
MAX_CONTEXT_CHARS = 32000

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="Storefront chatbot", version="1.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Widget-Secret"],
        max_age=600,
    )

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    messages: list[ChatMessage] = Field(default_factory=list)
    context: dict[str, Any] | None = None


def build_system_prompt(ctx: dict[str, Any]) -> str:
    store_name = str(ctx.get("storeName") or "the store")[:200]
    store_base = str(ctx.get("storeBase") or "")[:500]
    verticals = str(ctx.get("verticals") or "general retail")[:2000]
    policies = str(
        ctx.get("policies") or "Use the store website for official policies."
    )[:8000]
    products = str(ctx.get("productsContext") or "None yet.")[:MAX_CONTEXT_CHARS]

    return (
        f"You are a friendly shopping assistant for {store_name} ({store_base}). "
        f"The store sells: {verticals}. "
        "Help with product fit, materials, electronics specs when plausible from context, "
        "furniture dimensions or assembly when mentioned, home decor styling, pricing, shipping, returns, and coupons. "
        "If product details are unknown, stay within safe general retail guidance and suggest checking the product page. "
        "2–3 sentences max. Plain text only, no markdown.\n\n"
        "Store policies (may be edited by the merchant; if something conflicts with the product page, defer to the site):\n"
        f"{policies}\n\n"
        'When the customer wants to browse inside the chat widget, they can use phrases like '
        '"list all categories", "list all collections", or "browse all products" for structured lists and tiles.\n\n'
        "Products recently shown in the chat (name, price, options, short blurb):\n"
        f"{products}"
    )


def sanitize_messages(raw: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for m in raw[-MAX_MESSAGES:]:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if not isinstance(content, str):
            content = ""
        if len(content) > MAX_MESSAGE_CHARS:
            content = content[:MAX_MESSAGE_CHARS]
        out.append({"role": role, "content": content})
    return out


def context_to_dict(ctx: dict[str, Any] | None) -> dict[str, Any]:
    if ctx is None:
        return {}
    return ctx


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/chat")
@limiter.limit(f"{RATE_LIMIT}/minute")
async def chat(request: Request, body: ChatRequest) -> JSONResponse:
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=500, detail="Server misconfiguration: missing ANTHROPIC_API_KEY"
        )

    if WIDGET_SECRET:
        if request.headers.get("x-widget-secret") != WIDGET_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")

    raw_msgs = [m.model_dump() for m in body.messages]
    messages = sanitize_messages(raw_msgs)
    if not messages:
        raise HTTPException(
            status_code=400,
            detail="messages must be a non-empty array of {role, content}",
        )
    if messages[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="last message must be from user")

    system = build_system_prompt(context_to_dict(body.context))

    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 400,
        "system": system,
        "messages": messages,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                json=payload,
            )
    except httpx.RequestError as e:
        return JSONResponse(
            status_code=502,
            content={"error": "Upstream AI unreachable", "detail": str(e)},
        )

    if r.status_code < 200 or r.status_code >= 300:
        snippet = (r.text or "")[:500]
        return JSONResponse(
            status_code=502,
            content={
                "error": "Upstream AI error",
                "status": r.status_code,
                "snippet": snippet,
            },
        )

    try:
        data = r.json()
    except json.JSONDecodeError:
        return JSONResponse(status_code=502, content={"error": "Invalid upstream response"})

    blocks = data.get("content")
    reply = (
        blocks[0].get("text")
        if isinstance(blocks, list) and blocks and isinstance(blocks[0], dict)
        else None
    ) or "I'm not sure — try browsing the store!"
    return JSONResponse(content={"reply": reply})


_REPO_ROOT = Path(__file__).resolve().parent.parent
_STATIC = _REPO_ROOT / "static"
if _STATIC.is_dir():
    app.mount("/widget", StaticFiles(directory=str(_STATIC)), name="widget")
