"""End to end: MDB file → mapping → normalise → pre-flight → allocate → rows → KPIs."""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from app.schemas import ColumnMapping, Kpis, OptimiserInfo, ProjectSettings, RuleSet, Signal, TQ, QuarantineRow, WhyStep
from engine.allocate import Allocation, Engine
from engine.failsafe import EngineFailure, quarantine_all, sys_tq
from engine.kpis import compute_kpis
from engine.normalise import normalise
from engine.preflight import preflight
from engine.rules import Rules, load_ruleset
from engine.tqs import TQBook
from xio.reader import RawTable, auto_map, mapping_dict, read_table, unmapped_mapping
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


class _CpsatRejected(Exception):
    """The CP-SAT result failed the independent verifier (or the verifier could not run): rerun with greedy."""

    def __init__(self, info: OptimiserInfo):
        super().__init__(info.note)
        self.info = info


def _empty_table(src, filename: str | None) -> RawTable:
    data = src if isinstance(src, bytes) else b""
    name = filename or (Path(src).name if isinstance(src, (str, Path)) else "upload")
    return RawTable(file=name, sheet="-", header_row=0, headers=[], rows=[], sha256=hashlib.sha256(data).hexdigest())


def run(src: str | Path | bytes, ruleset: RuleSet | None = None, settings: ProjectSettings | None = None,
        overrides: dict[str, str | None] | None = None, filename: str | None = None, assign=None,
        table: RawTable | None = None, baseline=None, extra_tqs=None) -> RunOutput:
    """Never raises on data: an unexpected error in any stage becomes a SYS-<stage> TQ and the best valid result is returned.

    Allocation failures are isolated per controller domain: the failing domain's signals are quarantined (with a TQ
    that names the error) and the other domains still allocate. CP-SAT errors fall back to greedy."""
    t0 = time.perf_counter()
    rules = Rules(ruleset or load_ruleset())
    settings = settings or ProjectSettings()
    early: list[Callable[[TQBook], object]] = []      # SYS notes replayed into every attempt's fresh TQ book
    if table is None:
        try:
            table = read_table(src, filename=filename)
        except Exception as e:
            table = _empty_table(src, filename)
            msg = f"The MDB could not be read: {e}. Nothing was allocated — upload a readable .xlsx or .csv."
            early.append(lambda b, e=e, msg=msg: sys_tq(b, "read", msg, exc=None if isinstance(e, ValueError) else e,
                                                          severity="critical"))
    t1 = time.perf_counter()
    try:
        mapping = auto_map(table.headers, overrides)
    except Exception as e:
        mapping = unmapped_mapping()
        early.append(lambda b, e=e: sys_tq(b, "map", "Column mapping failed — no column could be mapped automatically. Map the "
                                                     "columns on the Import page.", exc=e, severity="critical"))
    cpsat_ok = True
    excluded: dict[str, EngineFailure] = {}           # domain (or "*" = everything) → the failure that excluded it
    carried: list[Callable[[TQBook], object]] = []
    opt_note: tuple[tuple, int] | None = None         # (signature of the failure that disabled CP-SAT, index in carried)
    rejected: OptimiserInfo | None = None
    last: EngineFailure | None = None
    for _ in range(64):
        use_cpsat = cpsat_ok and settings.cpsat_enabled and assign is None
        try:
            out = _attempt(table, mapping, rules, settings, early, carried, excluded, use_cpsat, assign, baseline, extra_tqs)
            break
        except _CpsatRejected as r:
            cpsat_ok, rejected = False, r.info
        except EngineFailure as f:
            sig = (f.stage, f.domain, type(f.cause).__name__)
            if opt_note and sig == opt_note[0]:
                carried.pop(opt_note[1])      # the failure is not CP-SAT's: greedy fails the same way, so no optimise note
                opt_note = None
            last = f
            if use_cpsat:
                cpsat_ok = False
                opt_note = (sig, len(carried))
                carried.append(lambda b, f=f: sys_tq(b, "optimise", "The CP-SAT optimiser path raised an error — greedy "
                                                     "placement used instead (verified).", exc=f.cause, severity="medium"))
            elif f.domain is not None and f.domain not in excluded:
                excluded[f.domain] = f
            else:
                excluded["*"] = f
    else:  # pragma: no cover — 64 attempts exhausted: return the empty, fully-quarantined result
        out = _attempt(table, mapping, rules, settings, early, carried, {"*": last}, False, assign, None, extra_tqs)  # type: ignore[dict-item]
    if rejected is not None:
        out.optimiser = rejected.model_copy(update={"greedy_ciocs": out.kpis.ciocs})
    t5 = time.perf_counter()
    out.timings = {"read_ms": (t1 - t0) * 1e3, **out.timings, "total_ms": (t5 - t0) * 1e3}
    return out


def _prepare(table: RawTable, mapping: list[ColumnMapping], rules: Rules, settings: ProjectSettings, book: TQBook,
             extra_tqs) -> tuple[list[Signal], dict[str, str]]:
    """normalise + pre-flight, each guarded: a failure becomes a SYS TQ and the stage degrades instead of aborting."""
    try:
        signals = normalise(table, mapping_dict(mapping), rules, settings, book)
    except Exception as e:
        signals = []
        sys_tq(book, "normalise", "Normalising the MDB failed — no signal could be read.", exc=e, severity="critical")
    try:
        exceptions = preflight(signals, rules, settings, book)
    except Exception as e:
        exceptions = {}
        bad = [s for s in signals if s.live and not s.quarantined and s.kind == "field" and (not s.cable or not s.pair or not s.io_type)]
        t = sys_tq(book, "preflight", "Pre-flight checks failed part-way — signals without a usable cable, pair or IO type "
                   "were quarantined; the remaining checks were skipped.", exc=e, rows=[s.row for s in bad],
                   tags=[s.tag for s in bad], severity="high")
        for s in bad:
            book.quarantine_signal(s, "SYS-preflight: unusable cable/pair/IO type", t)
    for hook in extra_tqs or []:
        try:
            hook(signals, book)
        except Exception as e:
            sys_tq(book, "preflight", "A revision pre-flight hook failed.", exc=e, severity="medium")
    return signals, exceptions


def _attempt(table: RawTable, mapping: list[ColumnMapping], rules: Rules, settings: ProjectSettings, early, carried,
             excluded: dict[str, EngineFailure], use_cpsat: bool, assign, baseline, extra_tqs) -> RunOutput:
    t1 = time.perf_counter()
    book = TQBook()
    for note in [*early, *carried]:
        note(book)
    missing = [m.label for m in mapping if m.required and not m.source]
    if missing:
        book.add("project", "Required column missing", "critical",
                 f"Required column(s) not found: {', '.join(missing)}. Map them on the Import page — rows without them cannot be allocated.",
                 fixes=[{"label": "Map the column on the Import page"}], unchanged="Nothing allocated from the affected rows.")
    signals, exceptions = _prepare(table, mapping, rules, settings, book, extra_tqs)
    for key, f in excluded.items():
        quarantine_all(book, signals, None if key == "*" else key, f.stage, f.cause, f"Allocation ({f.stage})")
    t2 = time.perf_counter()
    report = None
    live = [s for s in signals if s.live and not s.quarantined]
    skip_large = len(live) > 5000
    if use_cpsat and not skip_large:
        from engine.optimise import OptReport, make_cpsat_assign
        n_dom = max(1, len({s.domain for s in live}))
        limit = settings.cpsat_time_limit_s if len(live) <= 3000 else max(0.15, min(settings.cpsat_time_limit_s, 0.6 / n_dom))
        report = OptReport()
        assign = make_cpsat_assign(limit, report=report)
    if not live and not baseline:  # nothing to place (a revision with a baseline still re-creates its cabinets)
        alloc = Allocation(cabinets=[], slots=[], blocks=[], cabs=[], unplaced=[])
    else:
        alloc = Engine(signals, rules, settings, book, exceptions, baseline=baseline).run(assign)
    t3 = time.perf_counter()
    if report is not None:
        for domain, msg in report.errors:
            sys_tq(book, "optimise", f"CP-SAT failed for controller domain {domain} — the greedy placement was kept ({msg}).",
                   severity="low", unchanged="Placement is the (verified) greedy one.")
    render_errors: list = []
    rows = render_rows(alloc.slots, signals, rules, render_errors)
    if render_errors:
        sys_tq(book, "render", f"{len(render_errors)} slot(s) could not be rendered with the full column map and were written "
               f"with core columns only.", exc=render_errors[0][1], rows=[sl.source_row for sl, _ in render_errors if sl.source_row],
               tags=[sl.tag for sl, _ in render_errors if sl.tag and sl.status != "Spare Slot"], severity="medium")
    optimiser = _optimiser_info(report, alloc, (t3 - t2) * 1e3, rules.cioc_strategy, settings.cpsat_time_limit_s)
    if settings.cpsat_enabled and skip_large and report is None and use_cpsat:
        optimiser.status, optimiser.note = "skipped (large)", f"{len(live):,} signals — CP-SAT skipped to keep the run under 3 s; greedy + verifier"
    if report is not None and report.adopted_any:
        from verify.checks import verify_rows  # safety gate: the independent verifier must agree
        try:
            verdict = verify_rows(rows, signals, rules.rs, settings, book.tqs).verdict
            why = "CP-SAT result failed the independent verifier — greedy kept"
        except Exception as e:
            verdict, why = "ERROR", f"the verifier could not check the CP-SAT result ({type(e).__name__}) — greedy kept"
        if verdict != "PASS":
            raise _CpsatRejected(OptimiserInfo(method="greedy", greedy_ciocs=optimiser.greedy_ciocs, cpsat_ciocs=optimiser.cpsat_ciocs,
                                               adopted=False, status="rejected by verifier", note=why))
    _annotate(alloc, report)
    t4 = time.perf_counter()
    try:
        kpis = compute_kpis(signals, alloc.slots, alloc.cabinets, book.tqs, rules)
    except Exception as e:
        sys_tq(book, "render", "The scoreboard numbers could not be computed.", exc=e, severity="medium")
        kpis = Kpis(signals=len(live), allocated=0, allocated_pct=0.0, unallocated_with_tq=0, tqs_open=len(book.tqs), violations=0,
                    cabinets=0, ciocs=0, baseplates_used=0, fill_pct=0.0, wired_spares=0, wired_target=0, status_counts={},
                    tq_by_category={}, spare_compliance=[], spares_per_cabinet=[])
    t5 = time.perf_counter()
    timings = {"preflight_ms": (t2 - t1) * 1e3, "allocate_ms": (t3 - t2) * 1e3,
               "render_ms": (t4 - t3) * 1e3, "kpis_ms": (t5 - t4) * 1e3}
    return RunOutput(table=table, mapping=mapping, signals=signals, alloc=alloc, rows=rows, tqs=book.tqs,
                     quarantine=book.quarantine, kpis=kpis, rules=rules, settings=settings, timings=timings,
                     optimiser=optimiser)


def _optimiser_info(report, alloc: Allocation, ms: float, strategy: str = "compact", limit_s: float = 2.0) -> OptimiserInfo:
    used = sum(1 for c in alloc.cabinets for ci in c.ciocs if ci.used or ci.wired_spares)
    if report is None:
        return OptimiserInfo(method="greedy", greedy_ciocs=used, status="greedy only", time_ms=round(ms, 1),
                             note="Optimiser off — " + ("greedy balanced spread" if strategy == "balanced" else "greedy next-fit"))
    g = sum(d["greedy"]["ciocs"] for d in report.domains.values())
    c = sum((d["cpsat"] or d["greedy"])["ciocs"] for d in report.domains.values())
    gcab = sum(d["greedy"]["cabinets"] for d in report.domains.values())
    ccab = sum((d["cpsat"] or d["greedy"])["cabinets"] for d in report.domains.values())
    statuses = sorted({d["status"].split(" ")[0] for d in report.domains.values()})
    if report.adopted_any and strategy == "balanced":
        gf = max((d["greedy"]["max_fill"] for d in report.domains.values()), default=0)
        cf = max(((d["cpsat"] or d["greedy"])["max_fill"] for d in report.domains.values()), default=0)
        gg = sum(d["greedy"]["group_scope_spread"] for d in report.domains.values())
        cg = sum((d["cpsat"] or d["greedy"])["group_scope_spread"] for d in report.domains.values())
        note = (f"CP-SAT adopted (balanced) — IO groups tighter (spread {gg} → {cg})" if cg < gg else
                f"CP-SAT adopted (balanced) — max CIOC fill {gf / 10:g}% → {cf / 10:g}%" if cf < gf else
                "CP-SAT adopted (balanced) — fewer moves / better sequence than the greedy spread")
    elif report.adopted_any:
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
    elif report.errors:
        note = f"CP-SAT error in {len(report.errors)} domain(s) — greedy kept (see the SYS-optimise TQ)"
    elif any(d["status"].startswith("UNKNOWN") for d in report.domains.values()):
        note = f"CP-SAT timed out ({limit_s:g} s per domain) — greedy kept"
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
        if d["adopted"] and _balanced(d):
            text = (f"CIOC chosen by CP-SAT (balanced): max CIOC fill in this domain "
                    f"{d['greedy']['max_fill'] / 10:g}% → {d['cpsat']['max_fill'] / 10:g}%")
        elif d["adopted"]:
            g, c = d["greedy"], d["cpsat"]
            saved = g["ciocs"] - c["ciocs"]
            text = f"CIOC chosen by CP-SAT" + (f": saves {saved} CIOC(s) vs greedy in this domain" if saved > 0 else
                                               ": groups tighter than greedy in this domain")
        else:
            text = (f"CIOC chosen by {'the greedy balanced spread' if _balanced(d) else 'greedy next-fit'}; "
                    f"CP-SAT {d['status'].lower()} found nothing strictly better")
        s.why.append(WhyStep(rule_id=None, text=text))


def _balanced(d: dict) -> bool:
    return d["greedy"].get("strategy") == "balanced"
