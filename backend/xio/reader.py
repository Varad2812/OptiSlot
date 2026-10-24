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
SOURCE_COL = "Source file"

FIELDS: dict[str, tuple[str, bool, list[str]]] = {
    "tag": ("Tag", True, ["Tag Number", "Tag No", "TagNo", "Tag", "Tag Name", "TagNumber", "Instrument Tag",
                                    "Signal Name", "IO Signal Name", "Signal Tag", "Signal ID"]),
    "status": ("Status", False, ["Status", "Tag Status", "Revision Status", "Line Status", "Signal Status"]),
    "io_type": ("IO type", True, ["I/O Type Name", "IO Type", "I/O Type", "IOType", "IO Type Name", "Signal IO Type",
                                         "Type of IO", "IO Signal Type"]),
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
    "cable": ("Cable no.", True, ["Multipair Cable No.", "Multipair Cable No", "Cable No", "Cable No.", "Cable Number", "Multipair Cable", "Field Cable No", "Cable",
                                "Cbl", "Cable Ref"]),
    "pair": ("Pair", True, ["Pair Number", "Pair", "Pair No", "Pair No.", "Field Cable Pair", "Core",
                                "Core No", "Cable Core"]),
    "group": ("IO grouping / segregation", False, ["IO Grouping", "Segregation", "Group", "IO Group", "Segregation Group"]),
    "loop_name": ("Loop name", False, ["Loop Name", "Loop"]),
    "old_tag": ("Old tag", False, ["Old Tag Number", "Old Tag", "Previous Tag"]),
    "system2": ("System 2", False, ["System 2"]),
    "section": ("Section / sub unit", False, ["Section / Sub Unit", "Section", "Sub Unit"]),
}

FUZZY_THRESHOLD = 82            # optional fields: only near-exact header matches
FUZZY_REQUIRED = 60             # required fields: a best-effort guess beats no allocation (flagged below CONFIRM_BELOW)
CONFIRM_BELOW = 0.70            # mapped with less confidence than this → needs_confirmation
HEADER_SCAN_ROWS = 25


def norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(h).lower())


# ── value inference (last resort for REQUIRED fields with no confident header match) ──
IO_VOCAB = {"AI", "AO", "DI", "DO", "AIR", "AOR", "DIR", "DOR"}      # what an IO-type column holds (R forms pass through)
INFER_SAMPLE = 400                # rows looked at per column
INFER_MIN_SCORE = 0.75            # a column must look this much like the field before it is proposed
INFER_VETO_BELOW = 0.30           # a fuzzy header match whose values score under this is dropped (the values contradict the name)
INFER_TIE = 0.03                  # two columns this close are ambiguous → neither is taken
INFERRED_FIELDS = ("io_type", "pair", "tag", "cable")                # order matters: cable needs the pair column
_PAIR_RX = re.compile(r"^(?:pair|triad|core|p)?\s*#?\s*(\d{1,3})$", re.I)


def _values(rows: list[dict[str, str]], header: str) -> list[str]:
    out = []
    for r in rows[:INFER_SAMPLE]:
        v = (r.get(header) or "").strip()
        if v and v != "-":
            out.append(v)
    return out


def _io_score(vs: list[str]) -> float:
    if len(vs) < 3 or len(set(vs)) > 12:
        return 0.0
    hit = sum(1 for v in vs if re.sub(r"[\s/]", "", v).upper() in IO_VOCAB) / len(vs)
    return hit if hit >= 0.8 else 0.0


def _pair_score(vs: list[str]) -> float:
    if len(vs) < 3:
        return 0.0
    nums = [m for v in vs if (m := _PAIR_RX.match(v))]
    hit = len(nums) / len(vs)
    ints = [int(m.group(1)) for m in nums]
    if hit < 0.8 or not ints or max(ints) > 200:
        return 0.0
    plain = all(v.isdigit() for v in vs)
    if plain and len(vs) >= 10 and len(set(ints)) == len(ints) and sorted(ints) == list(range(min(ints), min(ints) + len(ints))):
        return 0.0                                  # 1, 2, 3 … N once each: a serial-number column, not pairs
    prefixed = sum(1 for v in vs if not v.isdigit()) / len(vs)
    return hit * (1.0 if prefixed > 0.5 else 0.8)


def _tag_score(vs: list[str]) -> float:
    if len(vs) < 5:
        return 0.0
    uniq = len({re.sub(r"\s+", "", v) for v in vs}) / len(vs)
    mixed = sum(1 for v in vs if re.search(r"[A-Za-z]", v) and re.search(r"\d", v)) / len(vs)
    avg = sum(len(v) for v in vs) / len(vs)
    if uniq < 0.95 or mixed < 0.8 or not 4 <= avg <= 40:
        return 0.0
    short = sum(1 for v in vs if len(v.split()) <= 2) / len(vs)     # a tag is one or two tokens; a service description is a phrase
    return 0.4 * uniq + 0.2 * mixed + 0.2 * (sum(1 for v in vs if "-" in v) / len(vs)) + 0.2 * short


def _cable_score(rows: list[dict[str, str]], header: str, pair_header: str | None) -> float:
    vs = _values(rows, header)
    if len(vs) < 5:
        return 0.0
    shape = sum(1 for v in vs if re.search(r"[A-Za-z]", v) and re.search(r"\d", v)) / len(vs)
    distinct = len(set(vs))
    if shape < 0.8 or distinct < 2 or distinct > 0.7 * len(vs):
        return 0.0                                  # cables repeat (one row per pair) but are not a single constant
    if not pair_header:
        return 0.55 if distinct <= 0.5 * len(vs) else 0.0
    combos = [((r.get(header) or "").strip(), (r.get(pair_header) or "").strip()) for r in rows[:INFER_SAMPLE]
              if (r.get(header) or "").strip() and (r.get(pair_header) or "").strip()]
    if not combos:
        return 0.0
    unique = len(set(combos)) / len(combos)         # a pair number is used once per cable; a room or area repeats it
    return 0.5 + 0.5 * unique if unique >= 0.97 else 0.0


def _field_score(field: str, rows: list[dict[str, str]], header: str, pair_header: str | None = None) -> float:
    if field == "cable":
        return _cable_score(rows, header, pair_header)
    vs = _values(rows, header)
    return {"io_type": _io_score, "pair": _pair_score, "tag": _tag_score}[field](vs)



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


def _mapping_score(cells: list[str], body: list[list[str]] | None = None) -> tuple[float, int]:
    """How well a candidate header row maps: Σ confidence of mapped fields (+1 per required field) and #required mapped.
    `body` (the rows under it) lets unrecognised headers still score through their values."""
    headers = [c for c in cells if c]
    if len(headers) < 2:
        return 0.0, 0
    recs = [{h: r[j] if j < len(r) else "" for j, h in enumerate(cells) if h} for r in (body or [])[:INFER_SAMPLE] if any(r)]
    if recs and sum(1 for h in headers if any(r.get(h) == h for r in recs)) >= max(2, 0.3 * len(headers)):
        return 0.0, 0                                # its cells repeat verbatim in their own columns below: this is a data row
    m = auto_map(headers, rows=recs or None)
    got = [x for x in m if x.source]
    req = sum(1 for x in got if x.required)
    return sum(x.confidence for x in got) + req, req


def _candidate_rows(rows: list[list[str]]) -> list[int]:
    """Header-row candidates in a sheet: rows with exact synonym hits, else the most text-heavy rows."""
    scan = rows[:HEADER_SCAN_ROWS]
    exact = sorted(((_header_score(r), -i) for i, r in enumerate(scan)), reverse=True)
    out = [-i for sc, i in exact if sc > 0][:4]
    if not out:  # no exact synonym anywhere: try the most text-heavy rows (fuzzy header names)
        def texty(r: list[str]) -> int:
            return sum(1 for c in r if c and not c.replace(".", "", 1).replace("-", "", 1).isdigit())
        ranked = sorted(range(len(scan)), key=lambda i: (-texty(scan[i]), i))
        out = [i for i in ranked[:3] if texty(scan[i]) >= 3]
    return out


def _choose_sheet(sheets: list[tuple[str, list[list[str]]]]) -> tuple[str, int, list[list[str]], list[str]]:
    """Pick the (sheet, header row) with the best column-mapping score; ties go to the sheet with more data rows."""
    scored = []
    for title, rows in sheets:
        for i in _candidate_rows(rows):
            sc, req = _mapping_score(rows[i], rows[i + 1:i + 1 + INFER_SAMPLE])
            data = sum(1 for r in rows[i + 1:] if any(r))
            scored.append((sc, data, -len(scored), req, title, i, rows))
    scored = [x for x in scored if x[3] >= 1]
    if not scored:
        raise ValueError("No sheet with a recognisable header row (expected columns like Tag Number, I/O Type, Cable, Pair)")
    sc, data, _, req, title, i, rows = max(scored, key=lambda x: (x[0], x[1], x[2]))
    notes = [f"Sheet '{title}', header row {i + 1} (mapping score {sc:.1f}, {data} data rows)"]
    others = {x[4] for x in scored if x[4] != title}
    if others:
        notes.append("Other sheet(s) ignored: " + ", ".join(f"'{t}'" for t in sorted(others)))
    return title, i, rows, notes


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
            first = text.splitlines()[0] if text.strip() else ""
            delim = max(",;\t|", key=first.count)
            dialect = csv.excel if first.count(delim) == 0 else type("D", (csv.excel,), {"delimiter": delim})
        sheets.append(("CSV", [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect)]))

    title, hi, rows, notes = _choose_sheet(sheets)

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
    return RawTable(file=name, sheet=title, header_row=hi + 1, headers=headers, rows=out, sha256=sha, blank_rows=blank,
                    notes=notes)


def auto_map(headers: list[str], overrides: dict[str, str | None] | None = None,
             rows: list[dict[str, str]] | None = None) -> list[ColumnMapping]:
    """Map canonical fields to source headers. Exact synonym matches win; then fuzzy; one header per field.

    With `rows` (header → text records) a REQUIRED field that has no confident header match (none, or under CONFIRM_BELOW) is also
    looked for in the VALUES: an IO column that holds AI/AO/DI/DO, a pair column of "Pair 3" / small integers, a column of unique
    tag-like strings, a repeating cable column whose (cable, pair) is unique. A header match whose values contradict the field is
    dropped. Value-based mappings are never confident: confidence ≤ 0.60, needs_confirmation, inferred_from_values."""
    overrides = overrides or {}
    normed = {h: norm_header(h) for h in headers}
    candidates: list[tuple[float, int, str, str]] = []  # (score, -priority, field, header)
    for f, (_, req, syns) in FIELDS.items():
        floor = FUZZY_REQUIRED if req else FUZZY_THRESHOLD
        for pri, syn in enumerate(syns):
            ns = norm_header(syn)
            for h, nh in normed.items():
                if not nh:
                    continue
                score = 100.0 if nh == ns else fuzz.ratio(nh, ns)
                if score >= floor:
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

    inferred: set[str] = set()
    if rows:
        pair_of: dict[str, str | None] = {}

        def weak(f: str) -> bool:
            return FIELDS[f][1] and f not in overrides and (f not in chosen or chosen[f][1] < CONFIRM_BELOW)

        for f in INFERRED_FIELDS:                 # a fuzzy header whose values contradict it is dropped
            if f in chosen and f not in overrides and chosen[f][1] < 1.0 and FIELDS[f][1]:
                h, conf = chosen[f]
                pair_h = chosen["pair"][0] if "pair" in chosen else None
                if _field_score(f, rows, h, pair_h) < (INFER_VETO_BELOW if conf >= CONFIRM_BELOW else 0.5):
                    del chosen[f]
                    used.discard(h)
        for f in INFERRED_FIELDS:
            if not weak(f):
                continue
            pair_h = chosen["pair"][0] if "pair" in chosen else None
            if f in chosen:                       # a weak header match whose values agree stays (and stays "to confirm")
                continue
            scored = sorted(((_field_score(f, rows, h, pair_h), h) for h in headers if h and h not in used), reverse=True)
            if scored and scored[0][0] >= INFER_MIN_SCORE and (len(scored) < 2 or scored[0][0] - scored[1][0] > INFER_TIE):
                s, h = scored[0]
                chosen[f] = (h, round(0.30 + 0.30 * s, 2))
                used.add(h)
                inferred.add(f)
    result = []
    for f, (label, req, _) in FIELDS.items():
        src, conf = chosen.get(f, (None, 0.0))
        result.append(ColumnMapping(field=f, label=label, source=src, confidence=conf, required=req,
                                    overridden=f in overrides, inferred_from_values=f in inferred,
                                    needs_confirmation=f not in overrides and ((bool(src) and conf < CONFIRM_BELOW) or (req and not src))))
    return result


def map_table(table: RawTable, overrides: dict[str, str | None] | None = None) -> list[ColumnMapping]:
    """auto_map with the table's own rows, so required fields can fall back on their values."""
    return auto_map(table.headers, overrides, rows=[rec for _, rec in table.rows])


def mapping_dict(mapping: list[ColumnMapping]) -> dict[str, str]:
    return {m.field: m.source for m in mapping if m.source}


def unmapped_mapping() -> list[ColumnMapping]:
    """Every field unmapped — the fallback when the mapper itself fails."""
    return [ColumnMapping(field=f, label=label, required=req) for f, (label, req, _) in FIELDS.items()]


def merge_tables(tables: list[RawTable]) -> RawTable:
    """Several MDB files → one table with canonical headers (each file mapped on its own) plus a 'Source file' column
    ('A.xlsx:12') so every row, TQ and duplicate tag can be traced to its file. Only fields some file maps are kept."""
    canon = {f: syns[0] for f, (_, _, syns) in FIELDS.items()}
    maps = [mapping_dict(map_table(t)) for t in tables]
    fields = [f for f in FIELDS if any(f in m for m in maps)]
    headers = [canon[f] for f in fields] + [SOURCE_COL]
    rows: list[tuple[int, dict[str, str]]] = []
    for t, m in zip(tables, maps):
        for r, rec in t.rows:
            out = {canon[f]: rec.get(m[f], "") if f in m else "" for f in fields}
            out[SOURCE_COL] = f"{t.file}:{r}"
            rows.append((len(rows) + 2, out))
    sha = hashlib.sha256("".join(t.sha256 for t in tables).encode()).hexdigest()
    return RawTable(file=" + ".join(t.file for t in tables), sheet="merged", header_row=1, headers=headers, rows=rows, sha256=sha,
                    notes=[f"Merged {len(tables)} files: " + ", ".join(f"{t.file} ({len(t.rows)} rows)" for t in tables)])
