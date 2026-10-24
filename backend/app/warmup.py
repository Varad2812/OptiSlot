"""Warm the CP-SAT solver in the background so the first Allocate is as fast as the hundredth.

The first import of ortools on a freshly synced venv compiles its bytecode and loads the native libraries (measured ~15-20 s;
~0.3 s afterwards). Without this, that cost lands inside the first allocation. `start_background` does it on a daemon thread
at app start, so the server accepts requests at once; `python -m app.warmup` does the same from the shell (`make demo` and
scripts/start_demo.sh call it while the frontend builds). OPTISLOT_WARMUP=0 turns the background behaviour off."""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("optislot.warmup")
_done = threading.Event()


def enabled() -> bool:
    return os.environ.get("OPTISLOT_WARMUP", "1").strip().lower() not in ("0", "false", "no", "off")


def is_warm() -> bool:
    return _done.is_set()


def warm_solver() -> float:
    """Import the optimiser (and with it ortools) and solve a tiny model with the production solver settings. Seconds taken."""
    t0 = time.perf_counter()
    from engine import optimise  # noqa: F401  (pulls in ortools.sat and the model builder)
    from ortools.sat.python import cp_model

    m = cp_model.CpModel()
    x = [m.NewBoolVar(f"x{i}") for i in range(4)]
    m.Add(sum(x) == 2)
    m.Minimize(sum((i + 1) * v for i, v in enumerate(x)))
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = 1
    s.parameters.num_workers = 1
    s.parameters.random_seed = 42
    s.Solve(m)
    _done.set()
    return time.perf_counter() - t0


def precompile() -> None:
    """Compile and cache ortools' bytecode in a CHILD process. Compiling inside the server holds the GIL for seconds at a time
    and starves the event loop (measured: the server took 11.7 s to answer its first request); a child process cannot."""
    subprocess.run([sys.executable, "-m", "app.warmup"], cwd=Path(__file__).resolve().parents[1], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)


def start_background(after: Callable[[], object] | None = None) -> threading.Thread:
    """Warm the solver on a daemon thread, then call `after` (e.g. allocate the demo project). Never raises, never blocks. The bytecode
    compile runs in a child process (see precompile) so it cannot hold the GIL against the server."""
    def work() -> None:
        try:
            t0 = time.perf_counter()
            precompile()                      # the slow part, off this process; the import below is then ~0.3 s
            log.info("CP-SAT warm-up finished in %.1f s", warm_solver() + time.perf_counter() - t0)
        except Exception as e:  # noqa: BLE001  (warm-up is an optimisation: greedy still works without it)
            log.warning("CP-SAT warm-up failed: %s: %s", type(e).__name__, e)
        if after is not None:
            try:
                after()
            except Exception as e:  # noqa: BLE001
                log.warning("background start-up step failed: %s: %s", type(e).__name__, e)

    t = threading.Thread(target=work, name="optislot-warmup", daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    print(f"CP-SAT solver warm in {warm_solver():.1f} s")
