"""Project service: inputs live in the store; outputs are recomputed (deterministic → same hashes after a restart)."""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import json
import re
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.schemas import (
    ActivityEvent, AllocationResult, Certificate, ColumnMapping, DecisionEntry, ExportFile, ImportSummary, Kpis,
    OptimiserInfo, Project, ProjectSettings, RevisionImpact, RuleCheckReport, RuleSet, RunRecord, TQ, CheckResult,
    Violation,
)
from engine.pipeline import RunOutput, run
from engine.rules import load_ruleset
from store.db import Store
from verify.certificate import certify, ruleset_hash
from verify.checks import verify_rows
from verify.xlsx import read_bom, verify_xlsx
from xio.patches import apply_patches, patches_hash
from xio.reader import SOURCE_COL, RawTable, auto_map, merge_tables, read_table
from xio.reports import capacity_bom, revision_impact, rule_check_report, tq_register
from xio.writer import write_allocation_safe, write_table
from engine.failsafe import sys_tq
from engine.tqs import TQBook

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def rev_no(letter: str, base: str = "00") -> str:
    """Revision number written to the sheet: the project's revision number (`settings.revision`, Rev A) plus the letter's
    position — "00" → B is "01", C is "02"; "R05" → B is "R06". A non-numeric base falls back to the position."""
    n = LETTERS.index(letter)
    m = re.fullmatch(r"(\D*)(\d+)", str(base).strip())
    if not m:
        return f"{n:02d}"
    return f"{m.group(1)}{int(m.group(2)) + n:0{len(m.group(2))}d}"


ROOT = Path(__file__).resolve().parents[2]
DEMO_MDB = ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx"
DEMO_ID = "demo"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def tq_signature(t: TQ) -> str:
    return hashlib.sha1(json.dumps([t.category, sorted(t.rows), sorted(t.tags), t.field], sort_keys=True).encode()).hexdigest()[:16]


@dataclass
class Computed:
    out: RunOutput
    report: RuleCheckReport
    cert: Certificate
    xlsx: bytes
    optimiser: OptimiserInfo
    runtime_ms: float
    tqs: list[TQ]
    kpis: Kpis
    impact: RevisionImpact | None = None


@dataclass
class ProjectState:
    project: Project
    ruleset: RuleSet
    settings: ProjectSettings
    overrides: dict[str, str | None]
    mdb: bytes
    mdb_name: str
    current: Computed | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)


class Service:
    def __init__(self, store: Store):
        self.store = store
        self.states: dict[str, ProjectState] = {}
        self._lock = threading.RLock()
        self._tl = threading.local()

    # ───────────── lifecycle ─────────────
    def ensure_demo(self) -> None:
        if self.store.get_project(DEMO_ID) is None:
            self.create_project(DEMO_ID, "Demo — VIT Sample", DEMO_MDB.read_bytes(), DEMO_MDB.name)

    def create_project(self, pid: str, name: str, mdb: bytes, filename: str) -> Project:
        ts = now()
        p = Project(id=pid, name=name, mdb_file=filename, created=ts, updated=ts)
        self.store.put_project(pid, p.model_dump())
        self.store.put_file(pid, "mdb_a", "mdb", hashlib.sha256(mdb).hexdigest(), mdb, ts)
        self.store.put(pid, "mdb_name", filename)
        rs = load_ruleset("default")
        self.store.put_ruleset(pid, 1, rs.model_dump(), ts, "default rule set")
        self.store.put(pid, "settings", ProjectSettings().model_dump())
        self.store.put(pid, "overrides", {})
        self.activity(pid, "import", f"Created project '{name}' from {filename}")
        return p

    def get(self, pid: str) -> ProjectState:
        with self._lock:
            st = self.states.get(pid)
            if st is None:
                pdata = self.store.get_project(pid)
                if pdata is None:
                    raise KeyError(pid)
                rs = RuleSet.model_validate(self.store.get_ruleset(pid))
                project = Project.model_validate(pdata)
                project.ruleset_version = self.store.latest_ruleset_version(pid)
                st = ProjectState(project=project, ruleset=rs,
                                  settings=ProjectSettings.model_validate(self.store.get(pid, "settings", {})),
                                  overrides=self.store.get(pid, "overrides", {}) or {},
                                  mdb=self.store.get_file(pid, "mdb_a") or b"", mdb_name=self.store.get(pid, "mdb_name", "mdb.xlsx"))
                self.states[pid] = st
        if st.current is None:
            with st.lock:
                if st.current is None:
                    rev = self.store.get(pid, "revision")
                    if rev and rev != "A" and rev in self.revs(st):
                        from app.revisions import activate
                        activate(self, st, rev, record=False)
                    else:
                        self.recompute(st, record=False)
        return st

    # ───────────── inputs ─────────────
    def table(self, st: ProjectState, which: str = "active") -> RawTable | None:
        """The MDB of Rev A ("a"), Rev B ("b") or the active revision, with the project's data patches applied. None when
        the file cannot be read — callers pass that on, and `run` turns the read error into a SYS-read TQ."""
        revs = self.revs(st)
        if which == "active":
            which = st.project.revision.lower() if st.project.revision in revs else "a"
        letter = which.upper()
        data, name = (revs[letter]["data"], revs[letter]["name"]) if letter in revs else (st.mdb, st.mdb_name)
        if not data:
            return None
        cache = st.extra.setdefault("_raw_tables", {})
        key = (which, hashlib.sha256(data).hexdigest())
        raw = cache.get(key)
        if raw is None:
            try:
                raw = cache[key] = read_table(data, filename=name)
            except Exception:
                return None
        return apply_patches(raw, self.store.get(st.project.id, "data_patches", {}) or {}, st.overrides or None)

    def revs(self, st: ProjectState) -> dict[str, dict]:
        """Revisions after A in chain order: {letter: {"data": bytes, "name": str}} (loaded from the store once)."""
        revs = st.extra.get("revs")
        if revs is None:
            pid = st.project.id
            letters = self.store.get(pid, "rev_letters")
            if letters is None:      # a project stored before revision chains: at most a single Rev B
                letters = ["B"] if self.store.get_file(pid, "mdb_b") else []
            revs = {}
            for letter in sorted(letters, key=LETTERS.index):
                data = self.store.get_file(pid, f"mdb_{letter.lower()}")
                if data:
                    revs[letter] = {"data": data, "name": self.store.get(pid, f"mdb_{letter.lower()}_name", f"Rev{letter}.xlsx")}
            st.extra["revs"] = revs
        return revs

    # ───────────── TQ pins: what stayed in place when a TQ was applied ─────────────
    def tq_pins(self, st: ProjectState, letter: str | None = None) -> dict[str, list]:
        """{cable: [ns, cabinet seq, cioc local, bp, ch, size]} of the revision `letter` (default: the active one)."""
        return (self.store.get(st.project.id, "tq_pins", {}) or {}).get(letter or st.project.revision, {})

    def set_tq_pins(self, st: ProjectState, pins: dict[str, list], letter: str | None = None) -> None:
        letter = letter or st.project.revision
        allp = self.store.get(st.project.id, "tq_pins", {}) or {}
        allp = {**allp, letter: pins}
        self.store.put(st.project.id, "tq_pins", {k: v for k, v in allp.items() if v})
        st.extra.pop("chain_cache", None)

    def pins_hash(self, st: ProjectState) -> str:
        return hashlib.sha256(json.dumps(self.store.get(st.project.id, "tq_pins", {}) or {}, sort_keys=True).encode()).hexdigest()[:12]

    def apply_tq_pins(self, st: ProjectState, out: RunOutput, letter: str, rs: RuleSet | None = None,
                      settings: ProjectSettings | None = None) -> RunOutput:
        """Rev A style replay of the TQ pins: re-run with `out`'s layout frozen except the pinned cables. Silent — no Change Type,
        no remark: to the sheet it is an ordinary allocation (the pins only decide where cables sit)."""
        pins = self.tq_pins(st, letter)
        if not pins:
            return out
        from engine.revise import rerun_pinned
        pinned = rerun_pinned(st.mdb, out, {c: tuple(p) for c, p in pins.items()}, rs or st.ruleset, settings or st.settings,
                              st.overrides or None, st.mdb_name, self.table(st, "a"))
        pinned.optimiser = out.optimiser
        return pinned

    def patch_hash(self, st: ProjectState) -> str:
        return patches_hash(self.store.get(st.project.id, "data_patches", {}) or {})

    # ───────────── compute ─────────────
    def recompute(self, st: ProjectState, record: bool = True, kind: str = "allocate") -> Computed:
        t0 = time.perf_counter()
        out = run(st.mdb, st.ruleset, st.settings, st.overrides or None, filename=st.mdb_name, table=self.table(st, "a"))
        out = self.apply_tq_pins(st, out, "A")
        from app.sandbox import apply_sandbox
        out = apply_sandbox(self, st, out)
        comp = self.certify(st, out, t0)
        st.current = comp
        if record:
            self.record_run(st, comp, kind)
        return comp

    def certify(self, st: ProjectState, out: RunOutput, t0: float, impact: RevisionImpact | None = None) -> Computed:
        remap = self.stable_ids(st.project.id, out.tqs)
        for sl in out.alloc.slots:  # slots and remarks refer to the stable ids too
            if sl.tq_ids:
                sl.tq_ids = [remap.get(x, x) for x in sl.tq_ids]
                sl.remarks = re.sub(r"TQ-[A-Z]+-\d+", lambda m: remap.get(m.group(0), m.group(0)), sl.remarks)
        if any(o != n for o, n in remap.items()):
            from xio.render import render_rows
            out.rows = render_rows(out.alloc.slots, out.signals, out.rules)
        xlsx, werr = write_allocation_safe(out.rows)
        if werr is not None:  # the template/styling failed: a plain workbook was written instead — say so
            out.tqs.append(sys_tq(TQBook(), "write", "The allocation workbook could not be written from the template — a plain "
                                  "workbook with the same 76 columns was written instead.", exc=werr, severity="high"))
        tqs = self.decorate_tqs(st.project.id, out.tqs)
        report = self.safe_verify(xlsx, out, st, tqs, "(exported allocation)", self.claims(out))
        cert = certify(out.table.sha256, st.ruleset, xlsx, report, st.settings.model_dump_json())
        opt = getattr(out, "optimiser", None) or OptimiserInfo(method="greedy", greedy_ciocs=out.kpis.ciocs, status="greedy only")
        kpis = out.kpis.model_copy(update={"violations": report.violations, "tqs_open": sum(t.status == "open" for t in tqs),
                                           "stability_pct": impact.stability_pct if impact else None})
        return Computed(out=out, report=report, cert=cert, xlsx=xlsx, optimiser=opt,
                        runtime_ms=(time.perf_counter() - t0) * 1e3, tqs=tqs, kpis=kpis, impact=impact)

    @staticmethod
    def claims(out: RunOutput) -> dict:
        """What the exported BOM and the KPIs say about the CIOCs — the verifier checks the rows agree with both."""
        try:
            bom, _ = capacity_bom(out.alloc.cabinets, out.alloc.slots, out.kpis)
            return {"kpi_ciocs": out.kpis.ciocs, "bom": read_bom(bom)}
        except Exception as e:  # an unwritable BOM is a failed agreement for the verifier to report, not a crash
            return {"kpi_ciocs": out.kpis.ciocs, "bom": {"ciocs": [], "cabinet_total": None, "error": f"{type(e).__name__}: {e}"}}

    @staticmethod
    def safe_verify(src, out: RunOutput, st: ProjectState, tqs: list[TQ], filename: str, claims: dict | None = None) -> RuleCheckReport:
        """verify_xlsx that cannot crash: if the verifier itself fails the verdict is FAIL (never a silent PASS)."""
        try:
            return verify_xlsx(src, out.signals, st.ruleset, st.settings, tqs, filename=filename, claims=claims)
        except Exception as e:
            return RuleCheckReport(source="file", file=filename, checks=[CheckResult(
                id="C00", label="Verifier ran", failed=1,
                violations=[Violation(message=f"SYS-verify: the verifier failed — {type(e).__name__}: {e}")])],
                checks_total=1, checks_passed=0, violations=1, verdict="FAIL")

    def record_run(self, st: ProjectState, comp: Computed, kind: str) -> None:
        rr = RunRecord(run_id=comp.cert.run_id, project_id=st.project.id, timestamp=comp.cert.timestamp, revision=st.project.revision,
                       kind=kind, mdb_sha256=comp.cert.mdb_sha256, ruleset_hash=comp.cert.ruleset_hash,  # type: ignore[arg-type]
                       output_sha256=comp.cert.output_sha256, verdict=comp.report.verdict, violations=comp.report.violations,
                       signals=comp.kpis.signals, runtime_ms=round(comp.runtime_ms, 1))
        self.store.append("runs", st.project.id, rr.timestamp, rr.model_dump())

    @contextlib.contextmanager
    def no_persist(self):
        """Inside this block TQ ids are still computed but nothing is written: previews and sandboxes must not reserve ids."""
        prev = getattr(self._tl, "np", False)
        self._tl.np = True
        try:
            yield
        finally:
            self._tl.np = prev

    def stable_ids(self, pid: str, tqs: list[TQ], persist: bool = True) -> dict[str, str]:
        """The same issue keeps the same TQ id across re-runs and revisions (signature → id, persisted)."""
        persist = persist and not getattr(self._tl, "np", False)
        ids: dict[str, str] = self.store.get(pid, "tq_ids", {}) or {}
        taken = set(ids.values())
        changed = False
        out = {}
        for t in tqs:
            sig = tq_signature(t)
            if sig not in ids:
                prefix = t.id.rsplit("-", 1)[0]
                n = 1
                while f"{prefix}-{n:03d}" in taken:
                    n += 1
                ids[sig] = f"{prefix}-{n:03d}"
                taken.add(ids[sig])
                changed = True
            out[t.id] = ids[sig]
        if changed and persist:
            self.store.put(pid, "tq_ids", ids)
        return out

    def decorate_tqs(self, pid: str, tqs: list[TQ], slots=None, persist: bool = True) -> list[TQ]:
        """Stable ids, stored decisions (closed / applied), and applied TQs that no longer occur."""
        decisions: dict[str, dict] = self.store.get(pid, "tq_decisions", {}) or {}
        remap = self.stable_ids(pid, tqs, persist)
        out: list[TQ] = []
        seen = set()
        for t in tqs:
            t = t.model_copy(deep=True)
            sig = tq_signature(t)
            t.id = remap.get(t.id, t.id)
            seen.add(sig)
            d = decisions.get(sig)
            if d:
                t.status, t.decision = d["status"], d.get("decision")
            out.append(t)
        for sig, d in decisions.items():
            if sig not in seen and d.get("tq"):
                t = TQ.model_validate(d["tq"])
                t.status, t.decision = d["status"], d.get("decision")
                if any(x.id == t.id for x in out):
                    t.id = f"{t.id}·{sig[:4]}"
                out.append(t)
        return out

    # ───────────── views ─────────────
    def result(self, st: ProjectState) -> AllocationResult:
        c = st.current or self.recompute(st)
        o = c.out
        return AllocationResult(project_id=st.project.id, revision=st.project.revision, run_id=c.cert.run_id,
                                cabinets=o.alloc.cabinets, slots=o.alloc.slots, tqs=c.tqs, quarantine=o.quarantine,
                                kpis=c.kpis, report=c.report, certificate=c.cert, optimiser=c.optimiser,
                                runtime_ms=round(c.runtime_ms, 1),
                                activity=[ActivityEvent.model_validate(a) for a in self.store.log("activity", st.project.id, 40)])

    def import_summary(self, st: ProjectState) -> ImportSummary:
        c = st.current or self.recompute(st)
        t = c.out.table
        mapping = c.out.mapping
        preview = []
        src = {m.field: m.source for m in mapping if m.source}
        for _, rec in t.rows[:10]:
            preview.append({f: rec.get(h, "") for f, h in src.items()})
        live = sum(1 for s in c.out.signals if s.live)
        notes = list(t.notes)
        if SOURCE_COL in t.headers:
            files = list(dict.fromkeys(rec.get(SOURCE_COL, "").rsplit(":", 1)[0] for _, rec in t.rows))
            notes.append(f"Merged from {len(files)} file(s): {', '.join(files)} — the 'Source file' column traces every row")
        return ImportSummary(file=st.mdb_name, sheet=t.sheet, header_row=t.header_row, rows=len(t.rows), live_rows=live,
                             quarantined=len(c.out.quarantine), mapping=mapping, preview=preview, sha256=t.sha256,
                             needs_confirmation=[m.field for m in mapping if m.needs_confirmation], raw_headers=list(t.headers), notes=notes)

    # ───────────── mutations ─────────────
    def touch(self, st: ProjectState) -> None:
        st.project.updated = now()
        self.store.put_project(st.project.id, st.project.model_dump())

    def activity(self, pid: str, kind: str, text: str) -> None:
        self.store.append("activity", pid, now(), ActivityEvent(ts=now(), kind=kind, text=text).model_dump())  # type: ignore[arg-type]

    def import_mdb(self, pid: str, data: bytes, filename: str) -> ImportSummary:
        st = self.get(pid)
        with st.lock:
            read_table(data, filename=filename)  # validate early: raises ValueError on unusable files
            ts = now()
            self.store.put_file(pid, "mdb_a", "mdb", hashlib.sha256(data).hexdigest(), data, ts)
            self.store.put(pid, "mdb_name", filename)
            self.store.put(pid, "overrides", {})
            for key in ("sandbox_moves", "undo", "redo", "tq_ids", "tq_decisions", "tq_pins", "data_patches", "manual_overrides", "placement_draft"):
                self.store.put(pid, key, [] if key in ("undo", "redo") else None if key == "placement_draft" else {})
            st.mdb, st.mdb_name, st.overrides = data, filename, {}
            st.project.mdb_file, st.project.revision, st.project.revisions = filename, "A", ["A"]
            st.extra.clear()
            for letter in self.store.get(pid, "rev_letters", None) or ["B"]:
                self.store.del_file(pid, f"mdb_{letter.lower()}")
            self.store.put(pid, "rev_letters", [])
            self.store.put(pid, "revision", None)
            self.touch(st)
            comp = self.recompute(st, kind="allocate")
            summ = self.import_summary(st)
            mapped = sum(1 for m in summ.mapping if m.source)
            self.activity(pid, "import", f"Imported {filename} — {summ.rows} rows, {mapped}/{len(summ.mapping)} fields mapped, "
                                         f"{summ.quarantined} quarantined")
            self.activity(pid, "allocate", f"Allocated {comp.kpis.allocated}/{comp.kpis.signals} signals · "
                                           f"{comp.report.violations} violations · {comp.kpis.tqs_open} open TQs")
            return summ

    def import_files(self, pid: str, files: list[tuple[bytes, str]]) -> ImportSummary:
        """One file → import_mdb. Several → each is mapped on its own and merged into one table (a 'Source file' column
        keeps the origin of every row); duplicate tags across files are caught by pre-flight as a TQ."""
        if len(files) == 1:
            return self.import_mdb(pid, *files[0])
        tables = []
        for data, name in files:
            try:
                tables.append(read_table(data, filename=name))
            except ValueError as e:
                raise ValueError(f"{name}: {e}") from e
        merged = merge_tables(tables)
        data = write_table(merged.headers, [[rec.get(h, "") for h in merged.headers] for _, rec in merged.rows])
        summ = self.import_mdb(pid, data, merged.file[:120])
        self.activity(pid, "import", "Merged " + ", ".join(f"{t.file} (sha {t.sha256[:8]})" for t in tables))
        return summ

    def set_mapping(self, pid: str, mapping: list[ColumnMapping]) -> ImportSummary:
        st = self.get(pid)
        with st.lock:
            auto = {m.field: m.source for m in auto_map(read_table(st.mdb).headers)}
            st.overrides = {m.field: m.source for m in mapping if m.source != auto.get(m.field)}
            self.store.put(pid, "overrides", st.overrides)
            self.recompute(st)
            self.activity(pid, "import", f"Column mapping updated ({len(st.overrides)} override(s))")
            return self.import_summary(st)

    def preview(self, st: ProjectState, ruleset: RuleSet | None = None, settings: ProjectSettings | None = None) -> Computed:
        """What the project WOULD look like under another rule set / settings: the very same pipeline as a real change, on a
        detached copy of the state — nothing is stored, no run is recorded, no TQ id is reserved, `st.current` is untouched."""
        extra = {k: st.extra[k] for k in ("revs", "recompute_hook") if k in st.extra}
        clone = ProjectState(project=st.project.model_copy(), ruleset=ruleset or st.ruleset, settings=settings or st.settings,
                             overrides=st.overrides, mdb=st.mdb, mdb_name=st.mdb_name, current=None, extra=extra, lock=st.lock)
        with st.lock, self.no_persist():
            if clone.project.revision != "A" and extra.get("recompute_hook"):
                from app.revisions import compute_active
                return compute_active(self, clone, record=False)
            return self.recompute(clone, record=False)

    def put_rules(self, pid: str, rs: RuleSet, why: str = "rule set edited", tq_id: str | None = None,
                  patch: dict | None = None, who: str = "engineer") -> AllocationResult:
        from app.customrules import validate_ruleset
        validate_ruleset(rs)         # a malformed custom rule is a 422 here, never a broken run later
        st = self.get(pid)
        with st.lock:
            version = self.store.latest_ruleset_version(pid) + 1
            rs = rs.model_copy(update={"version": version})
            ts = now()
            self.store.put_ruleset(pid, version, rs.model_dump(), ts, why)
            st.ruleset = rs
            st.project.ruleset_version = version
            self.touch(st)
            self.store.append("decisions", pid, ts, DecisionEntry(ts=ts, who=who, why=why, tq_id=tq_id,
                                                                  rule_id=(patch or {}).get("rule_id"), patch=patch,
                                                                  ruleset_version=version).model_dump())
            self.recompute_active(st)
            self.activity(pid, "rule", f"Rule set v{version}: {why}")
            return self.result(st)

    def put_settings(self, pid: str, settings: ProjectSettings) -> AllocationResult:
        st = self.get(pid)
        with st.lock:
            st.settings = settings
            self.store.put(pid, "settings", settings.model_dump())
            self.recompute_active(st)
            self.activity(pid, "rule", "Project settings updated")
            return self.result(st)

    def recompute_active(self, st: ProjectState) -> Computed:
        """Re-run whatever revision is active (Rev A plain; Rev B through the revision engine)."""
        hook = st.extra.get("recompute_hook")
        return hook(st) if hook else self.recompute(st)

    def allocate(self, pid: str) -> AllocationResult:
        st = self.get(pid)
        with st.lock:
            comp = self.recompute_active(st)
            self.activity(pid, "allocate", f"Allocated {comp.kpis.allocated}/{comp.kpis.signals} signals into "
                                           f"{comp.kpis.cabinets} cabinets in {comp.runtime_ms:.0f} ms · "
                                           f"{comp.report.violations} violations")
            self.activity(pid, "verify", f"Verifier on the exported file: {comp.report.verdict} · "
                                         f"{comp.report.checks_passed}/{comp.report.checks_total} checks")
            return self.result(st)

    def verify(self, pid: str) -> RuleCheckReport:
        st = self.get(pid)
        c = st.current or self.recompute(st)
        rep = self.safe_verify(c.xlsx, c.out, st, c.tqs, self.export_name(st, "allocation"), self.claims(c.out))
        self.activity(pid, "verify", f"Re-verified exported file: {rep.verdict} · {rep.checks_passed}/{rep.checks_total} checks")
        return rep

    def verify_file(self, pid: str, data: bytes, filename: str) -> RuleCheckReport:
        st = self.get(pid)
        c = st.current or self.recompute(st)
        t0 = time.perf_counter()
        rep = self.safe_verify(data, c.out, st, c.tqs, filename)
        sha = hashlib.sha256(data).hexdigest()
        rr = RunRecord(run_id="vf-" + sha[:12], project_id=pid, timestamp=now(), revision=st.project.revision, kind="verify-file",
                       mdb_sha256=c.cert.mdb_sha256, ruleset_hash=ruleset_hash(st.ruleset), output_sha256=sha,
                       verdict=rep.verdict, violations=rep.violations, signals=c.kpis.signals,
                       runtime_ms=round((time.perf_counter() - t0) * 1e3, 1))
        self.store.append("runs", pid, rr.timestamp, rr.model_dump())
        first = next((v for ch in rep.checks for v in ch.violations), None)
        self.activity(pid, "verify", f"Verified uploaded {filename}: {rep.verdict}"
                                     + (f" — {rep.violations} violation(s), first at row {first.row}" if first and first.row else ""))
        return rep

    # ───────────── exports ─────────────
    def export_name(self, st: ProjectState, kind: str) -> str:
        proj = "".join(ch if ch.isalnum() else "_" for ch in st.project.id)
        return {"allocation": f"IO_Allocation_{proj}_Rev{st.project.revision}.xlsx", "rule_check": "Rule_Check_Report.xlsx",
                "tq_register": "TQ_Register.xlsx", "revision_impact": "Revision_Impact.xlsx",
                "capacity_bom": "Capacity_BOM.xlsx"}[kind]

    def export(self, pid: str, kind: str) -> tuple[bytes, str, int]:
        st = self.get(pid)
        c = st.current or self.recompute(st)
        if kind == "allocation":
            return c.xlsx, self.export_name(st, kind), len(c.out.rows)
        if kind == "rule_check":
            data, n = rule_check_report(c.report, c.cert)
        elif kind == "tq_register":
            data, n = tq_register(c.tqs, c.out.quarantine)
        elif kind == "revision_impact":
            data, n = revision_impact(c.impact)
        elif kind == "capacity_bom":
            data, n = capacity_bom(c.out.alloc.cabinets, c.out.alloc.slots, c.kpis)
        else:
            raise KeyError(kind)
        return data, self.export_name(st, kind), n

    def exports(self, pid: str) -> list[ExportFile]:
        st = self.get(pid)
        c = st.current or self.recompute(st)
        imp = c.impact
        return [
            ExportFile(kind="allocation", filename=self.export_name(st, "allocation"), rows=len(c.out.rows), sha256=c.cert.output_sha256),
            ExportFile(kind="rule_check", filename="Rule_Check_Report.xlsx", rows=len(c.report.checks)),
            ExportFile(kind="tq_register", filename="TQ_Register.xlsx", rows=len(c.tqs)),
            ExportFile(kind="revision_impact", filename="Revision_Impact.xlsx",
                       rows=(len(imp.added) + len(imp.deleted) + len(imp.modified) + len(imp.moved)) if imp else 0),
            ExportFile(kind="capacity_bom", filename="Capacity_BOM.xlsx", rows=len(c.kpis.hardware_bom)),
        ]

    def export_zip(self, pid: str) -> tuple[bytes, str]:
        st = self.get(pid)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for kind in ("allocation", "rule_check", "tq_register", "revision_impact", "capacity_bom"):
                data, name, _ = self.export(pid, kind)
                z.writestr(name, data)
        self.activity(pid, "export", "Downloaded all exports (.zip)")
        return buf.getvalue(), f"OptiSlot_{st.project.id}_Rev{st.project.revision}.zip"

    def check_in_memory(self, st: ProjectState, out: RunOutput) -> RuleCheckReport:
        return verify_rows(out.rows, out.signals, st.ruleset, st.settings, out.tqs)
