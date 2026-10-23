"""The four companion reports: Rule check, TQ register, Revision impact, Capacity & BOM."""
from __future__ import annotations

from collections import Counter, defaultdict

from app.ruleslang import catalog
from app.schemas import (
    CabinetInfo, Certificate, Kpis, QuarantineRow, RevisionImpact, RuleCheckReport, Slot, TQ,
)
from xio.writer import add_table, new_book, save_book


def rule_check_report(report: RuleCheckReport, cert: Certificate | None) -> tuple[bytes, int]:
    wb = new_book()
    summary = [
        ["Verdict", report.verdict], ["Checks passed", f"{report.checks_passed}/{report.checks_total}"],
        ["Violations (hard rules)", report.violations], ["Warnings (soft rules)", report.warnings],
        ["Excepted by TQ", report.excepted], ["Source", report.source + (f" · {report.file}" if report.file else "")],
    ]
    if cert:
        summary += [["Run id", cert.run_id], ["Timestamp", cert.timestamp], ["Engine", cert.engine_version],
                    ["MDB sha256", cert.mdb_sha256], ["Rule set hash", cert.ruleset_hash], ["Output sha256", cert.output_sha256]]
    add_table(wb, "Certificate", ["Item", "Value"], summary, [26, 80], status_col="Value")
    add_table(wb, "Checks", ["Check", "Label", "Rule", "Severity", "Passed", "Failed", "Excepted", "Result"],
              [[c.id, c.label, c.rule_id or "-", c.severity, c.passed, c.failed, c.excepted,
                "PASS" if c.failed == 0 else ("FAIL" if c.severity == "hard" else "WARN")] for c in report.checks],
              [8, 52, 14, 10, 10, 10, 10, 10], status_col="Result")
    viol = [[c.id, c.label, c.severity, v.row or "-", v.tag or "-", v.slot_id or "-", v.message]
            for c in report.checks for v in c.violations]
    add_table(wb, "Violations", ["Check", "Label", "Severity", "Excel row", "Tag", "Slot", "Detail"], viol,
              [8, 40, 10, 10, 22, 30, 90])
    exc = [[c.id, c.label, v.row or "-", v.tag or "-", v.message] for c in report.checks for v in c.exceptions]
    add_table(wb, "Excepted by TQ", ["Check", "Label", "Excel row", "Tag", "Detail"], exc, [8, 40, 10, 22, 90])
    return save_book(wb), len(report.checks)


def tq_register(tqs: list[TQ], quarantine: list[QuarantineRow]) -> tuple[bytes, int]:
    wb = new_book()
    rows = []
    for t in tqs:
        rows.append([t.id, t.severity, t.category, ", ".join(t.tags[:6]) + (" …" if len(t.tags) > 6 else "") or "-",
                     t.field or "-", t.message, " | ".join(f.label for f in t.fix_options) or "-", t.status.upper(),
                     t.decision or "-", t.confidence, ", ".join(map(str, t.rows[:12])) or "-",
                     ", ".join(t.rules_in_conflict) or "-", t.unchanged_note or "-"])
    add_table(wb, "TQ Register", ["TQ no", "Severity", "Category", "Tag", "Field", "Issue", "Suggested resolution",
                                  "Status", "Decision", "Confidence", "MDB rows", "Rules in conflict", "Unchanged"],
              rows, [13, 10, 22, 26, 18, 70, 50, 10, 24, 11, 16, 18, 30], status_col="Status")
    add_table(wb, "Quarantine", ["MDB row", "Tag", "Reason", "TQ"],
              [[q.row, q.tag, q.reason, q.tq_id or "-"] for q in quarantine], [10, 26, 50, 14])
    return save_book(wb), len(tqs)


def revision_impact(impact: RevisionImpact | None) -> tuple[bytes, int]:
    wb = new_book()
    if impact is None:
        add_table(wb, "Summary", ["Item", "Value"], [["Revision", "A (baseline)"], ["Status", "No revision loaded yet"]], [26, 50])
        return save_book(wb), 0
    add_table(wb, "Summary", ["Item", "Value"], [
        ["From → to", f"Rev {impact.from_rev} → Rev {impact.to_rev}"], ["Stability", f"{impact.stability_pct}%"],
        ["Unchanged in place", impact.unchanged_in_place], ["Previous live signals", impact.previous_live],
        ["Added", len(impact.added)], ["Deleted", len(impact.deleted)], ["Modified", len(impact.modified)],
        ["Moved", len(impact.moved)], ["Cabinets touched", ", ".join(impact.cabinets_touched) or "-"],
        ["New TQs", ", ".join(impact.new_tqs) or "-"]], [26, 70])
    n = 0
    for title, items in (("Added", impact.added), ("Deleted", impact.deleted), ("Modified", impact.modified), ("Moved", impact.moved)):
        n += add_table(wb, title, ["Tag", "From slot", "To slot", "Reason"],
                       [[m.tag, m.from_slot or "-", m.to_slot or "-", m.reason] for m in items], [26, 32, 32, 90])
    return save_book(wb), n


def capacity_bom(cabinets: list[CabinetInfo], slots: list[Slot], kpis: Kpis) -> tuple[bytes, int]:
    wb = new_book()
    cat = catalog()
    by_cab: dict[str, list[Slot]] = defaultdict(list)
    for s in slots:
        by_cab[s.cabinet].append(s)
    rows = []
    for c in cabinets:
        ss = by_cab[c.name]
        used_bp = sum(1 for ci in c.ciocs for b in ci.baseplates if b.used or b.wired_spares or any(
            s.cable not in ("-", "") for s in ss if s.cioc_local == ci.local and s.bp == b.bp))
        live = sum(s.status in ("Field", "Cabinet Alarm") for s in ss)
        rows.append([c.name, c.system_cabinet, c.controller, len(c.ciocs), sum(len(ci.baseplates) for ci in c.ciocs), used_bp,
                     live, len(ss), round(100 * live / len(ss), 1) if ss else 0, len(ss) - live,
                     "declared in MDB" if c.declared else "opened by engine"])
    add_table(wb, "Cabinets", ["Marshalling cabinet", "System cabinet", "Controller", "CIOCs", "Baseplates", "Baseplates used",
                               "Signals", "Slots", "Fill %", "Headroom (slots)", "Origin"], rows,
              [22, 22, 16, 8, 11, 14, 9, 8, 8, 15, 18])
    rows = []
    for c in cabinets:
        for ci in c.ciocs:
            rows.append([c.name, ci.name, ci.side, ci.family, ci.used, ci.wired_spares, ci.capacity,
                         round(100 * (ci.used + ci.wired_spares) / ci.capacity, 1),
                         sum(1 for b in ci.baseplates if b.reserved == "future"),
                         sum(1 for b in ci.baseplates if b.reserved == "cabinet_alarm")])
    add_table(wb, "CIOCs", ["Cabinet", "CIOC", "Side", "Family", "Signals", "Wired spares", "Capacity", "Fill %",
                            "Future BPs", "Alarm BPs"], rows, [22, 20, 6, 8, 9, 12, 10, 8, 11, 10])
    charms = Counter(s.charm for s in slots)
    tbs = Counter(s.tb for s in slots)
    bom = [[p, cat["charms"].get(p, p), "CHARM", n] for p, n in sorted(charms.items())]
    bom += [[p, cat["terminal_blocks"].get(p, p), "Terminal block", n] for p, n in sorted(tbs.items())]
    add_table(wb, "BOM", ["Part no", "Description", "Kind", "Quantity"], bom, [14, 60, 16, 10])
    add_table(wb, "Spares per controller", ["Controller", "IO type", "Field", "Wired spares", "Target", "Wired %", "Status"],
              [[s.controller, s.io_type, s.field, s.wired, s.target, s.pct, "OK" if s.ok else "SHORT"] for s in kpis.spare_compliance],
              [16, 9, 8, 13, 8, 9, 9], status_col="Status")
    add_table(wb, "Spares per cabinet", ["Cabinet", "Controller", "Signals", "Wired spares", "Spare slots", "Empty baseplates",
                                         "Future baseplates", "Fill %"],
              [[s.cabinet, s.controller, s.used, s.wired_spares, s.spare_slots, s.empty_baseplates, s.future_baseplates, s.fill_pct]
               for s in kpis.spares_per_cabinet], [22, 16, 9, 13, 12, 16, 16, 8])
    return save_book(wb), len(bom)
