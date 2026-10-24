#!/usr/bin/env python3
"""Live database viewer for demos: shows what the backend writes to SQLite as you click in the app.

Run (second terminal, repo root):   python3 scripts/dbwatch.py
Other DB:                           OPTISLOT_DB=/tmp/demo.db python3 scripts/dbwatch.py
One snapshot and exit:              python3 scripts/dbwatch.py --once

Read-only: it never writes. SQLite is in WAL mode, so reading while the app writes is safe.
Rows that appeared since the last refresh are highlighted, so judges can SEE each click land in the database.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = Path(os.environ.get("OPTISLOT_DB", ROOT / "projects" / "optislot.db"))
ONCE = "--once" in sys.argv

B, DIM, GRN, YEL, CYN, RED, RST = "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[36m", "\033[31m", "\033[0m"
if ONCE or not sys.stdout.isatty():
    B = DIM = GRN = YEL = CYN = RED = RST = ""


def conn():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)


def rows(c, sql):
    try:
        return c.execute(sql).fetchall()
    except sqlite3.Error:
        return []


def j(s):
    try:
        return json.loads(s)
    except Exception:
        return {}


def short(s, n):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def render(c, seen: dict) -> str:
    out = []
    out.append(f"{B}OptiSlot database — live{RST}   {DIM}{DB}   {time.strftime('%H:%M:%S')}{RST}\n")

    counts = {t: rows(c, f"select count(*) from {t}")[0][0] for t in
              ("projects", "files", "rulesets", "runs", "decisions", "activity", "tq_history")}
    line = []
    for t, n in counts.items():
        new = n > seen.get(("count", t), n)
        line.append(f"{t} {(GRN + B) if new else CYN}{n}{RST}")
        seen[("count", t)] = n
    out.append("  ".join(line) + "\n")

    out.append(f"{B}Uploaded input files{RST}  (original bytes + sha256 stored)")
    for pid, name, kind, sha, size, ts in rows(c, "select project_id,name,kind,substr(sha256,1,12),length(data),ts from files order by ts desc limit 4"):
        out.append(f"  {DIM}{ts}{RST}  {pid:<8} {name:<10} {kind:<5} sha256 {sha}…  {size:,} bytes")

    out.append(f"\n{B}Runs{RST}  (every allocate/verify: hashes + verdict)")
    for (rid, pid, ts, data) in rows(c, "select run_id,project_id,ts,data from runs order by ts desc limit 5"):
        d = j(data)
        fresh = (GRN + B) if ("run", rid) not in seen and seen.get("primed") else ""
        seen[("run", rid)] = 1
        v = d.get("verdict", "?")
        col = GRN if v == "PASS" else RED
        out.append(f"  {fresh}{ts}{RST}  {rid}  rev {d.get('revision','?')}  {d.get('kind','?'):<9} {col}{v}{RST} "
                   f"{d.get('violations','?')} viol  {d.get('signals','?')} signals  {d.get('runtime_ms','?')} ms  "
                   f"{DIM}out {short(d.get('output_sha256',''),10)}{RST}")

    out.append(f"\n{B}Rule set versions{RST}  (each rule change = a new version)")
    for ver, ts, note in rows(c, "select version,ts,note from rulesets order by version desc limit 5"):
        fresh = (GRN + B) if ("rs", ver) not in seen and seen.get("primed") else ""
        seen[("rs", ver)] = 1
        out.append(f"  {fresh}v{ver:<3}{RST} {DIM}{ts}{RST}  {short(note, 80)}")

    out.append(f"\n{B}Decision log{RST}  (who changed what, and why — undoable)")
    for ts, data in rows(c, "select ts,data from decisions order by rowid desc limit 5"):
        d = j(data)
        key = ("dec", ts, d.get("why"))
        fresh = (GRN + B) if key not in seen and seen.get("primed") else ""
        seen[key] = 1
        out.append(f"  {fresh}{ts}{RST}  {d.get('who','?'):<9} {short(d.get('why',''), 80)}")

    out.append(f"\n{B}Activity feed{RST}")
    for ts, data in rows(c, "select ts,data from activity order by rowid desc limit 6"):
        d = j(data)
        key = ("act", ts, d.get("text"))
        fresh = (GRN + B) if key not in seen and seen.get("primed") else ""
        seen[key] = 1
        out.append(f"  {fresh}{ts}{RST}  {YEL}{d.get('kind','?'):<8}{RST} {short(d.get('text',''), 90)}")

    seen["primed"] = True
    out.append(f"\n{DIM}Ctrl+C to quit. Green = new since the last refresh.{RST}")
    return "\n".join(out)


def main():
    if not DB.exists():
        sys.exit(f"No database at {DB}. Start the app first (make demo).")
    seen: dict = {}
    c = conn()
    if ONCE:
        print(render(c, seen))
        return
    try:
        while True:
            text = render(c, seen)
            sys.stdout.write("\033[H\033[2J" + text + "\n")
            sys.stdout.flush()
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
