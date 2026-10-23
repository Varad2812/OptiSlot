"""MDB rows → normalised Signals. Missing columns fall back to Project Settings with ONE project TQ each."""
from __future__ import annotations

import re

from app.schemas import ProjectSettings, Signal
from engine.rules import Rules, derive, match_when
from engine.tqs import TQBook
from xio.reader import RawTable

EMPTY = {"", "-", "--", "N/A", "NA", "NONE", "NULL", "NAN", "TBA", "TBC"}
_SIZE = re.compile(r"^\s*0*(\d{1,3})\s*(?:PX|TX|QX|P\b|PR\b|PAIRS?\b|T\b|TRIADS?\b|C\b|CORES?\b|X)", re.I)
_SIZE_LOOSE = re.compile(r"(\d{1,3})\s*(?:PX|TX|PAIRS?|PR|TRIADS?)", re.I)
# only clean pair forms: "Pair 10", "Triad 1", "10", "Pair #10" — anything else ("1:0", "3-4", "10/11") is not a pair
_PAIR = re.compile(r"(?:pair|triad|pr)?\s*#?\s*(\d{1,4})", re.I)
PASSTHROUGH = ("operating_area", "unit", "service", "location", "is_type", "external_power", "system2",
               "old_tag", "loop_name", "section")


def blank(v: str | None) -> bool:
    return v is None or str(v).strip().upper() in EMPTY


def clean(v: str | None, default: str = "-") -> str:
    return default if blank(v) else str(v).strip()


def tag_key(tag: str) -> str:
    return re.sub(r"\s+", "", tag or "")


def parse_cable_size(spec: str) -> int | None:
    if blank(spec):
        return None
    m = _SIZE.match(spec) or _SIZE_LOOSE.search(spec)
    if not m:
        return None
    n = int(m.group(1))
    return n if 0 < n <= 999 else None


def parse_pair(p: str) -> int | None:
    if blank(p):
        return None
    m = _PAIR.fullmatch(str(p).strip())
    if not m:
        return None
    n = int(m.group(1))
    return n if n > 0 else None


def family_of(group: str, rules: Rules) -> str:
    seg = rules.primary_seg
    if not seg:
        return "-"
    g = (group or "").strip().upper()
    for fam, members in seg.params.get("families", {}).items():
        if g in {m.upper() for m in members}:
            return fam if fam in ("A", "B") else "-"
    return "-"


def normalise(table: RawTable, mapping: dict[str, str], rules: Rules, settings: ProjectSettings,
              book: TQBook) -> list[Signal]:
    def col(rec: dict[str, str], f: str) -> str:
        src = mapping.get(f)
        return rec.get(src, "") if src else ""

    names = rules.params("naming_pattern").get("derive", {})
    io_map = {k.upper(): v for k, v in rules.params("io_type_map").get("map", {}).items()}
    io_map_on = rules.first("io_type_map") is not None
    alarm_rule = rules.first("reserve_baseplate")
    deleted = {s.upper() for s in settings.deleted_statuses}

    for f, label in [("room", "Technical room"), ("area", "Design / risk area"), ("group", "IO grouping / segregation"),
                     ("cable_spec", "Cable spec / size"), ("status", "Status")]:
        if f not in mapping:
            msg = {
                "room": f"{label} column not found in the MDB — every signal uses location prefix {settings.loc_prefix_default}. Confirm or map a column.",
                "area": f"{label} column not found — every signal uses area code {settings.area_code_default}. Confirm or map a column.",
                "group": "No IO Grouping / segregation column — A/B segregation cannot be checked. Map a column if one exists.",
                "cable_spec": "No cable spec column — cable sizes are inferred from the highest pair used (rounded to 2/6/12/24). Confirm.",
                "status": "No status column — every row is treated as live.",
            }[f]
            book.add("project", "Project setting", "medium" if f in ("group", "cable_spec") else "low", msg,
                     field=label, fixes=[{"label": "Map a column on the Import page"}, {"label": "Accept the default"}],
                     unchanged="Allocation proceeds with the default.", key=f"missing-col:{f}")

    signals: list[Signal] = []
    for row_no, rec in table.rows:
        tag = col(rec, "tag").strip()
        status = col(rec, "status").strip()
        s = Signal(row=row_no, tag=tag, tag_key=tag_key(tag), status=status or "-",
                   live=status.strip().upper() not in deleted)
        if blank(tag):
            s.tag = ""
            t = book.add("data", "Missing tag", "medium", f"Row {row_no} has data but no tag — quarantined.",
                         rows=[row_no], field="Tag", fixes=[{"label": "Add the tag in the MDB"}, {"label": "Ignore the row"}])
            book.quarantine_signal(s, "no tag", t, {k: v for k, v in rec.items() if v and k in mapping.values()})
            signals.append(s)
            continue

        raw_io = col(rec, "io_type").strip()
        s.io_type_raw = raw_io
        s.io_type = io_map.get(raw_io.upper().replace(" ", ""), "") if io_map_on else raw_io.upper()
        s.signal_type = clean(col(rec, "signal_type"))
        s.signal_level = clean(col(rec, "signal_level"))
        s.instrument_type = clean(col(rec, "instrument_type")).upper()
        s.instrument_desc = clean(col(rec, "instrument_desc"))
        s.equipment = clean(col(rec, "equipment"))
        s.room = clean(col(rec, "room"))
        s.area = clean(col(rec, "area"))
        s.cable = clean(col(rec, "cable"), "")
        s.cable_spec = clean(col(rec, "cable_spec"))
        s.cable_size = parse_cable_size(s.cable_spec)
        s.pair_label = clean(col(rec, "pair"))
        s.pair = parse_pair(s.pair_label)
        s.group = clean(col(rec, "group"))
        s.family = family_of(s.group, rules)  # type: ignore[assignment]
        s.extra = {f: clean(col(rec, f)) for f in PASSTHROUGH}
        s.extra["cable_raw"] = s.cable or "-"   # kept for rules even when the cable is blanked below

        # location prefix + area code (with project defaults and ONE TQ each when underivable)
        loc = derive(names.get("loc"), s.room)
        if not loc:
            loc = settings.loc_prefix_default
            if "room" in mapping:
                book.add("project", "Unmapped room", "low",
                         f"Room value(s) do not match the location pattern — using {loc}. Confirm the location prefix.",
                         rows=[row_no], field="Technical room", key="unmapped-room")
        area_code = derive(names.get("area"), s.area)
        if not area_code:
            area_code = settings.area_code_default
            if "area" in mapping:
                book.add("project", "Unmapped area", "low",
                         f"Design area value(s) do not match the area pattern — using {area_code}. Confirm the area code.",
                         rows=[row_no], field="Design area", key="unmapped-area")
        s.loc, s.area_code = loc, area_code
        s.area4 = derive(names.get("area4"), area_code) or area_code[:4]
        s.domain = "|".join(getattr(s, k, "") if hasattr(s, k) else s.extra.get(k, "") for k in settings.domain_keys) or "ALL"

        if alarm_rule:
            ctx = {"cable": s.cable, "equipment": s.equipment, "tag": s.tag, "io_type": s.io_type,
                   "instrument_type": s.instrument_type}
            if any(match_when(w, ctx) for w in alarm_rule.params.get("match_any", [])):
                s.kind = "cabinet_alarm"
                if any("cable" in w and match_when(w, ctx) for w in alarm_rule.params.get("match_any", [])):
                    # internal wiring is not a field cable: no cable number, size or pair to land
                    s.cable, s.cable_size, s.pair, s.pair_label, s.cable_spec = "", None, None, "-", "-"
        signals.append(s)
    return signals
