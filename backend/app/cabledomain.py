"""Which controller domain and naming namespace does a cable belong to?

ONE definition, used by both the engine (pre-flight keeps a cable together) and the verifier (C10 re-derives the
cabinet a signal must be in), so the two can never disagree. Pure functions over normalised MDB rows and the rule
set's `derive` spec; it imports nothing from the engine or the verifier.

A cable lands together, so every row of a cable shares ONE home. A row "resolves" when its room AND design area both
derive a location prefix and an area code; the cable's home is the most common domain among its resolved rows (ties →
the earliest MDB row). A row that does not resolve (blank or unmatched area, say) inherits the cable's home. If no row
of the cable resolves, the earliest row's own domain and project defaults are used.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable

from app.ruleslang import derive
from app.schemas import ProjectSettings, Signal


@dataclass(frozen=True)
class RowHome:
    domain: str
    loc: str
    area_code: str
    area4: str
    resolved: bool          # room and area both derived (no project default was needed)


@dataclass(frozen=True)
class CableHome:
    domain: str
    loc: str
    area_code: str
    area4: str
    domains: tuple[str, ...]        # distinct row domains, in MDB order
    inherited: tuple[int, ...]      # MDB rows whose own room/area did not resolve — they take this home
    conflicting: tuple[int, ...]    # MDB rows that resolved to a DIFFERENT domain — they are pulled into this home


def lands_on_cable(s: Signal) -> bool:
    """True when a row occupies a pair of a physical cable. A cabinet alarm with no cable size or pair (internal wiring,
    or an equipment-matched alarm that carries a cable label) lands in its own cabinet's alarm baseplate and is not
    part of any cable block, so it takes no part in 'a cable lands together'."""
    return s.kind == "field" or bool(s.cable and s.cable_size and s.pair)


def domain_of(s: Signal, settings: ProjectSettings) -> str:
    """The controller-domain key of one row (the project's `domain_keys` columns joined). Case and spacing are not part of
    the key: 'pib-24' and 'PIB-24 ' are the same room, not two controller domains."""
    vals = (getattr(s, k, "") if hasattr(s, k) else s.extra.get(k, "") for k in settings.domain_keys)
    return "|".join(" ".join(str(v or "").split()).upper() for v in vals) or "ALL"


def row_home(s: Signal, derive_spec: dict, settings: ProjectSettings) -> RowHome:
    """A row's own location prefix and area code, from its raw room / design area (project defaults when underivable)."""
    loc = derive(derive_spec.get("loc"), s.room)
    area = derive(derive_spec.get("area"), s.area)
    code = area or settings.area_code_default
    return RowHome(domain=domain_of(s, settings), loc=loc or settings.loc_prefix_default, area_code=code,
                   area4=derive(derive_spec.get("area4"), code) or code[:4], resolved=bool(loc and area))


def cable_homes(signals: Iterable[Signal], derive_spec: dict, settings: ProjectSettings) -> dict[str, CableHome]:
    """cable number → its home, for every live row that names a cable. Quarantine status is ignored on purpose: a row
    with a bad pair still tells us where its cable lives, and the answer must not depend on later placement."""
    by_cable: dict[str, list[tuple[Signal, RowHome]]] = defaultdict(list)
    for s in sorted(signals, key=lambda x: x.row):
        if s.live and s.cable and lands_on_cable(s):
            by_cable[s.cable].append((s, row_home(s, derive_spec, settings)))
    out: dict[str, CableHome] = {}
    for cable, rows in by_cable.items():
        resolved = [h for _, h in rows if h.resolved]
        votes = Counter(h.domain for h in resolved)
        if votes:
            top = max(votes.values())
            win = next(h for h in resolved if votes[h.domain] == top)     # earliest row among the leading domains
        else:
            win = rows[0][1]
        out[cable] = CableHome(
            domain=win.domain, loc=win.loc, area_code=win.area_code, area4=win.area4,
            domains=tuple(dict.fromkeys(h.domain for _, h in rows)),
            inherited=tuple(s.row for s, h in rows if not h.resolved and h.domain != win.domain),
            conflicting=tuple(s.row for s, h in rows if h.resolved and h.domain != win.domain))
    return out
