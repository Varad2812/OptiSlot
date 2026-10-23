"""TQ factory: every technical query has the same shape (CLAUDE.md §4 TQ object)."""
from __future__ import annotations

from collections import defaultdict

from app.schemas import TQ, FixOption, QuarantineRow, Signal

PREFIX = {
    "data": "DATA", "io": "IO", "hardware": "HW", "segregation": "SEG", "capacity": "CAP",
    "project": "PROJ", "spare": "SPR", "revision": "REV", "cable": "CBL", "sys": "SYS", "custom": "CUS",
}


class TQBook:
    def __init__(self) -> None:
        self.tqs: list[TQ] = []
        self.quarantine: list[QuarantineRow] = []
        self._n: dict[str, int] = defaultdict(int)
        self._keys: dict[str, TQ] = {}

    def add(self, kind: str, category: str, severity: str, message: str, *, rows=(), tags=(), field=None,
            rules=(), fixes=(), unchanged="Everything else unchanged.", confidence="confirmed", key: str | None = None) -> TQ:
        """Add a TQ; `key` de-duplicates (the same key returns the existing TQ, extended with rows/tags)."""
        if key and key in self._keys:
            t = self._keys[key]
            t.rows = sorted(set(t.rows) | set(rows))
            t.tags = list(dict.fromkeys([*t.tags, *tags]))
            return t
        p = PREFIX.get(kind, kind.upper())
        self._n[p] += 1
        t = TQ(id=f"TQ-{p}-{self._n[p]:03d}", category=category, severity=severity, message=message,
               rows=sorted(set(rows)), tags=list(dict.fromkeys(tags)), field=field, rules_in_conflict=list(rules),
               fix_options=[f if isinstance(f, FixOption) else FixOption(**f) for f in fixes],
               unchanged_note=unchanged, confidence=confidence)
        self.tqs.append(t)
        if key:
            self._keys[key] = t
        return t

    def quarantine_signal(self, s: Signal, reason: str, tq: TQ | None, values: dict[str, str] | None = None) -> None:
        s.quarantined = True
        s.quarantine_reason = reason
        self.quarantine.append(QuarantineRow(row=s.row, tag=s.tag or "-", reason=reason, tq_id=tq.id if tq else None,
                                             values=values or {}))
