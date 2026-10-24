"""The 8 surprise-dataset drill files (data/drills/README_drills.md) run headlessly through the real Service."""
from __future__ import annotations

import pytest

from xio.drills import run_all


@pytest.fixture(scope="module")
def results():
    return run_all()


def test_every_drill_passes(results):
    failed = [(r.name, r.crashed or [c for c in r.checks if not c[1]]) for r in results if not r.passed]
    assert not failed, failed


def test_drill_basics(results):
    for r in results:
        assert not r.crashed, (r.name, r.crashed)
        assert r.violations == 0 and r.export_ok and r.explained == r.live, r.name


def test_drill_a_single_project_tq_for_defaults(results):
    a = next(r for r in results if r.name.startswith("A "))
    assert [c for c in a.checks if c[0].startswith("ONE project-level")][0][1]


def test_note_row_is_ignored_not_quarantined(results):
    b = next(r for r in results if r.name.startswith("B "))
    assert "Missing tag" not in b.extra["cats"]
