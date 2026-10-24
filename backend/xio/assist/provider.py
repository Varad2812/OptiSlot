"""LLM providers for the rule assistant (Gemini over REST, optionally Anthropic). Fail-safe and optional.

Privacy: a provider only ever receives the system instructions we build and the user's own sentence/question plus
catalogue facts — never signal rows or project data. Keys come from the environment, are sent in a header (never in a
URL), and are never logged, stored or returned. Every failure becomes `ProviderError`; callers fall back.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

import httpx

# httpx/httpcore log request URLs at INFO; keep them quiet so nothing request-shaped reaches a log handler.
for _n in ("httpx", "httpcore"):
    logging.getLogger(_n).setLevel(logging.WARNING)

TIMEOUT_S = 8.0
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"   # 2.0/2.5-flash answer 404 for current keys; 3.8-flash exceeds the 8 s budget
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5"


class ProviderError(Exception):
    """Network, HTTP, timeout or malformed-reply trouble. The message never contains the key or the prompt."""


@dataclass
class Provider:
    name: str                                    # gemini | anthropic | none
    model: str = ""

    def complete(self, system: str, user: str, *, json_mode: bool = True) -> str:        # pragma: no cover - overridden
        raise ProviderError("no provider configured")


class NoProvider(Provider):
    def __init__(self) -> None:
        super().__init__("none", "")


class GeminiProvider(Provider):
    def __init__(self, key: str, model: str) -> None:
        super().__init__("gemini", model)
        self._key = key

    def complete(self, system: str, user: str, *, json_mode: bool = True) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        gen = {"temperature": 0, "maxOutputTokens": 1024}
        if json_mode:
            gen["responseMimeType"] = "application/json"
        body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": gen}
        try:
            r = httpx.post(url, json=body, headers={"x-goog-api-key": self._key}, timeout=TIMEOUT_S)
        except httpx.HTTPError as e:
            raise ProviderError(f"gemini unreachable ({type(e).__name__})") from None
        if r.status_code != 200:
            raise ProviderError(f"gemini answered HTTP {r.status_code}")
        try:
            return r.json()["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError, ValueError):
            raise ProviderError("gemini reply had no text") from None


class AnthropicProvider(Provider):
    def __init__(self, key: str, model: str) -> None:
        super().__init__("anthropic", model)
        self._key = key

    def complete(self, system: str, user: str, *, json_mode: bool = True) -> str:
        body = {"model": self.model, "max_tokens": 1024, "temperature": 0, "system": system,
                "messages": [{"role": "user", "content": user}]}
        try:
            r = httpx.post("https://api.anthropic.com/v1/messages", json=body, timeout=TIMEOUT_S,
                           headers={"x-api-key": self._key, "anthropic-version": "2023-06-01"})
        except httpx.HTTPError as e:
            raise ProviderError(f"anthropic unreachable ({type(e).__name__})") from None
        if r.status_code != 200:
            raise ProviderError(f"anthropic answered HTTP {r.status_code}")
        try:
            return r.json()["content"][0]["text"]
        except (KeyError, IndexError, TypeError, ValueError):
            raise ProviderError("anthropic reply had no text") from None


def get_provider() -> Provider:
    """Gemini first, then Anthropic, else none. Read from the environment on every call (no caching of secrets)."""
    g = os.environ.get("GEMINI_API_KEY", "").strip()
    if g:
        return GeminiProvider(g, os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_GEMINI_MODEL)
    a = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if a:
        return AnthropicProvider(a, os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL)
    return NoProvider()


def list_gemini_models() -> list[str]:
    """Models the configured key can call generateContent on (for the smoke-test diagnosis). Never prints the key."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return []
    try:
        r = httpx.get("https://generativelanguage.googleapis.com/v1beta/models", headers={"x-goog-api-key": key},
                      params={"pageSize": 100}, timeout=TIMEOUT_S)
        r.raise_for_status()
        return sorted(m["name"].removeprefix("models/") for m in r.json().get("models", [])
                      if "generateContent" in m.get("supportedGenerationMethods", []))
    except Exception:  # noqa: BLE001
        return []


def parse_json_strict(text: str) -> object:
    """The model must answer with JSON only. A ```json fence is tolerated; anything else is rejected."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rsplit("```", 1)[0].strip()
    try:
        return json.loads(t)
    except ValueError:
        raise ProviderError("reply was not valid JSON") from None
