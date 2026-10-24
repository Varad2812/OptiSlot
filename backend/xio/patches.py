"""Data patches: an engineer's corrections to MDB cells (a pair number, an IO type, a cable …), stored per project.

A patch edits the raw MDB record BEFORE normalisation, so the corrected row goes through exactly the same mapping,
pre-flight, allocation and verification as any other row. The patched table gets its own hash (original sha + the
patches), so the run certificate shows that the input was corrected and a re-run reproduces it.
"""
from __future__ import annotations

import hashlib
import json
import re

from xio.reader import FIELDS, RawTable, map_table, mapping_dict

ALIASES = {
    "io": "io_type", "iotype": "io_type", "io_type_name": "io_type", "i_o_type": "io_type",
    "segregation": "group", "grouping": "group", "io_grouping": "group", "io_group": "group",
    "instrument": "instrument_type", "inst_type": "instrument_type",
    "cable_no": "cable", "cable_number": "cable", "multipair_cable": "cable",
    "pair_no": "pair", "pair_number": "pair", "core": "pair",
    "cable_size": "cable_spec", "spec": "cable_spec", "size": "cable_spec",
    "tag_number": "tag", "tag_no": "tag", "tagno": "tag",
    "is": "is_type", "execution": "is_type", "is_nis": "is_type",
    "description": "service", "tag_service": "service",
}
MAX_VALUE = 200


def canonical(name: str) -> str:
    n = re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")
    n = ALIASES.get(n, n)
    if n not in FIELDS:
        raise ValueError(f"unknown field '{name}' — patchable fields: {', '.join(sorted(FIELDS))}")
    return n


def patch_key(tag_key: str, row: int | None = None) -> str:
    return f"{tag_key}#{row}" if row else tag_key


def patches_hash(patches: dict) -> str:
    return hashlib.sha256(json.dumps(patches, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if patches else ""


def apply_patches(table: RawTable, patches: dict[str, dict[str, str]], overrides: dict[str, str | None] | None = None) -> RawTable:
    """A copy of the table with the patched cells replaced. A field the MDB has no column for is skipped (the caller
    validates that when the patch is made)."""
    if not patches:
        return table
    mapping = mapping_dict(map_table(table, overrides))
    tag_col = mapping.get("tag")
    if not tag_col:
        return table
    rows = []
    for n, rec in table.rows:
        key = re.sub(r"\s+", "", rec.get(tag_col, "") or "")
        hit = {**patches.get(key, {}), **patches.get(f"{key}#{n}", {})}
        if hit:
            rec = dict(rec)
            for f, v in hit.items():
                col = mapping.get(f)
                if col:
                    rec[col] = v
        rows.append((n, rec))
    sha = hashlib.sha256((table.sha256 + ":" + patches_hash(patches)).encode()).hexdigest()
    return RawTable(file=table.file, sheet=table.sheet, header_row=table.header_row, headers=table.headers, rows=rows, sha256=sha,
                    blank_rows=table.blank_rows, notes=[*table.notes, f"{len(patches)} data patch(es) applied"])
