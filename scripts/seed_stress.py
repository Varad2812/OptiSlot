"""Create the `stress10k` project (a 10,000-signal synthetic MDB) so the UI can be checked at scale.

Usage: uv run --project backend python scripts/seed_stress.py [--n 10000] [--seed 7] [--id stress10k]
Writes into the database named by OPTISLOT_DB (default: the app's DB). Idempotent: an existing project is kept.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.service import Service  # noqa: E402
from store.db import DEFAULT_DB, Store  # noqa: E402
from xio.synthetic import generate, to_xlsx  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--id", default="stress10k")
    a = ap.parse_args()
    svc = Service(Store(os.environ.get("OPTISLOT_DB", DEFAULT_DB)))
    if svc.store.get_project(a.id) is not None:
        print(f"{a.id}: already present")
        return
    headers, rows = generate(a.n, a.seed)
    svc.create_project(a.id, f"Stress — {a.n // 1000}k synthetic", to_xlsx(headers, rows), f"synthetic_{a.n}.xlsx")
    st = svc.get(a.id)  # allocates once so the first UI request is warm
    print(f"{a.id}: {st.current.kpis.signals if st.current else '?'} signals")


if __name__ == "__main__":
    main()
