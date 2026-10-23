"""Column fidelity vs the reference workbook.

For every tag present in BOTH our allocation and the reference answer, compare every NON-address column
(terminals, signal type/level, IS, equipment, service, location, loop typical, instrument type, loop name,
section, old tag, remarks, revision, DSTName, …) and report % match per column + every mismatch.
Address columns (cabinet / CIOC / baseplate / channel …) are reported separately and are informative only:
the reference is hand-placed.

Usage: uv run --project backend python scripts/fidelity.py [--mdb …] [--ref …] [--out docs/fidelity_report.md]
       [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import openpyxl  # noqa: E402

from engine.pipeline import run  # noqa: E402
from xio.render import columns  # noqa: E402

ADDRESS = ["Sr. No.", "System Cabinet", "Controller", "Electronic/ Marshalling Cabinet", "CIOC/CSLS Name", "Baseplate",
           "Channel_No", "CHARM_No", "Cabinet Side (F/R)", "Cabinet Name for Visualization"]
COMPARED_STATUSES = ("Field", "Cabinet Alarm")   # wired-spare tags are address-derived names, not MDB tags
MAX_LISTED = 12


def norm(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s or "-"


def key(tag: str) -> str:
    return re.sub(r"\s+", "", tag or "")


def read_reference(path: Path) -> list[dict[str, str]]:
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    it = ws.iter_rows(values_only=True)
    head = [norm(h) for h in next(it)]
    return [{h: norm(v) for h, v in zip(head, r)} for r in it if any(v is not None for v in r)]


def compare(ours: list[dict[str, str]], ref: list[dict[str, str]]) -> dict:
    def index(rows):
        out = {}
        for r in rows:
            if r.get("Tag Status") in COMPARED_STATUSES and r.get("Tag Name", "-") != "-":
                out.setdefault(key(r["Tag Name"]), r)
        return out

    a, b = index(ours), index(ref)
    common = sorted(set(a) & set(b))
    cols = [c for c in columns() if c not in ADDRESS]
    stats: dict[str, dict] = {}
    for c in cols + ADDRESS:
        ok, bad = 0, []
        for k in common:
            got, exp = norm(a[k].get(c)), norm(b[k].get(c))
            if got == exp:
                ok += 1
            else:
                bad.append({"tag": b[k]["Tag Name"], "ours": got, "ref": exp})
        stats[c] = {"match": ok, "total": len(common), "pct": round(100 * ok / len(common), 1) if common else 100.0,
                    "mismatches": bad, "address": c in ADDRESS}
    non_addr = [stats[c] for c in cols]
    cells_ok = sum(s["match"] for s in non_addr)
    cells = sum(s["total"] for s in non_addr)
    return {"common": len(common), "only_ours": sorted(b_ for b_ in set(a) - set(b)),
            "only_ref": sorted(set(b) - set(a)), "columns": stats,
            "cells_pct": round(100 * cells_ok / cells, 2) if cells else 100.0,
            "columns_perfect": sum(1 for s in non_addr if s["match"] == s["total"]), "columns_total": len(non_addr)}


def explain(c: str) -> str:
    """Why a column is not 100% — each verified against every common row of the sample (see docs/fidelity_report.md)."""
    return {
        "Revision No": "Not derivable. The reference maps the same MDB `Revision #` + `Status` to different values "
                       "(e.g. `05B+`/New → `00` ×34 but `01` ×2; `04`/Modified → `01`, `02`). Ours is the project revision "
                       "(Rev A = `00`, Rev B = `01`), owned by the revision workflow.",
        "Remarks": "Hand-written revision history (e.g. `5B - New Tag Added`); the MDB `Revision Comments` uses other "
                   "wording, so no rule reproduces it. Cabinet-alarm remarks follow rule `r-alarm-bp` and match 12/12.",
        "Section / Sub Unit": "Not derivable — checked against all common rows. No MDB column determines it (the closest, "
                              "`Loop Name`, maps `500-M -G0001` to both `LOGISTIC` and `-`), and the loop-number pattern "
                              "fails (loop `40xxx` → `400`, `410` and `420`; `500-00xxx` → `LOGISTIC` or `-`). Kept `-`; "
                              "if an MDB has a Section column it is mapped and copied.",
        "Old Tag": "The MDB cell is empty; the reference has `0` (a hand entry).",
        "Field Cable No": "The reference wires this tag to another cable than the MDB says; the MDB is authoritative.",
        "Field Cable Size": "Follows from the different cable above.",
    }.get(c, "")


def rules_section(rs) -> list[str]:
    """The rules that carry the column fidelity, read from the rule set (so this section cannot drift from the data)."""
    by = {r.id: r for r in rs.rules}
    L = ["## Rules that produce these columns (from the rule set — no per-tag code)", ""]
    hw = next((r for r in rs.rules if r.type == "hardware_map" and r.enabled), None)
    if hw:
        L += [f"**Terminal table** (`{hw.id}.terminals`, first match wins; check C20):", "",
              "| IO type | Signal type | Signal level | TB | TB1 | TB2 | TB3 | Reference rows |", "|---|---|---|---|---|---|---|---:|"]
        for t in hw.params.get("terminals", []):
            w = t.get("when", {})
            L.append(f"| {w.get('io_type', '*')} | {w.get('signal_type', '*')} | {w.get('signal_level', '*')} | {w.get('tb', '*')} "
                     f"| {t.get('tb1')} | {t.get('tb2')} | {t.get('tb3')} | {t.get('learned', 'fallback')} |")
        L.append("")
    out = next((r for r in rs.rules if r.type == "output_map" and r.enabled), None)
    if out:
        L.append(f"**Pass-through columns** (`{out.id}`, check C17): " + ", ".join(f"{c} ← `{f}`" for c, f in out.params.get("columns", {}).items()) + ".")
        for st, cols in out.params.get("blank_for", {}).items():
            L.append(f"- Not copied for **{st}** rows (as in the reference): {', '.join(cols)}.")
        L.append("")
    al = next((r for r in rs.rules if r.type == "reserve_baseplate" and r.enabled), None)
    if al and isinstance(al.params.get("remarks"), list):
        L.append(f"**Cabinet-alarm remarks** (`{al.id}.remarks`): " + "; ".join(
            f"when {x.get('when')} → `{x.get('value')}`" for x in al.params["remarks"]) + "; otherwise `-`.")
        L.append("")
    for r in rs.rules:
        if r.type == "segregate" and r.enabled and (r.params.get("field") or "group") != "group":
            L.append(f"**{r.label}** (`{r.id}`, level {r.params.get('level')}, field `{r.params.get('field')}`, "
                     f"blank/unknown → {r.params.get('default_family')} + one TQ; check C07.x).")
    return L + [""]


def to_markdown(res: dict, before: dict | None = None, rs=None) -> str:
    L = ["# Column fidelity vs the reference allocation", "",
         "Generated by `scripts/fidelity.py` (sample MDB → engine → rendered rows, the same rows the Excel writer writes).",
         f"Compared **{res['common']}** tags present in both (Field + Cabinet Alarm). "
         f"Only in ours: {len(res['only_ours'])} {res['only_ours'][:5]} · only in the reference: {len(res['only_ref'])} {res['only_ref'][:5]}.",
         "",
         f"**Non-address cells matching: {res['cells_pct']}%** · columns at 100%: {res['columns_perfect']}/{res['columns_total']}"
         + (f" (before: {before['cells_pct']}% · {before['columns_perfect']}/{before['columns_total']})" if before else ""),
         "", "## Per column (non-address)", "",
         "| Column | Match | % |" + (" Before % |" if before else ""), "|---|---:|---:|" + ("---:|" if before else "")]
    for c, s in res["columns"].items():
        if s["address"]:
            continue
        b = f" {before['columns'][c]['pct']} |" if before and c in before["columns"] else (" |" if before else "")
        L.append(f"| {c.replace(chr(10), ' ')} | {s['match']}/{s['total']} | {s['pct']} |{b}")
    L += ["", "## Address columns (informative — the reference is hand-placed)", "", "| Column | Match | % |", "|---|---:|---:|"]
    for c, s in res["columns"].items():
        if s["address"]:
            L.append(f"| {c} | {s['match']}/{s['total']} | {s['pct']} |")
    if rs is not None:
        L += [""] + rules_section(rs)
    L += ["", "## Remaining mismatches (non-address)", ""]
    any_bad = False
    for c, s in res["columns"].items():
        if s["address"] or not s["mismatches"]:
            continue
        any_bad = True
        L.append(f"### {c.replace(chr(10), ' ')} — {len(s['mismatches'])} mismatch(es)")
        if explain(c):
            L.append(f"_{explain(c)}_")
        L += ["", "| Tag | Ours | Reference |", "|---|---|---|"]
        for m in s["mismatches"][:MAX_LISTED]:
            L.append(f"| `{m['tag']}` | {m['ours']} | {m['ref']} |")
        if len(s["mismatches"]) > MAX_LISTED:
            L.append(f"| … {len(s['mismatches']) - MAX_LISTED} more | | |")
        L.append("")
    if not any_bad:
        L.append("None.")
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mdb", default=str(ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx"))
    ap.add_argument("--ref", default=str(ROOT / "data" / "Sample_IO_Allocation_VIT_v2_1.xlsx"))
    ap.add_argument("--out", default=str(ROOT / "docs" / "fidelity_report.md"))
    ap.add_argument("--json", help="also write the raw result as JSON")
    ap.add_argument("--before", help="JSON from an earlier run, for a before/after column")
    a = ap.parse_args()
    out = run(a.mdb)
    res = compare(out.rows, read_reference(Path(a.ref)))
    before = json.loads(Path(a.before).read_text()) if a.before else None
    Path(a.out).write_text(to_markdown(res, before, out.rules.rs))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1))
    print(f"{res['common']} common tags · non-address cells {res['cells_pct']}% · "
          f"columns at 100% {res['columns_perfect']}/{res['columns_total']}")
    for c, s in res["columns"].items():
        if not s["address"] and s["pct"] < 100:
            print(f"  {s['pct']:6}%  {c!r}  e.g. {s['mismatches'][0]}")


if __name__ == "__main__":
    main()
