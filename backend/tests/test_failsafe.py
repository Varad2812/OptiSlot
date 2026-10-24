"""Fail-safe layer: injected faults in every stage become SYS-<stage> TQs and the run still returns a valid result."""
from __future__ import annotations

import io

import openpyxl
import pytest

from app.schemas import ProjectSettings
from engine import allocate, normalise as norm_mod, optimise, pipeline
from engine.pipeline import run
from engine.rules import load_ruleset
from tests.helpers import row, table
from tests.test_verify import claims
from verify.checks import verify_rows
from xio import render as render_mod, writer


def two_domain_rows():
    rows = []
    for room, area, prefix in (("PIB-30", "RA 320-01", "A"), ("PIB-31", "RA 321-01", "B")):
        for c in range(3):
            for p in range(1, 13):
                io_ = ("AI", "DI", "AO")[c]
                rows.append(row(f"{prefix}{c}-{p}", io_, f"{prefix}-CB{c}", p, 12, group="A" if c else "-", room=room, area=area))
    return rows


def sys_cats(out):
    return {t.category for t in out.tqs if t.category.startswith("SYS-")}


def check(out):
    rep = verify_rows(out.rows, out.signals, out.rules.rs, out.settings, out.tqs, claims=claims(out))
    assert rep.verdict == "PASS", [(c.id, c.violations[:3]) for c in rep.checks if c.failed]
    return rep


def test_baseline_has_no_sys_tq():
    out = run(b"", table=table(two_domain_rows()))
    assert not sys_cats(out) and out.kpis.allocated == 72
    check(out)


# ───────────── read / map ─────────────

@pytest.mark.parametrize("blob", [b"", b"not a workbook", b"\x89PNG\r\n\x1a\n" + bytes(200), b"PK\x03\x04garbage"])
def test_unreadable_file_returns_a_result_with_a_read_tq(blob):
    out = run(blob, filename="bad.xlsx")
    assert "SYS-read" in sys_cats(out) and out.rows == [] and out.kpis.signals == 0
    assert next(t for t in out.tqs if t.category == "SYS-read").severity == "critical"


def test_mapper_failure_is_a_tq(monkeypatch):
    monkeypatch.setattr(pipeline, "map_table", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-map" in sys_cats(out) and out.kpis.allocated == 0
    assert any(t.category == "Required column missing" for t in out.tqs)


# ───────────── normalise / preflight ─────────────

def test_one_bad_row_is_quarantined_not_fatal(monkeypatch):
    real = norm_mod.parse_cable_size
    monkeypatch.setattr(norm_mod, "parse_cable_size", lambda spec: (_ for _ in ()).throw(ValueError("bad spec")) if "13PX" in spec else real(spec))
    rows = two_domain_rows()
    rows[5]["Multi-cable / Cable"] = "13PX1MM2"
    out = run(b"", table=table(rows))
    assert "SYS-normalise" in sys_cats(out)
    t = next(t for t in out.tqs if t.category == "SYS-normalise")
    assert t.rows == [rows.index(rows[5]) + 2] and len(out.quarantine) == 1
    assert out.kpis.allocated == 71
    check(out)


def test_preflight_crash_degrades(monkeypatch):
    monkeypatch.setattr(pipeline, "preflight", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("pf")))
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-preflight" in sys_cats(out) and out.kpis.allocated == 72
    check(out)


# ───────────── allocate: per-domain isolation ─────────────

def test_domain_failure_is_isolated(monkeypatch):
    real = allocate.Engine.assign_greedy

    def flaky(self, domain, ns, blocks):
        if "PIB-31" in domain:
            raise KeyError("boom in domain B")
        return real(self, domain, ns, blocks)

    monkeypatch.setattr(allocate.Engine, "assign_greedy", flaky)
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-allocate" in sys_cats(out)
    t = next(t for t in out.tqs if t.category == "SYS-allocate")
    assert "PIB-31" in t.message and "KeyError" in t.message and len(t.tags) == 36
    assert out.kpis.allocated == 36 and len(out.quarantine) == 36
    assert {s.domain for s in out.signals if not s.quarantined} == {next(s.domain for s in out.signals if "PIB-30" in s.domain)}
    check(out)


def test_global_allocation_failure_quarantines_everything(monkeypatch):
    monkeypatch.setattr(allocate.Engine, "build_blocks", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("global")))
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-allocate" in sys_cats(out) and out.kpis.allocated == 0 and len(out.quarantine) == 72
    assert out.rows == []
    check(out)


def test_layout_failure_in_one_cabinet_is_isolated(monkeypatch):
    real = allocate.Engine.fill

    def boom(self):
        if not getattr(self, "_failed", False) and any("PIB-31" in c.domain for c in self.cabs):
            self._failed = True
            self.ctx = ("layout", next(c.domain for c in self.cabs if "PIB-31" in c.domain))
            raise IndexError("fill")
        return real(self)

    monkeypatch.setattr(allocate.Engine, "fill", boom)
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-layout" in sys_cats(out) and out.kpis.allocated == 36
    check(out)


# ───────────── optimise ─────────────

def test_cpsat_error_falls_back_to_greedy(monkeypatch):
    rows = two_domain_rows()
    ref = run(b"", table=table(rows), settings=ProjectSettings(cpsat_enabled=False))
    monkeypatch.setattr(optimise, "_improve", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("cp-sat exploded")))
    out = run(b"", table=table(rows))
    assert "SYS-optimise" in sys_cats(out)
    assert out.rows == ref.rows and not out.optimiser.adopted and "error" in out.optimiser.note.lower()
    check(out)


def test_cpsat_failure_outside_the_guard_retries_greedy(monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("model build")
    monkeypatch.setattr(optimise, "make_cpsat_assign", lambda *a, **k: broken)
    ref = run(b"", table=table(two_domain_rows()), settings=ProjectSettings(cpsat_enabled=False))
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-optimise" in sys_cats(out) and out.rows == ref.rows
    check(out)


# ───────────── unsatisfiable rules ─────────────

def test_infeasible_assignment_places_what_fits():
    """An assigner that crams three 24-pair cables onto one CIOC (cap: 8 BPs, 4 reserved by the alarm/future rules)."""
    rows = [row(f"X{c}-{p}", "AI", f"CB{c}", p, 24) for c in range(5) for p in range(1, 25)]

    def cram(engine, domain, ns, blocks):
        cab = next(c for c in engine.cabs if c.domain == domain)
        for b in blocks:
            engine.commit(cab, 2, b)

    out = run(b"", table=table(rows), assign=cram)
    t = [t for t in out.tqs if t.category == "Unsatisfiable layout"]
    assert t and "r-capacity" in t[0].message and t[0].rules_in_conflict
    placed = out.kpis.allocated
    assert 0 < placed < 120 and placed + len(out.quarantine) == 120
    check(out)


def test_capacity_cap_names_the_rule():
    rows = [row(f"X{c}-{p}", "AI", f"CB{c}", p, 24) for c in range(14) for p in range(1, 25)]
    out = run(b"", table=table(rows), settings=ProjectSettings(max_cabinets_per_domain=1))
    t = next(t for t in out.tqs if t.category == "Cabinet capacity")
    assert "r-capacity" in t.message and out.kpis.allocated > 0 and out.quarantine
    check(out)


def test_invalid_geometry_is_rejected_by_the_schema():
    for bad in ({"ciocs_per_cabinet": 0}, {"baseplates_per_cioc": -1}, {"channels_per_baseplate": 0}):
        with pytest.raises(ValueError):
            ProjectSettings(**bad)


# ───────────── render / write / verify ─────────────

def test_unrenderable_slot_keeps_core_columns(monkeypatch):
    real = render_mod.fmt
    monkeypatch.setattr(render_mod, "fmt", lambda pat, **kw: (_ for _ in ()).throw(ValueError("pattern")) if kw.get("tag_nodash") == "A01" else real(pat, **kw))
    out = run(b"", table=table(two_domain_rows()))
    assert "SYS-render" in sys_cats(out)
    r = next(r for r in out.rows if r["Tag Name"] == "A0-1")
    assert r["Remarks"].startswith("SYS-render") and r["Tag Status"] == "Field" and r["CHARM_No"] != "-"


def test_write_failure_falls_back_to_a_plain_workbook(monkeypatch):
    monkeypatch.setattr(writer, "write_allocation", lambda *a, **k: (_ for _ in ()).throw(OSError("template locked")))
    out = run(b"", table=table(two_domain_rows()))
    data, err = writer.write_allocation_safe(out.rows)
    assert isinstance(err, OSError)
    ws = openpyxl.load_workbook(io.BytesIO(data)).worksheets[0]
    assert ws.max_row == len(out.rows) + 1 and ws.cell(1, 1).value == "Sr. No." and ws.freeze_panes == "D2"
    from verify.xlsx import verify_xlsx
    rep = verify_xlsx(data, out.signals, out.rules.rs, out.settings, out.tqs, claims=claims(out))
    assert rep.verdict == "PASS"


def test_verifier_survives_unparseable_rows():
    out = run(b"", table=table(two_domain_rows()))
    rep = verify_rows([{"Tag Status": None}] * 3 + out.rows[:5], out.signals, out.rules.rs, out.settings, out.tqs)
    assert rep.verdict == "FAIL"


def test_crashing_check_is_a_failure_not_a_skip(monkeypatch):
    from verify import checks
    out = run(b"", table=table(two_domain_rows()))
    boom = lambda ctx: (_ for _ in ()).throw(RuntimeError("check bug"))  # noqa: E731
    boom.__name__ = "c_group_together"
    monkeypatch.setattr(checks, "CHECKS", [*checks.CHECKS, boom])
    rep = verify_rows(out.rows, out.signals, out.rules.rs, out.settings, out.tqs)
    assert rep.verdict == "FAIL" and any("check could not run" in v.message for c in rep.checks for v in c.violations)


def test_mixed_is_cable_takes_its_dominant_family_and_spares_follow():
    """9 NON-IS + 1 IS on one cable used to be 'placed as IS' (alphabetical): the wired spare copied the lone IS signal
    and shared a baseplate with the NON-IS ones — a verifier FAIL on a surprise dataset."""
    rows = [row(f"M-{p}", "AI", "CB-MIX", p, 12, is_type="IS" if p == 4 else "NON-IS") for p in range(1, 11)]
    rows += [row(f"Q-{p}", "AI", "CB-Q", p, 12, is_type="NON-IS") for p in range(1, 13)]
    out = run(b"", table=table(rows))
    clash = next(t for t in out.tqs if t.category == "Segregation clash on one cable")
    assert "placed with the NON-IS family (the one most of its signals have)" in clash.message
    assert out.kpis.wired_spares >= 1
    check(out)
