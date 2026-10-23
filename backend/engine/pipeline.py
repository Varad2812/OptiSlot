"""End to end: MDB file → mapping → normalise → pre-flight → allocate → rows → KPIs."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from app.schemas import ColumnMapping, Kpis, OptimiserInfo, ProjectSettings, RuleSet, Signal, TQ, QuarantineRow, WhyStep
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
    optimiser: OptimiserInfo | None = None


def run(src: str | Path | bytes, ruleset: RuleSet | None = None, settings: ProjectSettings | None = None,
        overrides: dict[str, str | None] | None = None, filename: str | None = None, assign=None,
        table: RawTable | None = None, baseline=None, extra_tqs=None) -> RunOutput:
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
    for hook in extra_tqs or []:
        hook(signals, book)
    engine = Engine(signals, rules, settings, book, exceptions, baseline=baseline)
    report = None
    live = [s for s in signals if s.live and not s.quarantined]
    skip_large = len(live) > 5000
    if assign is None and settings.cpsat_enabled and not skip_large:
        from engine.optimise import OptReport, make_cpsat_assign
        n_dom = max(1, len({s.domain for s in live}))
        limit = settings.cpsat_time_limit_s if len(live) <= 3000 else max(0.15, min(settings.cpsat_time_limit_s, 0.6 / n_dom))
        report = OptReport()
        assign = make_cpsat_assign(limit, report=report)
    alloc = engine.run(assign)
    t3 = time.perf_counter()
    rows = render_rows(alloc.slots, signals, rules)
    optimiser = _optimiser_info(report, alloc, (t3 - t2) * 1e3)
    if settings.cpsat_enabled and skip_large and report is None:
        optimiser.status, optimiser.note = "skipped (large)", f"{len(live):,} signals — CP-SAT skipped to keep the run under 3 s; greedy + verifier"
    if report is not None and report.adopted_any:
        from verify.checks import verify_rows  # safety gate: the independent verifier must agree
        if verify_rows(rows, signals, rules.rs, settings, book.tqs).verdict != "PASS":
            out = run(src, ruleset, settings.model_copy(update={"cpsat_enabled": False}), overrides, filename, None, table,
                      baseline, extra_tqs)
            out.optimiser = OptimiserInfo(method="greedy", greedy_ciocs=out.kpis.ciocs, cpsat_ciocs=optimiser.cpsat_ciocs,
                                          adopted=False, status="rejected by verifier",
                                          note="CP-SAT result failed the independent verifier — greedy kept")
            return out
    _annotate(alloc, report)
    t4 = time.perf_counter()
    kpis = compute_kpis(signals, alloc.slots, alloc.cabinets, book.tqs, rules)
    t5 = time.perf_counter()
    timings = {"read_ms": (t1 - t0) * 1e3, "preflight_ms": (t2 - t1) * 1e3, "allocate_ms": (t3 - t2) * 1e3,
               "render_ms": (t4 - t3) * 1e3, "kpis_ms": (t5 - t4) * 1e3, "total_ms": (t5 - t0) * 1e3}
    return RunOutput(table=table, mapping=mapping, signals=signals, alloc=alloc, rows=rows, tqs=book.tqs,
                     quarantine=book.quarantine, kpis=kpis, rules=rules, settings=settings, timings=timings,
                     optimiser=optimiser)


def _optimiser_info(report, alloc: Allocation, ms: float) -> OptimiserInfo:
    used = sum(1 for c in alloc.cabinets for ci in c.ciocs if ci.used or ci.wired_spares)
    if report is None:
        return OptimiserInfo(method="greedy", greedy_ciocs=used, status="greedy only", time_ms=round(ms, 1),
                             note="Optimiser off — greedy next-fit")
    g = sum(d["greedy"]["ciocs"] for d in report.domains.values())
    c = sum((d["cpsat"] or d["greedy"])["ciocs"] for d in report.domains.values())
    gcab = sum(d["greedy"]["cabinets"] for d in report.domains.values())
    ccab = sum((d["cpsat"] or d["greedy"])["cabinets"] for d in report.domains.values())
    statuses = sorted({d["status"].split(" ")[0] for d in report.domains.values()})
    if report.adopted_any:
        bits = []
        if gcab > ccab:
            bits.append(f"{gcab - ccab} cabinet(s)")
        if g > c:
            bits.append(f"{g - c} CIOC(s)")
        gs = sum(d["greedy"]["group_spread"] for d in report.domains.values())
        cs = sum((d["cpsat"] or d["greedy"])["group_spread"] for d in report.domains.values())
        note = (f"CP-SAT adopted — saves {' and '.join(bits)} vs greedy" if bits else
                f"CP-SAT adopted — same CIOC count, IO groups tighter (group spread {gs} → {cs})" if cs < gs else
                "CP-SAT adopted — better sequence than greedy")
    else:
        note = "CP-SAT confirmed the greedy answer (no strictly better assignment)" if "OPTIMAL" in statuses or "FEASIBLE" in statuses \
            else "CP-SAT skipped — greedy kept"
    return OptimiserInfo(method="cpsat" if report.adopted_any else "greedy", greedy_ciocs=g, cpsat_ciocs=c,
                         adopted=report.adopted_any, status=", ".join(statuses), time_ms=round(ms, 1), note=note)


def _annotate(alloc: Allocation, report) -> None:
    if report is None:
        return
    for s in alloc.slots:
        if s.status != "Field":
            continue
        d = report.domains.get(s.domain)
        if not d:
            continue
        if d["adopted"]:
            g, c = d["greedy"], d["cpsat"]
            saved = g["ciocs"] - c["ciocs"]
            text = f"CIOC chosen by CP-SAT" + (f": saves {saved} CIOC(s) vs greedy in this domain" if saved > 0 else
                                               ": groups tighter than greedy in this domain")
        else:
            text = f"CIOC chosen by greedy next-fit; CP-SAT {d['status'].lower()} found nothing strictly better"
        s.why.append(WhyStep(rule_id=None, text=text))
