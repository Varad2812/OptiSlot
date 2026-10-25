"""Column mapping: new header synonyms, and value-based inference for required fields with no confident header match.

Value inference is a last resort: it must lower the confidence, set needs_confirmation and say it was inferred — never a
silent map — and a plausible-looking header must not be accepted when the column's VALUES say otherwise."""
from __future__ import annotations

import io

import openpyxl
import pytest

from engine.pipeline import run
from tests.helpers import HEADERS, row, table
from xio.reader import CONFIRM_BELOW, auto_map, read_table

TAG, IO, CABLE, PAIR = "Tag Number", "I/O Type Name", "Multipair Cable No.", "Pair Number"
REQUIRED = ("tag", "io_type", "cable", "pair")


def data_rows(n_cables: int = 4, pairs: int = 12) -> list[dict[str, str]]:
    out = []
    for c in range(n_cables):
        for p in range(1, pairs + 1):
            io = ["AI", "AO", "DI", "DO"][c % 4]
            out.append(row(f"320-PT   -{c}{p:02d}01", io, f"320-CE-{c + 1:04d}", p, pairs, inst="XYV" if io == "DO" else "PT"))
    return out


def renamed(rename: dict[str, str], rows: list[dict[str, str]] | None = None):
    rows = rows or data_rows()
    headers = [rename.get(h, h) for h in HEADERS]
    recs = [{rename.get(k, k): v for k, v in r.items()} for r in rows]
    return headers, recs


def mapping(headers, recs, **kw):
    return {m.field: m for m in auto_map(headers, rows=recs, **kw)}


def xlsx(headers, recs) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for r in recs:
        ws.append([r.get(h, "") for h in headers])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.mark.parametrize("field,old,new", [
    ("tag", TAG, "Signal Name"), ("tag", TAG, "IO Signal Name"), ("tag", TAG, "Signal Tag"), ("tag", TAG, "Signal ID"),
    ("io_type", IO, "Type of IO"), ("io_type", IO, "IO Signal Type"),
    ("cable", CABLE, "Cbl"), ("cable", CABLE, "Cable Ref"),
    ("pair", PAIR, "Core No"), ("pair", PAIR, "Cable Core"),
])
def test_new_synonyms_map_by_header_with_full_confidence(field, old, new):
    headers, recs = renamed({old: new})
    m = mapping(headers, recs)[field]
    assert m.source == new and m.confidence == 1.0 and not m.needs_confirmation and not m.inferred_from_values


def test_all_new_synonyms_at_once():
    headers, recs = renamed({TAG: "Signal Name", IO: "Type of IO", CABLE: "Cbl", PAIR: "Core No"})
    m = mapping(headers, recs)
    assert {f: m[f].source for f in REQUIRED} == {"tag": "Signal Name", "io_type": "Type of IO", "cable": "Cbl", "pair": "Core No"}
    assert not any(m[f].needs_confirmation for f in REQUIRED)


def test_values_alone_find_the_four_required_columns_but_never_silently():
    headers, recs = renamed({TAG: "Col A", IO: "Col B", CABLE: "Col C", PAIR: "Col D"})
    m = mapping(headers, recs)
    assert {f: m[f].source for f in REQUIRED} == {"tag": "Col A", "io_type": "Col B", "cable": "Col C", "pair": "Col D"}
    for f in REQUIRED:
        assert m[f].inferred_from_values and m[f].needs_confirmation and 0 < m[f].confidence < CONFIRM_BELOW
    # without the data rows (headers only) nothing is guessed
    bare = {m.field: m for m in auto_map(headers)}
    assert all(bare[f].source is None and bare[f].needs_confirmation and not bare[f].inferred_from_values for f in REQUIRED)


def test_a_user_override_is_never_replaced_by_inference():
    headers, recs = renamed({TAG: "Col A", IO: "Col B", CABLE: "Col C", PAIR: "Col D"})
    m = mapping(headers, recs, overrides={"io_type": "Col D"})
    assert m["io_type"].source == "Col D" and m["io_type"].overridden and not m["io_type"].inferred_from_values
    assert m["pair"].source != "Col D"


def test_signal_name_must_not_become_io_type():
    # tag column present under its usual name; io type column unrecognisable; an extra "Signal Name" column of unique tags
    headers, recs = renamed({IO: "Col B"})
    headers.append("Signal Name")
    for r, k in zip(recs, range(len(recs))):
        r["Signal Name"] = f"SIG-{k:04d}-A"
    m = mapping(headers, recs)
    assert m["io_type"].source == "Col B" and m["io_type"].inferred_from_values
    assert m["tag"].source == TAG


def test_signal_name_is_the_tag_when_the_tag_column_is_unrecognisable_and_never_the_io_type():
    headers, recs = renamed({TAG: "Col T", IO: "Col B"})
    headers.append("Signal Name")
    for r, k in zip(recs, range(len(recs))):
        r["Signal Name"] = r["Col T"]
    m = mapping(headers, recs)
    assert m["tag"].source == "Signal Name" and not m["tag"].needs_confirmation
    assert m["io_type"].source == "Col B" and m["io_type"].needs_confirmation


def test_a_fuzzy_header_whose_values_disagree_is_dropped():
    # "Signal ID" fuzzily resembles the io_type synonym "Signal IO Type" — but its values are unique ids, not IO types
    headers, recs = renamed({IO: "Col B"})
    headers.append("Signal IO Typ")                        # near-miss header, values are tags
    for r, k in zip(recs, range(len(recs))):
        r["Signal IO Typ"] = f"ID-{k:04d}"
    m = mapping(headers, recs)
    assert m["io_type"].source == "Col B"


def test_serial_number_column_is_not_a_pair_and_row_text_is_not_a_cable():
    headers, recs = renamed({PAIR: "Col D", CABLE: "Col C"})
    headers.append("Sr No")
    for k, r in enumerate(recs, start=1):
        r["Sr No"] = str(k)
    m = mapping(headers, recs)
    assert m["pair"].source == "Col D"
    assert m["cable"].source == "Col C"                    # not Technical Room / Design Area, whose (value, pair) repeat


def test_ambiguous_columns_stay_unmapped_rather_than_guessed():
    # two equally plausible unique-string columns and no other hint for the tag: take neither silently as confident
    headers = ["Alpha", "Beta", "Kind", "Ref", "No"]
    recs = [{"Alpha": f"A-{i:03d}-X", "Beta": f"B-{i:03d}-Y", "Kind": ["AI", "DI"][i % 2], "Ref": f"CB-{i // 6}", "No": str(i % 6 + 1)}
            for i in range(60)]
    m = mapping(headers, recs)
    assert m["tag"].source in (None, "Alpha", "Beta") and (m["tag"].source is None or m["tag"].needs_confirmation)
    assert m["io_type"].source == "Kind" and m["io_type"].needs_confirmation


def test_renamed_file_allocates_end_to_end_and_raises_one_confirm_tq():
    headers, recs = renamed({TAG: "Col A", IO: "Col B", CABLE: "Col C", PAIR: "Col D"})
    out = run(xlsx(headers, recs), filename="renamed.xlsx")
    assert out.kpis.allocated == len(recs) and out.kpis.violations == 0
    tqs = [t for t in out.tqs if t.category == "Column mapping inferred"]
    assert len(tqs) == 1 and tqs[0].confidence == "candidate" and tqs[0].severity == "low"
    for h in ("Col A", "Col B", "Col C", "Col D"):
        assert h in tqs[0].message


def test_recognised_headers_never_trigger_inference_or_the_tq():
    headers, recs = renamed({TAG: "Signal Name", CABLE: "Cbl"})
    out = run(xlsx(headers, recs), filename="ok.xlsx")
    assert not [t for t in out.tqs if t.category == "Column mapping inferred"]
    assert not any(m.inferred_from_values for m in out.mapping)


def test_headers_unknown_everywhere_still_read_as_a_table():
    headers, recs = renamed({TAG: "Col A", IO: "Col B", CABLE: "Col C", PAIR: "Col D"})
    rename_all = {h: f"X{i}" for i, h in enumerate(HEADERS) if h not in ("Col A",)}
    t = read_table(xlsx([rename_all.get(h, h) for h in headers], [{rename_all.get(k, k): v for k, v in r.items()} for r in recs]),
                   filename="allunknown.xlsx")
    assert len(t.rows) == len(recs)


# ───────────────────────────── a decoy column that is blank or "-" in most rows must not win ─────────────────────────────

@pytest.mark.parametrize("alias", ["IO Type", "Signal I/O", "IO", "IO Typ"])
def test_renamed_io_column_beats_the_mostly_empty_decoy(alias):
    rows = data_rows()
    for i, r in enumerate(rows):                                   # "I/O Type Name 2": "-" almost everywhere, a few real-looking values
        r["I/O Type Name 2"] = "DO" if i in (3, 17, 30) else "-"
    headers = [alias if h == IO else h for h in HEADERS] + ["I/O Type Name 2"]
    recs = [{(alias if k == IO else k): v for k, v in r.items()} for r in rows]
    m = mapping(headers, recs)
    assert m["io_type"].source == alias, (alias, m["io_type"].source, m["io_type"].confidence)
    assert m["io_type"].source != "I/O Type Name 2"
    out = run(xlsx(headers, recs), filename="io.xlsx")
    assert out.kpis.signals == len(rows) and out.kpis.allocated == len(rows)
    assert not [q for q in out.quarantine if "unknown IO type" in q.reason]


def test_a_sparse_column_is_still_used_when_nothing_better_exists():
    rows = data_rows()
    for i, r in enumerate(rows):
        r[IO] = r[IO] if i % 5 == 0 else "-"                       # the real IO column is the only one, and it is mostly "-"
    headers, recs = renamed({})
    m = mapping(headers, recs)
    assert m["io_type"].source == IO                                # no better-filled alternative: the header match stays


# ───────────────────────────── cable number vs cable size/spec headers ─────────────────────────────

@pytest.mark.parametrize("alias", ["Cbl No", "Multicable No", "Cable Number", "Cable ID", "Multi-cable No", "Cbl Number"])
def test_cable_number_aliases_map_to_the_cable_field_not_the_spec(alias):
    rows = data_rows()
    for r in rows:
        r["Cable Remarks"] = f"routed {r[CABLE]} tray"                      # decoy text column
    spec = "Multi-cable / Cable"
    headers = [alias if h == CABLE else "Size" if h == spec else h for h in HEADERS] + ["Cable Remarks"]    # no recognisable spec header
    recs = [{(alias if k == CABLE else "Size" if k == spec else k): v for k, v in r.items()} for r in rows]
    m = mapping(headers, recs)
    assert m["cable"].source == alias and m["cable"].confidence >= CONFIRM_BELOW and not m["cable"].needs_confirmation
    assert m["cable_spec"].source != alias and m["cable"].source != "Cable Remarks"
    out = run(xlsx(headers, recs), filename="io.xlsx")
    assert out.kpis.allocated == len(rows) and not [q for q in out.quarantine if "missing cable" in q.reason]


def test_cable_numbers_survive_duplicate_rows():
    rows = data_rows()
    rows += [dict(r) for r in rows[::5]]                                   # exact duplicates must not veto the header match
    headers = ["Cbl No" if h == CABLE else h for h in HEADERS]
    recs = [{("Cbl No" if k == CABLE else k): v for k, v in r.items()} for r in rows]
    assert mapping(headers, recs)["cable"].source == "Cbl No"


def test_a_text_column_does_not_win_the_cable_field_over_cable_ids():
    rows = data_rows()
    for r in rows:
        r["Run text"] = f"Cable run {r[CABLE][-4:]}"                       # repeats per cable, unique with the pair: a phrase
    headers = ["Zq" if h == CABLE else h for h in HEADERS] + ["Run text"]            # nothing names the cable column
    recs = [{("Zq" if k == CABLE else k): v for k, v in r.items()} for r in rows]
    m = mapping(headers, recs)["cable"]
    assert m.source == "Zq" and m.inferred_from_values and m.needs_confirmation and m.confidence < CONFIRM_BELOW


def test_io_column_with_messy_spellings_and_unseen_types_still_beats_the_decoy():
    rows = data_rows()
    odd = ["AIX", "HART", "PULSE", "RTD", "TC", "FF", "MODBUS", "PT100", "DIO", "4-20", "?", "analog out", "Digital Input"]
    for i, r in enumerate(rows):
        r["I/O Type Name 2"] = "DO" if i in (3, 17) else "-"
        v = r[IO]
        r[IO] = odd[i % len(odd)] if i % 12 == 5 else [v.lower(), f" {v} ", v.title(), v][i % 4]     # >12 distinct raw spellings
    headers = ["IO" if h == IO else h for h in HEADERS] + ["I/O Type Name 2"]
    recs = [{("IO" if k == IO else k): v for k, v in r.items()} for r in rows]
    assert len({r["IO"] for r in recs}) > 12
    m = mapping(headers, recs)["io_type"]
    assert m.source == "IO" and m.needs_confirmation                     # taken from its values: shown for confirmation
