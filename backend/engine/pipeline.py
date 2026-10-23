"""End to end: MDB file → mapping → normalise → pre-flight → allocate → rows → KPIs."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from app.schemas import ColumnMapping, Kpis, ProjectSettings, RuleSet, Signal, TQ, QuarantineRow
from engine.allocate import Allocation, Engine
from engine.kpis import compute_kpis
from engine.normalise import normalise
from engine.preflight import preflight
from engine.rules import Rules, load_ruleset
from engine.tqs import TQBook
from xio.reader import RawTable, auto_map, mapping_dict, read_table
from xio.render import render_rows


@dataclass
class RunOutput:
    table: RawTable
    mapping: list[ColumnMapping]
    signals: list[Signal]
    alloc: Allocation
    rows: list[dict[str, str]]
    tqs: list[TQ]
    quarantine: list[QuarantineRow]
    kpis: Kpis
    rules: Rules
    settings: ProjectSettings
    timings: dict[str, float] = field(default_factory=dict)


def run(src: str | Path | bytes, ruleset: RuleSet | None = None, settings: ProjectSettings | None = None,
        overrides: dict[str, str | None] | None = None, filename: str | None = None, assign=None,
        table: RawTable | None = None) -> RunOutput:
    t0 = time.perf_counter()
    rules = Rules(ruleset or load_ruleset())
    settings = settings or ProjectSettings()
    table = table or read_table(src, filename=filename)
    t1 = time.perf_counter()
    mapping = auto_map(table.headers, overrides)
    book = TQBook()
    missing = [m.label for m in mapping if m.required and not m.source]
    if missing:
        book.add("project", "Required column missing", "critical",
                 f"Required column(s) not found: {', '.join(missing)}. Map them on the Import page — rows without them cannot be allocated.",
                 fixes=[{"label": "Map the column on the Import page"}], unchanged="Nothing allocated from the affected rows.")
    signals = normalise(table, mapping_dict(mapping), rules, settings, book)
    exceptions = preflight(signals, rules, settings, book)
    t2 = time.perf_counter()
    engine = Engine(signals, rules, settings, book, exceptions)
    alloc = engine.run(assign)
    t3 = time.perf_counter()
    rows = render_rows(alloc.slots, signals, rules)
    t4 = time.perf_counter()
    kpis = compute_kpis(signals, alloc.slots, alloc.cabinets, book.tqs, rules)
    t5 = time.perf_counter()
    timings = {"read_ms": (t1 - t0) * 1e3, "preflight_ms": (t2 - t1) * 1e3, "allocate_ms": (t3 - t2) * 1e3,
               "render_ms": (t4 - t3) * 1e3, "kpis_ms": (t5 - t4) * 1e3, "total_ms": (t5 - t0) * 1e3}
    return RunOutput(table=table, mapping=mapping, signals=signals, alloc=alloc, rows=rows, tqs=book.tqs,
                     quarantine=book.quarantine, kpis=kpis, rules=rules, settings=settings, timings=timings)
