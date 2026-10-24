"""The solver warm-up runs off the request path and never takes the server down."""
from __future__ import annotations

import threading
import time

import pytest

from app import warmup


def test_warm_solver_imports_and_solves():
    assert warmup.warm_solver() >= 0 and warmup.is_warm()


def test_start_background_returns_at_once_and_runs_the_follow_up(monkeypatch):
    gate, seen = threading.Event(), []
    monkeypatch.setattr(warmup, "precompile", lambda: None)
    monkeypatch.setattr(warmup, "warm_solver", lambda: (gate.wait(5), 0.0)[1])
    t0 = time.perf_counter()
    th = warmup.start_background(lambda: seen.append("demo"))
    assert time.perf_counter() - t0 < 0.5 and th.daemon and th.is_alive() and seen == []     # not blocked by the slow warm-up
    gate.set()
    th.join(5)
    assert seen == ["demo"]


def test_a_failing_warm_up_is_swallowed_and_the_follow_up_still_runs(monkeypatch):
    def boom():
        raise RuntimeError("no ortools")
    seen = []
    monkeypatch.setattr(warmup, "precompile", lambda: None)
    monkeypatch.setattr(warmup, "warm_solver", boom)
    warmup.start_background(lambda: seen.append("demo")).join(5)
    assert seen == ["demo"]


@pytest.mark.parametrize("value,on", [("0", False), ("false", False), ("off", False), ("1", True), ("", True)])
def test_env_switch(monkeypatch, value, on):
    monkeypatch.setenv("OPTISLOT_WARMUP", value)
    assert warmup.enabled() is on


def test_precompile_runs_the_warm_up_in_a_child_process():
    t0 = time.perf_counter()
    warmup.precompile()                      # must not raise, whatever the child does
    assert time.perf_counter() - t0 < 120
