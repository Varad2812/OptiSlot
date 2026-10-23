"""Engine tests: sample regression, structural invariants, capacity property, junk rows never crash."""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl
import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.schemas import ProjectSettings
from engine.allocate import Block, Geometry, footprint, layout
from engine.pipeline import run
from engine.rules import load_ruleset
from tests.helpers import row, table

ROOT = Path(__file__).resolve().parents[2]
MDB = ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx"
REF = ROOT / "data" / "Sample_IO_Allocation_VIT_v2_1.xlsx"
key = lambda s: re.sub(r"\s+", "", s or "")


@pytest.fixture(scope="module")
def sample():
    return run(MDB)


def assert_structure(out) -> None:
    """Invariants every allocation must satisfy, independent of the data."""
    slots = out.alloc.slots
    assert len(slots) == 384 * len(out.alloc.cabinets), "full grid"
    addr = Counter((s.cabinet, s.cioc_seq, s.bp, s.ch) for s in slots)
    assert max(addr.values(), default=1) == 1, "a slot is used twice"
    pairs = Counter((s.cable, s.pair) for s in slots if s.cable not in ("-", "") and s.pair)
    assert max(pairs.values(), default=1) == 1, "a cable pair is used twice"
    for s in slots:
        assert s.charm_no == (s.bp - 1) * 12 + s.ch
        assert s.baseplate.startswith(f"{s.cioc_seq:03d}-")
    # A and B never share a CIOC (unless excepted by a TQ)
    fam: dict[tuple, set] = defaultdict(set)
    for s in slots:
        if s.status == "Field" and s.family in ("A", "B") and not s.tq_ids:
            fam[(s.cabinet, s.cioc_seq)].add(s.family)
    assert all(len(v) == 1 for v in fam.values()), "A and B share a CIOC"
    # cable pairs contiguous and in order; big cables start at ch 1 on whole baseplates
    by_cable: dict[str, list] = defaultdict(list)
    for s in slots:
        if s.block_id:
            by_cable[s.block_id].append(s)
    for cable, ss in by_cable.items():
        ss.sort(key=lambda s: s.pair)
        assert len({(s.cabinet, s.cioc_seq) for s in ss}) == 1, f"{cable} split across CIOCs"
        lin = [(s.bp - 1) * 12 + s.ch for s in ss]
        assert lin == list(range(lin[0], lin[0] + len(lin))), f"{cable} not contiguous"
        if ss[0].cable_size and ss[0].cable_size >= 12:
            assert ss[0].ch == 1
        else:
            assert len({s.bp for s in ss}) == 1, f"{cable} crosses a baseplate"
    # every live, non-quarantined signal is placed exactly once; every other live signal has a TQ
    placed = Counter(s.tag_key for s in slots if s.status in ("Field", "Cabinet Alarm"))
    assert max(placed.values(), default=1) == 1
    tq_rows = {r for t in out.tqs for r in t.rows}
    for s in out.signals:
        if s.live and s.tag_key:
            assert s.tag_key in placed or s.row in tq_rows, f"{s.tag} neither allocated nor TQ'd"
    for s in slots:
        if s.reserved == "future":
            assert s.status == "Spare Slot"


def test_sample_counts(sample):
    k = sample.kpis
    assert k.signals == 189
    assert k.allocated == 189
    assert k.allocated_pct == 100.0
    assert k.status_counts == {"Field": 177, "Wired Spare": 22, "Cabinet Alarm": 12, "Spare Slot": 941}
    assert len(sample.alloc.cabinets) == 3
    assert [c.name for c in sample.alloc.cabinets] == ["P30-DCM-32001-01", "P30-DCM-32001-04", "P24-DCM-50002-01"]


def test_sample_structure(sample):
    assert_structure(sample)


def test_sample_traps(sample):
    tags = {s.tag_key for s in sample.alloc.slots if s.status == "Field"}
    assert "320-FT-80002" not in tags, "DELETED tag must not be allocated"
    assert "440-PI-20077-L" in tags, "440-PI-20077-L is live in the MDB and must be allocated"
    deleted = [s for s in sample.alloc.slots if s.cable == "320-CE-0001" and s.pair == 3][0]
    assert deleted.status == "Spare Slot" and deleted.remarks == "Tag Deleted"


def test_24_pair_cable_takes_two_whole_baseplates(sample):
    ss = sorted([s for s in sample.alloc.slots if s.block_id == "320-CE-0001"], key=lambda s: s.pair)
    assert len(ss) == 24
    assert ss[0].ch == 1 and ss[12].ch == 1 and ss[12].bp == ss[0].bp + 1
    assert {s.bp for s in ss} == {ss[0].bp, ss[0].bp + 1}


def test_cabinet_alarms_on_reserved_baseplate(sample):
    alarms = [s for s in sample.alloc.slots if s.status == "Cabinet Alarm"]
    assert len(alarms) == 12
    assert all(s.cioc_local == 1 and s.bp == 1 for s in alarms)
    dcs = [s for s in alarms if "-DCS-" in (sample.signals[[x.row for x in sample.signals].index(s.source_row)].equipment)]
    assert {s.cabinet for s in dcs} == {"P30-DCM-32001-01"}


def test_hardware(sample):
    by_tag = {s.tag_key: s for s in sample.alloc.slots if s.status == "Field"}
    assert by_tag["320-XYV-20202"].charm == "SE4302T02" and by_tag["320-XYV-20202"].tb == "SE4502"
    assert by_tag["500-XA-00322-L"].charm == "SE4302T01" and by_tag["500-XA-00322-L"].tb == "SE4501"
    rtd = [s for s in sample.alloc.slots if s.signal_type == "RTD"]
    assert rtd and all(s.charm == "SE4303T03" for s in rtd)


def test_wired_spares_meet_target(sample):
    for c in sample.kpis.spare_compliance:
        assert c.ok, c


def test_reproducible():
    a, b = run(MDB), run(MDB)
    assert a.rows == b.rows


def test_reference_agreement(sample, capsys):
    """Informative only: how many live tags land at the same address as the hand-made reference."""
    wb = openpyxl.load_workbook(REF, read_only=True)
    it = wb.worksheets[0].iter_rows(values_only=True)
    hdr = list(next(it))
    ref = {}
    for r in it:
        d = dict(zip(hdr, r))
        if d["Tag Status"] in ("Field", "Cabinet Alarm"):
            ref[key(str(d["Tag Name"]))] = (d["CIOC/CSLS Name"], d["Baseplate"], int(d["Channel_No"]))
    ours = {s.tag_key: (s.cioc, s.baseplate, s.ch) for s in sample.alloc.slots if s.status in ("Field", "Cabinet Alarm")}
    same = sum(1 for k, v in ours.items() if ref.get(k) == v)
    same_cab = sum(1 for k, v in ours.items() if k in ref and ref[k][0][:-3] == v[0][:-3])
    with capsys.disabled():
        print(f"\n  reference agreement: {same}/{len(ours)} exact addresses ({100 * same / len(ours):.0f}%), "
              f"{same_cab}/{len(ours)} same area prefix")


# ───────────────────────── synthetic data ─────────────────────────

def test_ab_on_one_cable_is_excepted_by_tq():
    rows = [row(f"T-{i}", "AI", "C-1", i, 12, group="A" if i < 5 else "B") for i in range(1, 9)]
    out = run(b"", table=table(rows))
    tq = [t for t in out.tqs if t.category == "A/B on one cable"]
    assert len(tq) == 1 and "rule r-ab" in tq[0].message
    b_slots = [s for s in out.alloc.slots if s.family == "B"]
    assert b_slots and all(tq[0].id in s.tq_ids for s in b_slots)
    assert_structure(out)


def test_bad_rows_become_tqs_not_crashes():
    rows = [
        row("OK-1", "AI", "C-1", 1, 12),
        row("NOPAIR", "AI", "C-1", None, 12),
        row("NOCABLE", "DI", "", 1, 12),
        row("BADIO", "XX", "C-1", 3, 12),
        row("OK-1", "AI", "C-1", 4, 12),                   # duplicate tag
        row("DUPPAIR", "AI", "C-1", 1, 12),                # duplicate cable pair
        row("OVER", "AI", "C-2", 9, 6),                    # pair > size
        row("UZV-1", "DO", "C-3", 1, 6, inst="UZV"),       # unknown DO type: allocated + TQ
        row("", "AI", "C-4", 1, 6),                        # no tag
    ]
    out = run(b"", table=table(rows))
    cats = Counter(t.category for t in out.tqs)
    for c in ("Missing pair", "Missing cable", "Unknown IO type", "Duplicate tag", "Duplicate cable pair",
              "Pair exceeds cable size", "Unknown DO type", "Missing tag"):
        assert cats[c] >= 1, c
    placed = {s.tag_key for s in out.alloc.slots if s.status == "Field"}
    assert "UZV-1" in placed and "OK-1" in placed
    assert len(out.quarantine) == 7
    assert_structure(out)


def test_overflow_opens_next_cabinet():
    rows = []
    for c in range(40):  # 40 × 24-pair cables = 80 baseplates > 1 cabinet
        rows += [row(f"T-{c}-{p}", "AI", f"C-{c:03d}", p, 24) for p in range(1, 21)]
    out = run(b"", table=table(rows))
    assert len(out.alloc.cabinets) >= 3
    assert out.kpis.allocated == 800
    names = [c.name for c in out.alloc.cabinets]
    assert names[:3] == ["P30-DCM-32001-01", "P30-DCM-32001-02", "P30-DCM-32001-03"]
    assert [c.controller for c in out.alloc.cabinets][:2] == ["P30DPK320101", "P30DPK320102"]
    assert_structure(out)


def test_missing_columns_one_project_tq():
    rows = [row(f"T-{i}", "AI", "C-1", i, 12) for i in range(1, 6)]
    hdr = ["Tag Number", "I/O Type Name", "Multipair Cable No.", "Pair Number", "Multi-cable / Cable"]
    out = run(b"", table=table(rows, hdr))
    proj = [t for t in out.tqs if t.category == "Project setting"]
    assert len(proj) == len({t.field for t in proj}), "one project TQ per missing column"
    assert out.alloc.cabinets[0].name == "P01-DCM-10001-01"
    assert out.kpis.allocated == 5


def test_renamed_reordered_columns_map():
    rows = [row(f"T-{i}", "DI", "C-9", i, 6) for i in range(1, 4)]
    renamed = {"Tag Number": "TagNo", "I/O Type Name": "IO Type", "Multipair Cable No.": "Cable No",
               "Pair Number": "Pair", "IO Grouping": "Segregation"}
    rows2 = [{renamed.get(k, k): v for k, v in r.items()} for r in rows]
    hdr = list(reversed([renamed.get(h, h) for h in rows[0].keys()]))
    out = run(b"", table=table(rows2, hdr))
    assert out.kpis.allocated == 3


# ───────────────────────── properties ─────────────────────────

G = Geometry(4, 8, 12, 12)


def mk_block(i: int, size: int) -> Block:
    span, foot = footprint(size, G)
    return Block(id=f"B{i}", cable=f"B{i}", size=size, span=span, foot=foot, members={}, family="-", group="-",
                 group_rank=0, domain="d", first_row=i)


@settings(max_examples=3000, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.sampled_from([1, 2, 6, 12, 24]), min_size=1, max_size=40),
       st.integers(min_value=1, max_value=8), st.integers(min_value=0, max_value=4))
def test_capacity_property(sizes, n_usable, offset):
    """Block sizes 1/2/6/12/24 divide each other: if the footprint sum fits the free whole baseplates,
    the deterministic layout always finds an exact placement."""
    usable = list(range(1 + offset, min(9, 1 + offset + n_usable)))
    blocks = [mk_block(i, s) for i, s in enumerate(sizes)]
    total = sum(b.foot for b in blocks)
    result = layout(blocks, usable, G)
    if total <= 12 * len(usable):
        assert result is not None
    if result is not None:
        occ = Counter()
        for b in blocks:
            bp, ch = result[b.id]
            for k in range(b.foot):
                occ[(bp + (ch - 1 + k) // 12, (ch - 1 + k) % 12)] += 1
            if b.span:
                assert ch == 1
            else:
                assert (ch - 1) % b.foot == 0 and ch - 1 + b.foot <= 12
        assert max(occ.values()) == 1
        assert all(bp in usable for bp, _ in occ)


cable_mix = st.lists(st.tuples(st.sampled_from([1, 2, 6, 12, 24]), st.sampled_from(["A", "B", "-", "C"]),
                               st.sampled_from(["AI", "AO", "DI", "DO"]), st.floats(0.1, 1.0)), min_size=1, max_size=60)


@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(cable_mix)
def test_random_cable_mixes_allocate_cleanly(mix):
    rows = []
    for c, (size, grp, io, fill) in enumerate(mix):
        for p in range(1, max(1, int(size * fill)) + 1):
            rows.append(row(f"T{c}-{p}", io, f"CB-{c:03d}", p, size, group=grp, inst="XYV" if io == "DO" else "PT"))
    out = run(b"", table=table(rows))
    assert_structure(out)
    assert out.kpis.allocated == len(rows)


junk = st.text(alphabet=st.characters(blacklist_categories=("Cs",)), max_size=12)


@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.fixed_dictionaries({
    "tag": st.one_of(junk, st.just("")), "io": st.sampled_from(["AI", "AO", "DI", "DO", "XX", "", "ai", "D O"]),
    "cable": st.one_of(junk, st.sampled_from(["C-1", "C-2", "Internal Wiring", ""])),
    "pair": st.one_of(junk, st.integers(-3, 40).map(lambda n: f"Pair {n}")),
    "spec": st.one_of(junk, st.sampled_from(["24PX1MM2", "06PX", "1TX", "", "-", "999PX"])),
    "group": st.sampled_from(["A", "B", "-", "", "A-CONTROL", "B-ALARM", "ZZ"]),
    "status": st.sampled_from(["New", "DELETED", "", "Modified"]),
    "room": st.one_of(junk, st.just("PIB-30")), "area": st.one_of(junk, st.just("RA 320-01")),
    "equip": st.one_of(junk, st.just("P30-DCM-32001-02")),
}), max_size=40))
def test_junk_rows_never_crash(rows):
    t = table([row(r["tag"], r["io"], r["cable"], r["pair"], group=r["group"], status=r["status"], room=r["room"],
                   area=r["area"], equipment=r["equip"], spec=r["spec"]) for r in rows])
    out = run(b"", table=t, settings=ProjectSettings(max_cabinets_per_domain=6))
    assert_structure(out)
