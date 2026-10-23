"""Read any allocation workbook back in and verify it (ours, a hand-edited copy, or the reference)."""
from __future__ import annotations

import hashlib
import io
from pathlib import Path

import openpyxl

from app.ruleslang import catalog
from app.schemas import ProjectSettings, RuleCheckReport, RuleSet, Signal, TQ, CheckResult, Violation
from verify.checks import verify_rows


def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def read_allocation(src: str | Path | bytes) -> tuple[list[dict[str, str]], list[str], str, str]:
    """→ (rows, missing template columns, sheet name, sha256). Finds the sheet whose header has 'Tag Status'."""
    data = src if isinstance(src, bytes) else Path(src).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    want = catalog()["template"]["columns"]
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True)
        for hi in range(10):
            try:
                hdr = [_text(h) for h in next(it)]
            except StopIteration:
                break
            if "Tag Status" in hdr:
                idx = {h: i for i, h in enumerate(hdr) if h}
                rows = []
                for r in it:
                    vals = [_text(v) for v in r]
                    if not any(vals):
                        continue
                    rows.append({h: (vals[i] if i < len(vals) else "") for h, i in idx.items()})
                missing = [c for c in want if c not in idx]
                return rows, missing, ws.title, sha
    raise ValueError("no sheet with a 'Tag Status' header found")


def verify_xlsx(src: str | Path | bytes, signals: list[Signal], rs: RuleSet, settings: ProjectSettings,
                tqs: list[TQ] | None = None, filename: str | None = None) -> RuleCheckReport:
    name = filename or (Path(src).name if not isinstance(src, bytes) else "upload.xlsx")
    try:
        rows, missing, _, _ = read_allocation(src)
    except Exception as e:
        return RuleCheckReport(source="file", file=name, checks=[CheckResult(
            id="C00", label="Workbook is a readable allocation", failed=1,
            violations=[Violation(message=f"cannot read workbook: {e}")])], checks_total=1, checks_passed=0,
            violations=1, verdict="FAIL")
    return verify_rows(rows, signals, rs, settings, tqs, source="file", file=name, missing_columns=missing)
