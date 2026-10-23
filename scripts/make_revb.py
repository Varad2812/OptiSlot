"""Build the deterministic Revision Gauntlet Rev B MDB from a Rev A MDB.

Usage: uv run --project backend python scripts/make_revb.py [data/Sample_IO_MDB_VIT_v2_1.xlsx] [--out data/RevB_gauntlet.xlsx]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from engine.pipeline import run  # noqa: E402
from xio.gauntlet import build  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mdb", nargs="?", type=Path, default=ROOT / "data" / "Sample_IO_MDB_VIT_v2_1.xlsx")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "RevB_gauntlet.xlsx")
    a = ap.parse_args()
    data = a.mdb.read_bytes()
    revb, steps = build(data, run(data))
    a.out.write_bytes(revb)
    print(f"wrote {a.out}")
    for s in steps:
        print(f"  {s.n}. {s.action:9} {s.tag:24} {s.detail}")


if __name__ == "__main__":
    main()
