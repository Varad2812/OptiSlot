"""Generate a large or messy IO MDB for stress tests and hidden-test drills.

Usage: uv run --project backend python scripts/make_synthetic.py --n 10000 [--nasty] [--seed 7] [--out data/synthetic_10k.xlsx]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from xio.synthetic import generate, to_xlsx  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--domains", type=int, default=3)
    ap.add_argument("--nasty", action="store_true")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    out = a.out or ROOT / "data" / f"synthetic_{a.n}{'_nasty' if a.nasty else ''}.xlsx"
    headers, rows = generate(a.n, a.seed, a.nasty, a.domains)
    out.write_bytes(to_xlsx(headers, rows))
    print(f"wrote {out} — {len(rows)} rows × {len(headers)} columns{' (nasty)' if a.nasty else ''}")


if __name__ == "__main__":
    main()
