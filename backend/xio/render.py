"""Slots → the 76 template columns, exactly as they are written to Excel.

The Excel writer and the in-memory verifier both consume these rows, so what we verify is what we write.
"""
from __future__ import annotations

from app.schemas import Signal, Slot
from engine.rules import Rules, catalog, fmt

DASH = "-"
# defaults for the output_map rule's `spare_inherit` / `slot_inherit` (the rule set is the source; these are the fallback)
# columns a wired spare inherits from the cable member it is modelled on
SPARE_INHERIT = {"Technical Room", "Operating Area", "Risk Area", "Unit", "Location", "Signal Type", "Signal Level", "NON-IS / IS"}
# columns a spare slot inherits from its cabinet's domain
SLOT_INHERIT = {"Technical Room", "Operating Area", "Risk Area", "Unit"}
NUMERIC = {"Sr. No.", "Channel_No", "CHARM_No"}


def columns() -> list[str]:
    return list(catalog()["template"]["columns"])


def _field_value(s: Signal, src: str) -> str:
    v = getattr(s, src, None) if src in Signal.model_fields and src != "extra" else s.extra.get(src)
    v = "" if v is None else str(v).strip()
    return v or DASH


def render_rows(slots: list[Slot], signals: list[Signal], rules: Rules,
                errors: list[tuple[Slot, BaseException]] | None = None) -> list[dict[str, str]]:
    """errors (optional): collects (slot, exception) for slots that fell back to the core-columns-only row."""
    cols = columns()
    out_map = rules.params("output_map")
    colmap: dict[str, str] = out_map.get("columns", {})
    consts: dict[str, str] = out_map.get("constants", {})
    blank_for: dict[str, list[str]] = out_map.get("blank_for", {})   # Tag Status → columns NOT copied for that status
    spare_inherit = set(out_map.get("spare_inherit", SPARE_INHERIT))
    slot_inherit = set(out_map.get("slot_inherit", SLOT_INHERIT))
    pats = rules.params("naming_pattern").get("patterns", {})
    dst_pat = pats.get("dst", "{tag_nodash}_")
    vis_pat = pats.get("visualization", "{dcm}({side})")
    by_row = {s.row: s for s in signals}
    domain_rep: dict[str, Signal] = {}
    for s in sorted(signals, key=lambda s: s.row):
        if s.live and not s.quarantined:
            domain_rep.setdefault(s.domain, s)

    cab_rep: dict[str, Signal] = {}      # a spare slot reads its cabinet's own earliest signal (a domain can mix units and spellings)
    for sl in slots:
        src = by_row.get(sl.source_row) if sl.source_row else None
        if src is not None and sl.status in ("Field", "Cabinet Alarm") and (sl.cabinet not in cab_rep or src.row < cab_rep[sl.cabinet].row):
            cab_rep[sl.cabinet] = src

    rows: list[dict[str, str]] = []
    for i, sl in enumerate(slots, start=1):
        try:
            r = {c: DASH for c in cols}
            src = by_row.get(sl.source_row) if sl.source_row else None
            if sl.status in ("Field", "Cabinet Alarm") and src:
                skip = set(blank_for.get(sl.status, []))
                for c, f in colmap.items():
                    if c in r and c not in skip:
                        r[c] = _field_value(src, f)
            elif sl.status == "Wired Spare" and src:
                for c, f in colmap.items():
                    if c in spare_inherit and c in r:
                        r[c] = _field_value(src, f)
            else:
                rep = cab_rep.get(sl.cabinet) or domain_rep.get(sl.domain)
                if rep:
                    for c, f in colmap.items():
                        if c in slot_inherit and c in r:
                            r[c] = _field_value(rep, f)
            for c, v in consts.items():
                if c in r:
                    r[c] = str(v)

            live = sl.status != "Spare Slot"
            tag = sl.tag if live else DASH
            r.update({
                "Sr. No.": str(i),
                "Revision No": sl.revision,
                "Tag Name": tag,
                "DSTName": fmt(dst_pat, tag_nodash=(sl.tag_key if live else "").replace("-", "")),
                "IO Type": sl.io_type if live else DASH,
                "System Cabinet": sl.system_cabinet,
                "Controller": sl.controller,
                "Electronic/ Marshalling Cabinet": sl.cabinet,
                "CIOC/CSLS Name": sl.cioc,
                "Baseplate": sl.baseplate,
                "Channel_No": str(sl.ch),
                "CHARM_No": str(sl.charm_no),
                "CHARM Type": sl.charm,
                "Charm Description": sl.charm_desc,
                "CHARM TB Part No": sl.tb,
                "CHARM TB Description": sl.tb_desc,
                "CHARM TB1": sl.tb1 if live else DASH,
                "CHARM TB2": sl.tb2 if live else DASH,
                "CHARM TB3": sl.tb3 if live else DASH,
                "Field Cable No": sl.cable if sl.cable not in ("", None) else DASH,
                "Field Cable Size": sl.cable_spec if sl.cable not in ("", "-", None) else DASH,
                "Field Cable Pair": sl.pair_label if sl.cable not in ("", "-", None) else DASH,
                "Tag Status": sl.status,
                "Remarks": sl.remarks or DASH,
                "HW Loop Typical": sl.loop_typical if live else DASH,
                "Cabinet Side (F/R)": sl.side,
                "Change Type": sl.change_type or DASH,
                "Cabinet Name for Visualization": fmt(vis_pat, dcm=sl.cabinet, side=sl.side),
            })
            if sl.status == "Wired Spare":
                r["Service Description"] = sl.service
            if sl.status in ("Field", "Cabinet Alarm") and sl.old_tag not in ("", DASH) and "Old Tag" in r:
                r["Old Tag"] = sl.old_tag
            rows.append(r)
        except Exception as e:  # one unrenderable slot keeps its address, status and tag; the rest are untouched
            if errors is not None:
                errors.append((sl, e))
            rows.append(_core_row(i, sl, cols))
    return rows


def _core_row(i: int, sl: Slot, cols: list[str]) -> dict[str, str]:
    """Fallback when a slot cannot be rendered with the full column map: the columns the verifier needs, as plain text."""
    def g(attr: str) -> str:
        try:
            v = getattr(sl, attr)
            return DASH if v in (None, "") else str(v)
        except Exception:
            return DASH

    live = g("status") != "Spare Slot"
    r = {c: DASH for c in cols}
    r.update({"Sr. No.": str(i), "Tag Name": g("tag") if live else DASH, "IO Type": g("io_type") if live else DASH,
              "System Cabinet": g("system_cabinet"), "Controller": g("controller"),
              "Electronic/ Marshalling Cabinet": g("cabinet"), "CIOC/CSLS Name": g("cioc"), "Baseplate": g("baseplate"),
              "Channel_No": g("ch"), "CHARM_No": g("charm_no"), "CHARM Type": g("charm"), "Charm Description": g("charm_desc"),
              "CHARM TB Part No": g("tb"), "CHARM TB Description": g("tb_desc"), "Field Cable No": g("cable"),
              "Field Cable Pair": g("pair_label") if g("cable") != DASH else DASH, "Tag Status": g("status"),
              "Cabinet Side (F/R)": g("side"), "Revision No": g("revision"),
              "Remarks": "SYS-render: row written with core columns only"})
    return {c: r[c] for c in cols}
