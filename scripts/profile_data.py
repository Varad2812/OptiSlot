"""Print a data profile of an IO MDB and save it as markdown.

Usage: uv run --project backend python scripts/profile_data.py [mdb.xlsx] [out.md]
"""
from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MDB = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "docs" / "data_profile.md"

COLS = {
    "room": "Technical Room (Signal Location 2)",
    "area": "Design Area",
    "tag": "Tag Number",
    "inst": "Instrument Type",
    "inst_desc": "Instrument Type Description",
    "equip": "Equipment Name",
    "status": "Status",
    "io": "I/O Type Name",
    "sig": "Signal Type",
    "level": "Signal Level",
    "cable_spec": "Multi-cable / Cable",
    "cable": "Multipair Cable No.",
    "pair": "Pair Number",
    "group": "IO Grouping",
}
FAMILY = {"A": "A", "A-CONTROL": "A", "B": "B", "B-ALARM": "B"}


def cable_size(spec: str) -> int | None:
    m = re.match(r"\s*0*(\d+)\s*([PT])X", spec or "", re.I)
    return int(m.group(1)) if m else None


def pair_no(p: str) -> int | None:
    m = re.search(r"(\d+)", p or "")
    return int(m.group(1)) if m else None


def table(counter: Counter, h1: str, h2: str = "count") -> str:
    lines = [f"| {h1} | {h2} |", "|---|---|"]
    for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0]))):
        lines.append(f"| `{k}` | {v} |")
    return "\n".join(lines)


def main() -> None:
    df = pd.read_excel(MDB, sheet_name=0, dtype=str).fillna("")
    d = pd.DataFrame({k: df[v].str.strip() if v in df else "" for k, v in COLS.items()})
    d["excel_row"] = d.index + 2
    d["key"] = d["tag"].map(lambda s: re.sub(r"\s+", "", s))
    d["size"] = d["cable_spec"].map(cable_size)
    d["pair_n"] = d["pair"].map(pair_no)
    d["family"] = d["group"].map(lambda g: FAMILY.get(g, "-"))
    live = d[d["status"].str.upper() != "DELETED"]

    out: list[str] = [f"# Data profile — `{MDB.name}`", ""]
    out.append(f"- Sheet `{pd.ExcelFile(MDB).sheet_names[0]}`: **{len(df)} rows × {df.shape[1]} columns**")
    out.append(f"- Live rows (status ≠ DELETED): **{len(live)}**")
    out.append(f"- Distinct tag keys: {d['key'].nunique()} (duplicates: {int(d['key'].duplicated().sum())})")
    out.append("")

    for title, col in [("Status", "status"), ("IO types (raw)", "io"), ("Signal types", "sig"),
                       ("Signal levels", "level"), ("Rooms", "room"), ("Design areas", "area"),
                       ("Cable specs", "cable_spec"), ("IO Grouping / segregation", "group")]:
        out += [f"## {title}", "", table(Counter(d[col]), col), ""]

    out += ["## Instrument types per IO type", "", "| IO type | instrument types |", "|---|---|"]
    for io, g in d.groupby("io"):
        c = Counter(g["inst"])
        out.append(f"| `{io}` | " + ", ".join(f"{k}×{v}" for k, v in c.most_common()) + " |")
    out.append("")

    out += ["## Cables", "", "| cable | spec | size | used pairs | max pair | families | IO types | groups |",
            "|---|---|---|---|---|---|---|---|"]
    for cab, g in live.groupby("cable", sort=False):
        fams = sorted(set(g["family"]) - {"-"})
        out.append(f"| `{cab}` | {g['cable_spec'].iloc[0]} | {g['size'].iloc[0]} | {len(g)} | "
                   f"{g['pair_n'].max()} | {','.join(fams) or '-'} | {','.join(sorted(set(g['io'])))} | "
                   f"{','.join(sorted(set(g['group'])))} |")
    out.append("")

    issues: list[str] = []
    mixed = [c for c, g in live.groupby("cable") if {"A", "B"} <= set(g["family"])]
    issues.append(f"- Cables with BOTH A and B family signals: {mixed or 'none'}")
    miss = live[(live["cable"].isin(["", "-"])) | (live["pair_n"].isna() & ~live["cable"].str.contains("Internal", case=False))]
    issues.append(f"- Live rows missing cable or pair: {len(miss)} (excel rows {list(miss['excel_row'])})")
    dup = live[live.duplicated(["cable", "pair"], keep=False) & ~live["cable"].isin(["", "-", "Internal Wiring"])]
    issues.append(f"- Duplicate cable+pair: {len(dup)} {list(zip(dup['cable'], dup['pair']))}")
    over = live[live["pair_n"].notna() & live["size"].notna() & (live["pair_n"] > live["size"])]
    issues.append(f"- Pair number > cable size: {len(over)}")
    internal = live[live["cable"].str.contains("Internal", case=False) | live["equip"].str.contains(r"-DC[MS]-", regex=True)]
    issues.append(f"- Cabinet-alarm candidates (internal wiring or equipment = cabinet): {len(internal)} → equipment "
                  f"{sorted(set(internal['equip']))}")
    deleted = d[d["status"].str.upper() == "DELETED"]
    issues.append(f"- DELETED rows: {list(deleted['tag'])}")
    unknown_do = live[live["io"].isin(["DO", "DOR"]) & ~live["inst"].isin(["XYV", "ZYV", "XA", "ZLO", "MHL", "MXA", "MXL", "QAX"])]
    issues.append(f"- DO rows with instrument type outside the default hardware lists: {len(unknown_do)}")
    rooms = defaultdict(set)
    for _, r in live.iterrows():
        rooms[(r["room"], r["area"])].add(r["cable"])
    issues.append("- Controller domains (room, area) → cables: "
                  + "; ".join(f"{k[0]} / {k[1]}: {len(v)} cables" for k, v in rooms.items()))
    out += ["## Findings for pre-flight", ""] + issues + [""]

    text = "\n".join(out)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
