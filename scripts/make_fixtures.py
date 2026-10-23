"""Build schema-valid UI fixtures (frontend/src/mock/*.json) from the reference workbook.

P0 stand-in so the UI track can start before the engine exists. Once the engine runs,
`make fixtures` regenerates these from a real allocation instead.
Usage: uv run --project backend python scripts/make_fixtures.py
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.schemas import (  # noqa: E402
    ActivityEvent, AllocationResult, BaseplateInfo, CabinetInfo, CabinetSpares, Certificate,
    CheckResult, CiocInfo, FixOption, Kpis, MoveItem, OptimiserInfo, Project, RevisionImpact,
    RuleCheckReport, RuleSet, RunRecord, Slot, SpareCompliance, TQ, Violation, WhyStep,
)

REF = ROOT / "data" / "Sample_IO_Allocation_VIT_v2_1.xlsx"
MOCK = ROOT / "frontend" / "src" / "mock"
TS = "2026-10-23T10:00:00Z"
FAMILY = {"A": "A", "A-CONTROL": "A", "B": "B", "B-ALARM": "B"}


def num(s: str) -> int | None:
    m = re.search(r"(\d+)", s or "")
    return int(m.group(1)) if m else None


def main() -> None:
    wb = openpyxl.load_workbook(REF, read_only=True, data_only=True)
    it = wb.worksheets[0].iter_rows(values_only=True)
    hdr = [str(h) for h in next(it)]
    rows = [dict(zip(hdr, ["-" if v is None else str(v).strip() for v in r])) for r in it]

    cab_order: list[str] = []
    for r in rows:
        if r["Electronic/ Marshalling Cabinet"] not in cab_order:
            cab_order.append(r["Electronic/ Marshalling Cabinet"])

    slots: list[Slot] = []
    for r in rows:
        cab = r["Electronic/ Marshalling Cabinet"]
        cioc_seq = int(r["CIOC/CSLS Name"][-3:])
        bp = int(r["Baseplate"].split("-")[-1])
        ch = int(r["Channel_No"])
        status = r["Tag Status"]
        group = r["Segregation"]
        cable = r["Field Cable No"]
        pair = num(r["Field Cable Pair"])
        why = []
        if status == "Field":
            why = [
                WhyStep(rule_id="r-io-map", text=f"IO type → {r['IO Type']}"),
                WhyStep(rule_id="r-ab", text=f"Segregation family {FAMILY.get(group, 'neutral')} → CIOC {cioc_seq:03d}"),
                WhyStep(rule_id="r-cable", text=f"Cable {cable} pair {pair} lands on channel {ch} of its block"),
                WhyStep(rule_id="r-hw", text=f"{r['IO Type']} → {r['CHARM Type']} + {r['CHARM TB Part No']}"),
            ]
        elif status == "Wired Spare":
            why = [WhyStep(rule_id="r-wired-spare", text=f"Unused pair {pair} of {cable} wired as {r['IO Type']} spare to meet 10% target")]
        elif status == "Cabinet Alarm":
            why = [WhyStep(rule_id="r-alarm-bp", text="Internal cabinet signal → reserved baseplate 1 of CIOC 1")]
        slots.append(Slot(
            id=f"{cab}/{cioc_seq:03d}/{bp}/{ch}", cabinet=cab, cabinet_seq=int(cab[-2:]),
            system_cabinet=r["System Cabinet"], controller=r["Controller"], controller_seq=int(r["Controller"][-2:]),
            domain=f"{r['Technical Room']}|{r['Risk Area']}", cioc=r["CIOC/CSLS Name"], cioc_seq=cioc_seq,
            cioc_local=(cioc_seq - 1) % 4 + 1, side=r["Cabinet Side (F/R)"], baseplate=r["Baseplate"], bp=bp, ch=ch,
            charm_no=int(r["CHARM_No"]), status=status, tag=r["Tag Name"], tag_key=re.sub(r"\s+", "", r["Tag Name"]) if r["Tag Name"] != "-" else "",
            io_type=r["IO Type"], family=FAMILY.get(group, "-"), group=group, cable=cable, cable_spec=r["Field Cable Size"],
            cable_size=num(r["Field Cable Size"]) if cable != "-" else None, pair=pair, pair_label=r["Field Cable Pair"],
            block_id=f"{cable}#{(pair - 1) // 12 if pair and (num(r['Field Cable Size']) or 0) >= 12 else 0}" if cable != "-" else None,
            charm=r["CHARM Type"], charm_desc=r["Charm Description"], tb=r["CHARM TB Part No"], tb_desc=r["CHARM TB Description"],
            tb1=r["CHARM TB1"], tb2=r["CHARM TB2"], tb3=r["CHARM TB3"], loop_typical=r["HW Loop Typical"],
            signal_type=r["Signal Type"], signal_level=r["Signal Level"], service=r["Service Description"],
            instrument_type=r["Instrument type"], reserved="cabinet_alarm" if bp == 1 and (cioc_seq - 1) % 4 == 0 else ("future" if (cioc_seq - 1) % 4 == 3 and bp >= 6 else None),
            revision=r["Revision No"], remarks=r["Remarks"], old_tag=r["Old Tag"], why=why,
        ))

    by_cab: dict[str, list[Slot]] = defaultdict(list)
    for s in slots:
        by_cab[s.cabinet].append(s)
    cabinets: list[CabinetInfo] = []
    spares_per_cab: list[CabinetSpares] = []
    for cab in cab_order:
        ss = by_cab[cab]
        ciocs = []
        for cioc in sorted({s.cioc for s in ss}):
            cs = [s for s in ss if s.cioc == cioc]
            fams = {s.family for s in cs} - {"-"}
            bps = []
            for bp in range(1, 9):
                b = [s for s in cs if s.bp == bp]
                bps.append(BaseplateInfo(bp=bp, name=b[0].baseplate, reserved=b[0].reserved,
                                         used=sum(s.status in ("Field", "Cabinet Alarm") for s in b),
                                         wired_spares=sum(s.status == "Wired Spare" for s in b)))
            ciocs.append(CiocInfo(name=cioc, seq=cs[0].cioc_seq, local=cs[0].cioc_local, side=cs[0].side,
                                  family=(fams.pop() if len(fams) == 1 else "-"),
                                  used=sum(s.status in ("Field", "Cabinet Alarm") for s in cs),
                                  wired_spares=sum(s.status == "Wired Spare" for s in cs), baseplates=bps))
        s0 = ss[0]
        cabinets.append(CabinetInfo(name=cab, seq=s0.cabinet_seq, system_cabinet=s0.system_cabinet, controller=s0.controller,
                                    controller_seq=s0.controller_seq, domain=s0.domain, loc=cab[:3], area_code=cab.split("-")[2],
                                    declared=True, ciocs=ciocs))
        used = sum(s.status in ("Field", "Cabinet Alarm") for s in ss)
        empty_bp = sum(1 for c in ciocs for b in c.baseplates if b.used == 0 and b.wired_spares == 0 and b.reserved != "cabinet_alarm")
        spares_per_cab.append(CabinetSpares(cabinet=cab, controller=s0.controller, used=used,
                                            wired_spares=sum(s.status == "Wired Spare" for s in ss),
                                            spare_slots=sum(s.status == "Spare Slot" for s in ss), empty_baseplates=empty_bp,
                                            future_baseplates=4, fill_pct=round(100 * used / len(ss), 1)))

    compliance = []
    for ctrl in sorted({s.controller for s in slots}):
        for io in ("AIR", "AOR", "DIR", "DOR"):
            f = sum(s.controller == ctrl and s.io_type == io and s.status == "Field" for s in slots)
            w = sum(s.controller == ctrl and s.io_type == io and s.status == "Wired Spare" for s in slots)
            if f == 0 and w == 0:
                continue
            tgt = math.ceil(f * 0.10)
            compliance.append(SpareCompliance(controller=ctrl, io_type=io, field=f, wired=w, target=tgt,
                                              pct=round(100 * w / f, 1) if f else 0.0, ok=w >= tgt))

    tqs = [
        TQ(id="TQ-DATA-001", category="Missing from reference", severity="high", rows=[157], tags=["440-PI   -20077-L"], field="Tag Number",
           rules_in_conflict=["r-capacity"], message="440-PI-20077-L (New, AO) is live in the MDB but the reference allocation has 440-PI-20076-L on that pair. Allocated on 500-CE-LP-0003-A pair 14; confirm the tag number.",
           fix_options=[FixOption(label="Keep MDB tag 440-PI-20077-L"), FixOption(label="Rename to 440-PI-20076-L", data_patch={"row": 157, "field": "Tag Number", "value": "440-PI   -20076-L"})],
           unchanged_note="Everything else unchanged.", confidence="candidate"),
        TQ(id="TQ-HW-001", category="DO hardware conflict", severity="medium", rows=[166, 167, 172], tags=["500-XA   -00322-L", "500-XA   -00323-L", "500-XA   -00324-L"],
           field="Instrument Type", rules_in_conflict=["r-hw"], message="XA (alarm horn/beacon duty) uses standard high-side DO in the sample, but the PS says horns/beacons/sounders need isolated + fused DO. Confirm load/inrush.",
           fix_options=[FixOption(label="Treat XA as high-current (SE4302T02 + SE4502)", rule_patch={"rule_id": "r-hw", "op": "list_add", "list": "high_current_do", "value": "XA"}),
                        FixOption(label="Keep standard DO (SE4302T01 + SE4501)")],
           unchanged_note="Only the CHARM/TB of the XA rows change; no slot moves.", confidence="candidate"),
        TQ(id="TQ-PROJ-001", category="Project setting", severity="low", rows=[], tags=[], field="Section / Sub Unit",
           message="No 'Section / Sub Unit' column found in the MDB — output column left as '-'. Map a column if one exists.",
           fix_options=[FixOption(label="Map a column on the Import page")], unchanged_note="Allocation unaffected."),
        TQ(id="TQ-CAP-001", category="Wired spare shortfall", severity="medium", rows=[], tags=[], field="Tag Status",
           rules_in_conflict=["r-wired-spare"], message="P24DPK500201 needs 2 DOR wired spares (10% of 14) but cable 500-CE-LP-0003-B has only 1 free pair left after allocation.",
           fix_options=[FixOption(label="Lower DOR wired spare target to 7%", rule_patch={"rule_id": "r-wired-spare", "op": "set", "path": "pct", "value": 7}),
                        FixOption(label="Accept shortfall")], unchanged_note="No signal moves."),
        TQ(id="TQ-DATA-002", category="Deleted tag", severity="info", status="closed", rows=[4], tags=["320-FT   -80002"], field="Status",
           message="320-FT-80002 is DELETED — not allocated; pair 3 of 320-CE-0001 left as Spare Slot.", unchanged_note="Cable keeps its other pairs."),
    ]
    status_counts = Counter(s.status for s in slots)
    field = status_counts["Field"] + status_counts["Cabinet Alarm"]
    checks = [
        ("C01", "Every live MDB tag appears exactly once", "r-capacity", 188),
        ("C02", "No duplicate CIOC / baseplate / channel", "r-capacity", 1152),
        ("C03", "No duplicate cable + pair", "r-capacity", 199),
        ("C04", "CHARM_No = (BP-1)×12 + channel", "r-capacity", 1152),
        ("C05", "Baseplate prefix = CIOC sequence", "r-names", 1152),
        ("C06", "Cable pairs contiguous and in order", "r-cable", 19),
        ("C07", "A and B never on one CIOC", "r-ab", 12),
        ("C08", "IO Grouping kept together", "r-group", 7),
        ("C09", "Hardware matches the map", "r-hw", 211),
        ("C10", "Names match the patterns", "r-names", 1152),
        ("C11", "Wired spares ≥ 10% per IO type per controller", "r-wired-spare", len(compliance)),
        ("C12", "Future spare baseplates present", "r-future", 3),
        ("C13", "Full grid: 384 rows per cabinet", "r-capacity", 3),
        ("C14", "Tag Status discipline", "r-capacity", 1152),
        ("C15", "Cabinet alarms on reserved baseplate", "r-alarm-bp", 12),
    ]
    report = RuleCheckReport(checks=[CheckResult(id=i, label=l, rule_id=r, passed=n) for i, l, r, n in checks],
                             checks_total=len(checks), checks_passed=len(checks), violations=0, verdict="PASS")
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()
    cert = Certificate(run_id="run-0001", timestamp=TS, mdb_sha256=h("mdb"), ruleset_hash=h("ruleset"), output_sha256=h("out"),
                       verdict="PASS", checks_passed=len(checks), checks_total=len(checks), violations=0)
    used_bp = sum(1 for c in cabinets for ci in c.ciocs for b in ci.baseplates if b.used or b.wired_spares)
    hw = Counter(s.charm for s in slots) + Counter(s.tb for s in slots if s.status != "Spare Slot")
    kpis = Kpis(signals=189, allocated=field, allocated_pct=100.0, unallocated_with_tq=0, tqs_open=sum(t.status == "open" for t in tqs),
                violations=0, cabinets=len(cabinets), ciocs=sum(len(c.ciocs) for c in cabinets), baseplates_used=used_bp,
                fill_pct=round(100 * (field + status_counts["Wired Spare"]) / len(slots), 1), wired_spares=status_counts["Wired Spare"],
                wired_target=sum(c.target for c in compliance), status_counts=dict(status_counts),
                tq_by_category=dict(Counter(t.category for t in tqs)), spare_compliance=compliance,
                spares_per_cabinet=spares_per_cab, hardware_bom=dict(hw))
    activity = [
        ActivityEvent(ts="2026-10-23T09:58:02Z", kind="import", text="Imported Sample_IO_MDB_VIT_v2_1.xlsx — 190 rows, 143 columns, 14/14 fields mapped"),
        ActivityEvent(ts="2026-10-23T09:58:03Z", kind="tq", text="Pre-flight raised 4 TQs (1 high)"),
        ActivityEvent(ts="2026-10-23T09:58:04Z", kind="allocate", text="Allocated 189 signals into 3 cabinets / 12 CIOCs in 41 ms"),
        ActivityEvent(ts="2026-10-23T09:58:04Z", kind="verify", text="Verifier: 0 violations · 15/15 checks"),
    ]
    result = AllocationResult(project_id="demo", revision="A", run_id="run-0001", cabinets=cabinets, slots=slots, tqs=tqs,
                              quarantine=[], kpis=kpis, report=report, certificate=cert,
                              optimiser=OptimiserInfo(method="cpsat", greedy_ciocs=12, cpsat_ciocs=12, adopted=False, status="OPTIMAL", time_ms=180.0,
                                                      note="CP-SAT matched greedy; greedy kept"),
                              runtime_ms=41.0, activity=activity)
    project = Project(id="demo", name="VIT Sample — PIB-30 / PIB-24", mdb_file="Sample_IO_MDB_VIT_v2_1.xlsx", created=TS, updated=TS)
    ruleset = RuleSet.model_validate_json((ROOT / "rulesets" / "default.json").read_text())
    runs = [RunRecord(run_id=f"run-000{i}", project_id="demo", timestamp=TS, revision="A", mdb_sha256=h("mdb"), ruleset_hash=h("ruleset"),
                      output_sha256=h("out"), verdict="PASS", violations=0, signals=189, runtime_ms=41.0 + i) for i in (1, 2)]
    impact = RevisionImpact(
        from_rev="A", to_rev="B",
        added=[MoveItem(tag="320-PT   -80099", to_slot="P30-DCM-32001-01/001/3/10", reason="New tag on spare pair 22 of 320-CE-0001 — took the cable's own position"),
               MoveItem(tag="320-XS   -90001", to_slot="P30-DCM-32001-01/004/6/1", reason="New 12-pair cable 320-CE-0999 → first free baseplate on a neutral CIOC")],
        deleted=[MoveItem(tag="320-TT   -80005", from_slot="P30-DCM-32001-01/001/2/12", reason="Deleted in Rev B — slot freed as Spare Slot")],
        modified=[MoveItem(tag="500-XA   -00322-L", from_slot="P24-DCM-50002-01/003/3/1", to_slot="P24-DCM-50002-01/003/3/1", reason="Instrument type → XYV: CHARM SE4302T01→SE4302T02, TB SE4501→SE4502, same slot")],
        moved=[], unchanged_in_place=186, previous_live=189, stability_pct=98.4, cabinets_touched=["P30-DCM-32001-01", "P24-DCM-50002-01"],
        new_tqs=["TQ-REV-001", "TQ-REV-002"],
    )
    MOCK.mkdir(parents=True, exist_ok=True)
    for name, obj in [("allocation", result), ("project", project), ("ruleset", ruleset), ("revision_impact", impact)]:
        (MOCK / f"{name}.json").write_text(obj.model_dump_json(indent=1))
    (MOCK / "runs.json").write_text(json.dumps([r.model_dump() for r in runs], indent=1))
    print(f"fixtures → {MOCK}: {len(slots)} slots, {len(cabinets)} cabinets, {len(tqs)} TQs")


if __name__ == "__main__":
    main()
