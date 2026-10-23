"""Synthetic IO MDBs for stress tests and hidden-test drills (deterministic per seed).

nasty=True adds the hidden-test traps: renamed/reordered columns, blank rows, unknown IO types,
A+B on one cable, oversize pairs, duplicate tags and pairs, missing pairs, unknown DO types, junk text.
"""
from __future__ import annotations

import io
import random

import openpyxl

from xio.reader import RawTable

BASE_HEADERS = ["OA No.", "Technical Room (Signal Location 2)", "Design Area", "Tag Number", "Instrument Type",
                "Instrument Type Description", "Equipment Name", "WBS", "Status", "Location", "I/O Type Name", "Signal Type",
                "Execution", "External Power Supply", "Signal Level", "Multi-cable / Cable", "Multipair Cable No.",
                "Pair Number", "IO Grouping", "Tag Service 1 and 2", "Loop Name", "Old Tag Number", "System 2"]
NASTY_RENAMES = {"Tag Number": "TagNo", "I/O Type Name": "IO Type", "Multipair Cable No.": "Cable No", "Pair Number": "Pair",
                 "IO Grouping": "Segregation", "Technical Room (Signal Location 2)": "Technical Room", "Design Area": "Risk Area"}
INSTR = {"AI": [("PT", "Pressure Transmitter"), ("TT", "Temperature Transmitter"), ("FT", "dP Flow Transmitter"),
                ("LT", "Radar Level Transmitter")],
         "AO": [("FV", "Control Valve"), ("PV", "Control Valve"), ("LV", "Control Valve")],
         "DI": [("XLS", "Position Limit Switch"), ("HS", "Hand Switch"), ("ZLS", "Position Limit Switch")],
         "DO": [("XYV", "Solenoid Valve"), ("ZYV", "Solenoid Valve"), ("XA", "Alarm"), ("ZLO", "Position Indication Open")]}
LEVEL = {"AI": "2-Wire", "AO": "2-Wire", "DI": "Voltfree-contact", "DO": "Volt-contact"}
SIG = {"AI": "4-20 ma HART", "AO": "4-20 ma HART", "DI": "-", "DO": "-"}
DOMAINS = [("PIB-30", "RA 320-01", "OA-11", "320"), ("PIB-24", "RA 500-02", "OA-14", "500"),
           ("PIB-11", "RA 110-03", "OA-03", "110"), ("PIB-42", "RA 420-07", "OA-21", "420")]


def generate(n: int = 10000, seed: int = 7, nasty: bool = False, domains: int = 3) -> tuple[list[str], list[list[str]]]:
    rnd = random.Random(seed)
    rows: list[dict[str, str]] = []
    doms = DOMAINS[:max(1, min(domains, len(DOMAINS)))]
    cable_no = 0
    while len(rows) < n:
        room, area, oa, unit = rnd.choice(doms)
        size = rnd.choices([24, 12, 6, 2, 1], weights=[50, 25, 15, 6, 4])[0]
        is_do = rnd.random() < 0.18
        prefix = "CS" if is_do else "CE"
        cable_no += 1
        cable = f"{unit}-{prefix}-{cable_no:05d}"
        spec = f"{size:02d}PX{'2.5' if is_do else '1'}MM2/FR/ARM/NIS" if size > 1 else "1TX1.3MM2/FR/OS/NIS"
        fam = rnd.choices(["A", "B", "-"], weights=[25, 20, 55])[0]
        used = max(1, int(size * rnd.uniform(0.55, 0.95)))
        pairs = sorted(rnd.sample(range(1, size + 1), used))
        for p in pairs:
            io_t = "DO" if is_do else rnd.choices(["AI", "AO", "DI"], weights=[50, 20, 30])[0]
            inst, desc = rnd.choice(INSTR[io_t])
            grp = "-" if fam == "-" else (fam if rnd.random() < 0.6 else ("A-CONTROL" if fam == "A" else "B-ALARM"))
            if fam == "-" and rnd.random() < 0.08:
                grp = rnd.choice(["C", "E"])
            num = len(rows) + 1
            rows.append({
                "OA No.": oa, "Technical Room (Signal Location 2)": room, "Design Area": area,
                "Tag Number": f"{unit}-{inst:<4}-{num:05d}", "Instrument Type": inst, "Instrument Type Description": desc,
                "Equipment Name": "-", "WBS": unit, "Status": rnd.choice(["New", "New", "Modified"]), "Location": "L",
                "I/O Type Name": io_t + ("R" if rnd.random() < 0.4 else ""), "Signal Type": SIG[io_t], "Execution": "NON-IS",
                "External Power Supply": "-", "Signal Level": LEVEL[io_t], "Multi-cable / Cable": spec,
                "Multipair Cable No.": cable, "Pair Number": f"{'Triad' if size == 1 else 'Pair'} {p}", "IO Grouping": grp,
                "Tag Service 1 and 2": f"SERVICE {num}", "Loop Name": f"{unit}-{inst[0]} -{num:05d}", "Old Tag Number": "-",
                "System 2": "-",
            })
            if len(rows) >= n:
                break
    # cabinet alarms for the first cabinet of each domain
    for room, area, oa, unit in doms:
        loc = "P" + room.split("-")[-1]
        a5 = area.split()[-1].replace("-", "")
        for suffix, io_t, sig, lvl in (("T", "AIR", "RTD", "3-Wire"), ("AC", "DIR", "-", "Voltfree-contact"),
                                       ("DC", "DIR", "-", "Voltfree-contact")):
            rows.append({**{h: "-" for h in BASE_HEADERS}, "OA No.": oa, "Technical Room (Signal Location 2)": room,
                         "Design Area": area, "Tag Number": f"{unit}-EJA  -01001-{suffix}", "Instrument Type": "EJA",
                         "Instrument Type Description": "Cabinet Diagnostic Alarm", "Equipment Name": f"{loc}-DCM-{a5}-01",
                         "WBS": unit, "Status": "New", "Location": room, "I/O Type Name": io_t, "Signal Type": sig,
                         "Execution": "NON-IS", "Signal Level": lvl, "Multipair Cable No.": "Internal Wiring",
                         "Tag Service 1 and 2": f"{loc}-DCM-{a5}-01 {suffix}"})
    headers = list(BASE_HEADERS)
    if nasty:
        k = len(rows)
        # A+B on one cable, oversize pair, duplicate tag, duplicate pair, missing pair, unknown IO, unknown DO, junk
        rows[0]["IO Grouping"], rows[1]["IO Grouping"] = "A", "B"
        rows[1]["Multipair Cable No."] = rows[0]["Multipair Cable No."]
        rows[1]["Pair Number"] = "Pair " + str(int(rows[0]["Pair Number"].split()[-1]) + 1 if "Pair" in rows[0]["Pair Number"] else 2)
        rows[1]["Multi-cable / Cable"] = rows[0]["Multi-cable / Cable"]
        traps = [
            {"Pair Number": "Pair 99"}, {"Tag Number": rows[10]["Tag Number"]},
            {"Multipair Cable No.": rows[20]["Multipair Cable No."], "Pair Number": rows[20]["Pair Number"]},
            {"Pair Number": ""}, {"I/O Type Name": "HART-X"}, {"I/O Type Name": "DO", "Instrument Type": "UZV"},
            {"Multipair Cable No.": "", "Pair Number": "Pair 1"}, {"Tag Number": ""},
        ]
        for i, trap in enumerate(traps):
            base = dict(rows[min(k - 1, 40 + i)])
            base["Tag Number"] = f"NASTY-{i:02d}"
            base.update(trap)
            rows.append(base)
        rows.insert(5, {h: "" for h in BASE_HEADERS})
        rows.insert(500 if len(rows) > 500 else 2, {h: "" for h in BASE_HEADERS})
        rnd.shuffle(headers)
        headers = [NASTY_RENAMES.get(h, h) for h in headers]
        rows = [{NASTY_RENAMES.get(k_, k_): v for k_, v in r.items()} for r in rows]
    return headers, [[r.get(h, "") for h in headers] for r in rows]


def to_table(headers: list[str], rows: list[list[str]], name: str = "synthetic.xlsx") -> RawTable:
    data = [(i + 2, dict(zip(headers, r))) for i, r in enumerate(rows) if any(r)]
    return RawTable(file=name, sheet="MDB", header_row=1, headers=headers, rows=data, sha256=f"synthetic-{len(rows)}")


def to_xlsx(headers: list[str], rows: list[list[str]]) -> bytes:
    wb = openpyxl.Workbook(write_only=True)
    ws = wb.create_sheet("MDB-1")
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
