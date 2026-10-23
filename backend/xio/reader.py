"""Read any IO MDB workbook and auto-map its columns to canonical fields.

- picks the sheet and header row automatically (the row that best matches known column names);
- maps columns with exact synonyms first, then rapidfuzz similarity; every mapping has a confidence;
- blank rows are skipped; everything else is returned as text (never crashes on odd cells).
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass, field
from pathlib import Path

import openpyxl
from rapidfuzz import fuzz

from app.schemas import ColumnMapping

# canonical field → (label, required, synonyms in priority order)
FIELDS: dict[str, tuple[str, bool, list[str]]] = {
    "tag": ("Tag", True, ["Tag Number", "Tag No", "TagNo", "Tag", "Tag Name", "TagNumber", "Instrument Tag"]),
    "status": ("Status", False, ["Status", "Tag Status", "Revision Status", "Line Status", "Signal Status"]),
    "io_type": ("IO type", True, ["I/O Type Name", "IO Type", "I/O Type", "IOType", "IO Type Name", "Signal IO Type"]),
    "signal_type": ("Signal type", False, ["Signal Type", "Signal"]),
    "signal_level": ("Signal level", False, ["Signal Level", "Wiring", "Wire Type"]),
    "instrument_type": ("Instrument type", False, ["Instrument Type", "Inst Type", "Instrument Code", "Device Type"]),
    "instrument_desc": ("Instrument description", False, ["Instrument Type Description", "Instrument Description", "Device Description"]),
    "equipment": ("Equipment", False, ["Equipment Name", "Equipment", "Equipment Tag"]),
    "room": ("Technical room", False, ["Technical Room (Signal Location 2)", "Technical Room", "Room", "Signal Location 2", "Tech Room"]),
    "area": ("Design / risk area", False, ["Design Area", "Risk Area", "Area", "Plant Area"]),
    "operating_area": ("Operating area", False, ["OA No.", "OA No", "Operating Area", "OA"]),
    "unit": ("Unit", False, ["WBS", "Unit", "Plant Unit"]),
    "service": ("Service", False, ["Tag Service 1 and 2", "Service Description", "Service", "Description"]),
    "location": ("Location", False, ["Location", "Field Location"]),
    "is_type": ("IS / NON-IS", False, ["Execution", "NON-IS / IS", "IS/NIS", "IS Type", "Intrinsic Safety"]),
    "external_power": ("External power", False, ["External Power Supply", "External Power", "Ext Power"]),
    "cable_spec": ("Cable spec / size", False, ["Multi-cable / Cable", "Cable Type", "Cable Size", "Cable Spec", "Multicable", "Field Cable Size"]),
    "cable": ("Cable no.", True, ["Multipair Cable No.", "Multipair Cable No", "Cable No", "Cable No.", "Cable Number", "Multipair Cable", "Field Cable No", "Cable"]),
    "pair": ("Pair", True, ["Pair Number", "Pair", "Pair No", "Pair No.", "Field Cable Pair", "Core"]),
    "group": ("IO grouping / segregation", False, ["IO Grouping", "Segregation", "Group", "IO Group", "Segregation Group"]),
    "loop_name": ("Loop name", False, ["Loop Name", "Loop"]),
    "old_tag": ("Old tag", False, ["Old Tag Number", "Old Tag", "Previous Tag"]),
    "system2": ("System 2", False, ["System 2"]),
    "section": ("Section / sub unit", False, ["Section / Sub Unit", "Section", "Sub Unit"]),
}

FUZZY_THRESHOLD = 82


def norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(h).lower())


@dataclass
class RawTable:
    file: str
    sheet: str
    header_row: int                     # 1-based Excel row of the header
    headers: list[str]
    rows: list[tuple[int, dict[str, str]]]  # (excel row, header → text)
    sha256: str
    blank_rows: int = 0
    notes: list[str] = field(default_factory=list)


def _cell_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _header_score(cells: list[str]) -> int:
    syn = {norm_header(s) for _, _, syns in FIELDS.values() for s in syns}
    return sum(1 for c in cells if c and norm_header(c) in syn)


def read_table(src: str | Path | bytes, filename: str | None = None, sheet: str | None = None) -> RawTable:
    data = src if isinstance(src, bytes) else Path(src).read_bytes()
    name = filename or (Path(src).name if not isinstance(src, bytes) else "upload.xlsx")
    sha = hashlib.sha256(data).hexdigest()
    sheets: list[tuple[str, list[list[str]]]] = []
    if data[:2] == b"PK":
        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            for ws in wb.worksheets:
                if sheet and ws.title != sheet:
                    continue
                sheets.append((ws.title, [[_cell_text(v) for v in r] for r in ws.iter_rows(values_only=True)]))
        except Exception as e:
            raise ValueError(f"'{name}' is not a readable .xlsx workbook ({type(e).__name__})") from e
    elif data[:4] == b"\xd0\xcf\x11\xe0":
        raise ValueError(f"'{name}' is a legacy .xls file — save it as .xlsx and upload again")
    else:
        text = None
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if not text or "\x00" in text:
            raise ValueError(f"'{name}' is not an .xlsx or CSV file")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        sheets.append(("CSV", [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect)]))

    best = None  # (score, sheet, header_row_idx, rows)
    for title, rows in sheets:
        for i, r in enumerate(rows[:25]):
            s = _header_score(r)
            if best is None or s > best[0]:
                best = (s, title, i, rows)
    if best is None or best[0] == 0:
        raise ValueError("No sheet with a recognisable header row (expected columns like Tag Number, I/O Type, Cable, Pair)")
    _, title, hi, rows = best

    headers: list[str] = []
    seen: dict[str, int] = {}
    for j, h in enumerate(rows[hi]):
        h = h or f"Column {j + 1}"
        if h in seen:
            seen[h] += 1
            h = f"{h} ({seen[h]})"
        else:
            seen[h] = 1
        headers.append(h)

    out: list[tuple[int, dict[str, str]]] = []
    blank = 0
    for k, r in enumerate(rows[hi + 1:], start=hi + 2):
        if not any(c for c in r):
            blank += 1
            continue
        rec = {headers[j]: (r[j] if j < len(r) else "") for j in range(len(headers))}
        out.append((k, rec))
    return RawTable(file=name, sheet=title, header_row=hi + 1, headers=headers, rows=out, sha256=sha, blank_rows=blank)


def auto_map(headers: list[str], overrides: dict[str, str | None] | None = None) -> list[ColumnMapping]:
    """Map canonical fields to source headers. Exact synonym matches win; then fuzzy; one header per field."""
    overrides = overrides or {}
    normed = {h: norm_header(h) for h in headers}
    candidates: list[tuple[float, int, str, str]] = []  # (score, -priority, field, header)
    for f, (_, _, syns) in FIELDS.items():
        for pri, syn in enumerate(syns):
            ns = norm_header(syn)
            for h, nh in normed.items():
                if not nh:
                    continue
                score = 100.0 if nh == ns else fuzz.ratio(nh, ns)
                if score >= FUZZY_THRESHOLD:
                    candidates.append((score, -pri, f, h))
    candidates.sort(key=lambda c: (-c[0], -c[1]))
    chosen: dict[str, tuple[str, float]] = {}
    used: set[str] = set()
    for f, h in overrides.items():
        if h and h in normed:
            chosen[f] = (h, 1.0)
            used.add(h)
    for score, _, f, h in candidates:
        if f in chosen or f in overrides or h in used:
            continue
        chosen[f] = (h, round(score / 100.0, 2))
        used.add(h)
    result = []
    for f, (label, req, _) in FIELDS.items():
        src, conf = chosen.get(f, (None, 0.0))
        result.append(ColumnMapping(field=f, label=label, source=src, confidence=conf, required=req,
                                    overridden=f in overrides))
    return result


def mapping_dict(mapping: list[ColumnMapping]) -> dict[str, str]:
    return {m.field: m.source for m in mapping if m.source}
