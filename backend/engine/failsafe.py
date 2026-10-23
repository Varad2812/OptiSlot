"""Fail-safe layer: an unexpected error in a pipeline stage becomes a SYS-<stage> TQ and the run goes on.

Stages: read, map, normalise, preflight, allocate, optimise, layout, render, verify, write.
"""
from __future__ import annotations

import traceback

from app.schemas import Signal
from engine.tqs import TQBook

STAGES = ("read", "map", "normalise", "preflight", "allocate", "optimise", "layout", "render", "verify", "write")


class EngineFailure(Exception):
    """An unexpected error inside Engine.run, tagged with the stage and controller domain it happened in."""

    def __init__(self, stage: str, domain: str | None, cause: BaseException):
        super().__init__(f"{stage}: {describe(cause)}")
        self.stage, self.domain, self.cause = stage, domain, cause


def describe(e: BaseException, limit: int = 240) -> str:
    """'KeyError: 3 (at engine/allocate.py:812)' — the exception and the innermost frame that raised it."""
    where = ""
    tb = traceback.extract_tb(e.__traceback__)
    if tb:
        f = tb[-1]
        parts = f.filename.replace("\\", "/").split("/")
        where = f" (at {'/'.join(parts[-2:])}:{f.lineno})"
    msg = f"{type(e).__name__}: {e}"
    return (msg if len(msg) <= limit else msg[:limit] + "…") + where


def sys_tq(book: TQBook, stage: str, message: str, *, exc: BaseException | None = None, rows=(), tags=(),
           severity: str = "medium", unchanged: str = "Everything else unchanged.", fixes=()):
    """One TQ per (stage, exception type): repeated failures in the same stage extend the same TQ's rows/tags."""
    text = f"{message} [{describe(exc)}]" if exc is not None else message
    key = f"sys:{stage}:{type(exc).__name__ if exc is not None else message[:60]}"
    return book.add("sys", f"SYS-{stage}", severity, text, rows=rows, tags=tags, field=stage,
                    fixes=list(fixes) or [{"label": "Send this dataset and the message above to the OptiSlot team"}],
                    unchanged=unchanged, key=key)


def quarantine_all(book: TQBook, signals: list[Signal], domain: str | None, stage: str, exc: BaseException | None,
                   what: str) -> int:
    """Quarantine every live, unquarantined signal of a controller domain (or all of them when domain is None)."""
    hit = [s for s in signals if s.live and not s.quarantined and (domain is None or s.domain == domain)]
    if not hit:
        return 0
    where = "the whole project" if domain is None else f"controller domain {domain}"
    t = sys_tq(book, stage, f"{what} failed unexpectedly for {where} — {len(hit)} signal(s) quarantined so the rest still "
               f"allocates.", exc=exc, rows=[s.row for s in hit], tags=[s.tag for s in hit], severity="critical",
               unchanged="Other controller domains are allocated and verified as normal.")
    for s in hit:
        book.quarantine_signal(s, f"SYS-{stage}: {what} failed", t)
    return len(hit)
