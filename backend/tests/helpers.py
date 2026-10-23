"""Test helpers: build MDB tables in memory."""
from __future__ import annotations

import hashlib
import json

from xio.reader import RawTable

HEADERS = ["Technical Room (Signal Location 2)", "Design Area", "Tag Number", "Instrument Type", "Equipment Name",
           "Status", "I/O Type Name", "Signal Type", "Signal Level", "Multi-cable / Cable", "Multipair Cable No.",
           "Pair Number", "IO Grouping", "OA No.", "WBS", "Tag Service 1 and 2", "Location", "Execution"]


def row(tag: str, io: str, cable: str, pair: int | str | None, size: int = 24, group: str = "-", room: str = "PIB-30",
        area: str = "RA 320-01", inst: str = "PT", status: str = "New", equipment: str = "-", sig: str = "4-20 ma HART",
        level: str = "2-Wire", spec: str | None = None) -> dict[str, str]:
    return {
        "Technical Room (Signal Location 2)": room, "Design Area": area, "Tag Number": tag, "Instrument Type": inst,
        "Equipment Name": equipment, "Status": status, "I/O Type Name": io, "Signal Type": sig, "Signal Level": level,
        "Multi-cable / Cable": spec if spec is not None else f"{size:02d}PX1MM2/FR/ARM/NIS", "Multipair Cable No.": cable,
        "Pair Number": "" if pair is None else (pair if isinstance(pair, str) else f"Pair {pair}"),
        "IO Grouping": group, "OA No.": "OA-11", "WBS": "320", "Tag Service 1 and 2": f"svc {tag}", "Location": "L",
        "Execution": "NON-IS",
    }


def table(rows: list[dict[str, str]], headers: list[str] | None = None) -> RawTable:
    headers = headers or HEADERS
    data = [(i + 2, {h: str(r.get(h, "")) for h in headers}) for i, r in enumerate(rows)]
    sha = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    return RawTable(file="synthetic.xlsx", sheet="MDB", header_row=1, headers=headers, rows=data, sha256=sha)
