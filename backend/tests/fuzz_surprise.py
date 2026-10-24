"""Surprise-MDB fuzz harness (a script, not a pytest module: pytest only collects test_*.py).

Takes the sample MDB and the drill files as bases, applies 1-4 random mutations to each (aliased / shuffled / blanked
columns, title rows, split or merged headers, odd pair and cable-size spellings, big cables, unseen IO types, case and
whitespace noise, duplicate rows, a ';' latin-1 CSV, 2,000-row scale-ups) and pushes every variant through the whole
pipeline headless: read → map → normalise → pre-flight → allocate → render → export → independent verifier.

A variant PASSES when nothing raised, no SYS-<stage> TQ reports an internal error or an unreadable file, the verifier
finds 0 hard violations on the exported workbook, every live row is either placed or quarantined with a TQ, and it did not
place under 50% of its live signals without a reason (a blanked required column or a broken header explains it; nothing else does).

    cd backend && uv run python tests/fuzz_surprise.py                       # 300 variants, seed 20261024
    uv run python tests/fuzz_surprise.py --seed 7 --n 50 --workers 4 --keep /tmp/fuzz_fails --json /tmp/fuzz.json
    uv run python tests/fuzz_surprise.py --only 12,57 --verbose              # re-run single variants of the same seed
"""
from __future__ import annotations

import argparse
import copy
import csv
import io
import json
import math
import random
import re
import signal
import sys
import time
import traceback
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
DATA = BACKEND.parent / "data"
SAMPLE = DATA / "Sample_IO_MDB_VIT_v2_1.xlsx"
BASES = [SAMPLE, SAMPLE, *sorted((DATA / "drills").glob("drill_*"))]      # the sample counts double
DEFAULT_SEED = 20261024
VARIANT_TIMEOUT_S = 240


# ───────────────────────────── the table being mutated ─────────────────────────────

@dataclass
class Grid:
    order: list[str]                         # header text, left to right
    recs: list[dict[str, Any]]               # one dict per data row, keyed by header text
    role: dict[str, str]                     # canonical field → header text (as the sample names it)
    title: list[list[str]] = field(default_factory=list)      # rows above the header
    split: bool = False                      # header printed over two rows
    merges: list[int] = field(default_factory=list)           # header cells (by index) merged with their right neighbour
    fmt: str = "xlsx"                        # xlsx | csv


@lru_cache(maxsize=None)
def _base(path: str) -> Grid:
    from xio.reader import map_table, mapping_dict, read_table
    t = read_table(path)
    return Grid(order=list(t.headers), recs=[dict(r) for _, r in t.rows], role=dict(mapping_dict(map_table(t))))


def load_grid(path: Path) -> Grid:
    return copy.deepcopy(_base(str(path)))


def _col(g: Grid, f: str) -> str | None:
    h = g.role.get(f)
    return h if h in g.order else None


def _num(v: Any) -> int | None:
    m = re.search(r"\d+", str(v))
    return int(m.group()) if m else None


# ───────────────────────────── mutations: each returns False when it does not apply ─────────────────────────────

ALIASES = {
    "tag": ["Tag No.", "Tag", "TAG NO", "Tag #", "Instr. Tag", "Instrument Tag No"],
    "io_type": ["IO", "I/O", "IO Typ", "I/O Type", "Signal I/O", "IOType"],
    "cable": ["Cable", "Cbl No", "Cable #", "MP Cable", "Multicable No", "Cable Number"],
    "pair": ["Pr", "Pair #", "Pr No", "Pair No", "Pair", "P"],
    "group": ["Seg", "Seg Group", "Grp", "Segregation"],
    "room": ["Room", "Tech Room", "Rm"],
    "area": ["Area", "Des. Area", "Plant Area"],
    "cable_spec": ["Cable Size", "Cable Spec", "Cbl Size", "Size"],
    "service": ["Service", "Svc", "Description"],
    "is_type": ["IS/NIS", "IS", "Ex"],
    "status": ["Sts", "Tag Status"],
    "instrument_type": ["Inst Type", "Inst. Code"],
}


def m_rename_headers(g: Grid, r: random.Random) -> bool:
    n = 0
    for f, alts in ALIASES.items():
        old = _col(g, f)
        if old is None or r.random() > 0.7:
            continue
        new = r.choice([a for a in alts if a not in g.order] or [None])
        if new is None:
            continue
        g.order[g.order.index(old)] = new
        for rec in g.recs:
            if old in rec:
                rec[new] = rec.pop(old)
        g.role[f] = new
        n += 1
    return n > 0


def m_shuffle_columns(g: Grid, r: random.Random) -> bool:
    r.shuffle(g.order)
    return True


def m_title_rows(g: Grid, r: random.Random) -> bool:
    pool = [["PROJECT 4471 — IO LIST"], [], ["Rev A", "2026-10-24", "Issued for design"], ["Confidential"], ["", "", "see notes tab"]]
    g.title = [list(x) for x in r.sample(pool, r.randint(1, 4))] + g.title
    return True


def m_split_header(g: Grid, r: random.Random) -> bool:
    g.split = True
    return True


def m_merge_header_cells(g: Grid, r: random.Random) -> bool:
    g.merges = sorted(r.sample(range(len(g.order) - 1), min(len(g.order) - 1, r.randint(1, 3))))
    g.fmt = "xlsx"
    return True


def m_blank_optional(g: Grid, r: random.Random) -> bool:
    have = [h for f in ("room", "area", "service", "is_type", "cable_spec") if (h := _col(g, f))]
    if not have:
        return False
    for h in r.sample(have, min(len(have), r.randint(1, 2))):
        for rec in g.recs:
            rec[h] = ""
    return True


def m_blank_required(g: Grid, r: random.Random) -> bool:
    have = [h for f in ("tag", "io_type", "cable", "pair") if (h := _col(g, f))]
    if not have:
        return False
    h = r.choice(have)
    for rec in g.recs:
        rec[h] = ""
    return True


PAIR_FORMATS: list[Callable[[int], Any]] = [lambda n: f"P{n}", lambda n: str(n), lambda n: f"{n}.0", lambda n: f"Pair-{n}",
                                            lambda n: float(n), lambda n: n]


def m_pair_format(g: Grid, r: random.Random) -> bool:
    h = _col(g, "pair")
    if h is None:
        return False
    fmts = [r.choice(PAIR_FORMATS)] if r.random() < 0.7 else r.sample(PAIR_FORMATS, 3)       # one spelling, or a mix
    for rec in g.recs:
        n = _num(rec.get(h, ""))
        if n is not None and re.search(r"(?i)pair|triad|^\s*\d+\s*$", str(rec[h])):
            rec[h] = r.choice(fmts)(n)
    return True


SIZE_FORMATS = [lambda n: f"{n}P", lambda n: f"{n} PAIR", lambda n: f"{n}PX1MM2", lambda n: f"{n:02d} Pair", lambda n: f"{n}pr"]


def m_cable_size_format(g: Grid, r: random.Random) -> bool:
    h = _col(g, "cable_spec")
    if h is None:
        return False
    fmts = [r.choice(SIZE_FORMATS)] if r.random() < 0.7 else r.sample(SIZE_FORMATS, 3)
    hit = 0
    for rec in g.recs:
        m = re.match(r"\s*0*(\d+)\s*(PX|P|TX)", str(rec.get(h, "")), re.I)
        if m and m.group(2).upper() != "TX":
            rec[h] = r.choice(fmts)(int(m.group(1)))
            hit += 1
    return hit > 0


def m_big_cables(g: Grid, r: random.Random) -> bool:
    tag_h, cab_h, pair_h, io_h = (_col(g, f) for f in ("tag", "cable", "pair", "io_type"))
    if not (tag_h and cab_h and pair_h) or not g.recs:
        return False
    spec_h = _col(g, "cable_spec")
    live = [x for x in g.recs if str(x.get(tag_h, "")).strip() and str(x.get(cab_h, "")).strip()
            and (not io_h or str(x.get(io_h, "")).strip().upper() in ("AI", "AIR"))] or g.recs
    for k in range(r.randint(1, 2)):
        size = r.choice([48, 96])
        tmpl = r.choice(live)
        old_tag = str(tmpl.get(tag_h, ""))
        for p in range(1, max(2, int(size * r.uniform(0.5, 1.0))) + 1):
            rec = dict(tmpl)
            tag = f"9{size}-FT-{k}{p:03d}"
            for h, v in tmpl.items():
                if isinstance(v, str) and v and v == old_tag:
                    rec[h] = tag
            rec[tag_h], rec[cab_h], rec[pair_h] = tag, f"9{size}-CE-{k:04d}", f"Pair {p}"
            if spec_h:
                rec[spec_h] = f"{size}PX1MM2/FR/ARM/NIS"
            g.recs.append(rec)
    return True


UNSEEN_IO = ["AIX", "HART", "PULSE", "RTD", "TC", "Digital Input", "analog out", "FF", "MODBUS", "PT100", "4-20", "?", "DIO", "Al"]


def m_unseen_io_types(g: Grid, r: random.Random) -> bool:
    h = _col(g, "io_type")
    if h is None or not g.recs:
        return False
    for rec in r.sample(g.recs, max(1, int(len(g.recs) * r.uniform(0.05, 0.2)))):
        rec[h] = r.choice(UNSEEN_IO)
    return True


def _mangle(s: str, r: random.Random) -> str:
    return {"upper": s.upper, "lower": s.lower, "title": s.title,
            "pad": lambda: f"  {s}  ", "inner": lambda: s.replace(" ", "   "), "nbsp": lambda: f" {s} ",
            "tab": lambda: f"{s}\t"}[r.choice(["upper", "lower", "title", "pad", "inner", "nbsp", "tab"])]()


def m_case_whitespace(g: Grid, r: random.Random) -> bool:
    new = {h: (_mangle(h, r) if r.random() < 0.5 else h) for h in g.order}
    if len(set(new.values())) != len(new):
        new = dict(zip(g.order, g.order))
    p = r.uniform(0.2, 0.6)
    g.recs = [{new[h]: (_mangle(v, r) if isinstance(v, str) and v and r.random() < p else v) for h, v in rec.items() if h in new}
              for rec in g.recs]
    g.order = [new[h] for h in g.order]
    g.role = {f: new.get(h, h) for f, h in g.role.items()}
    return True


def m_duplicate_rows(g: Grid, r: random.Random) -> bool:
    if not g.recs:
        return False
    for rec in r.sample(g.recs, max(1, len(g.recs) // 5)):
        g.recs.insert(r.randrange(len(g.recs) + 1), dict(rec))
    return True


def m_csv(g: Grid, r: random.Random) -> bool:
    g.fmt, g.merges = "csv", []
    return True


def m_scale_2000(g: Grid, r: random.Random) -> bool:
    tag_h, cab_h = _col(g, "tag"), _col(g, "cable")
    if not g.recs or len(g.recs) >= 2000:
        return False
    base, out = g.recs, []
    for j in range(math.ceil(2000 / len(base))):
        for rec in base:
            if j == 0:
                out.append(dict(rec))
                continue
            new = dict(rec)
            tag = str(rec.get(tag_h, "")) if tag_h else ""
            for h, v in rec.items():
                if isinstance(v, str) and v and ((tag and v == tag) or h == cab_h):
                    new[h] = f"{v}-R{j}"
            out.append(new)
    g.recs = out[:2000]
    return True


# (name, weight, fn) — the order here is the order they are applied in (data → columns → layout → format)
MUTATIONS: list[tuple[str, float, Callable[[Grid, random.Random], bool]]] = [
    ("blank_required_column", 0.8, m_blank_required), ("blank_optional_column", 1.0, m_blank_optional),
    ("add_48_96_pair_cables", 1.0, m_big_cables), ("unseen_io_types", 1.0, m_unseen_io_types),
    ("duplicate_rows_20pct", 1.0, m_duplicate_rows), ("pair_spelling", 1.0, m_pair_format),
    ("cable_size_spelling", 1.0, m_cable_size_format), ("scale_to_2000_rows", 0.5, m_scale_2000),
    ("rename_headers", 1.4, m_rename_headers), ("shuffle_columns", 1.0, m_shuffle_columns),
    ("case_and_whitespace", 1.0, m_case_whitespace), ("title_rows_above_header", 1.0, m_title_rows),
    ("split_header_two_rows", 0.8, m_split_header), ("merge_header_cells", 0.8, m_merge_header_cells),
    ("csv_semicolon_latin1", 0.8, m_csv),
]


# ───────────────────────────── building and writing a variant ─────────────────────────────

def make_variant(seed: int, i: int) -> tuple[Grid, str, list[str]]:
    r = random.Random(f"{seed}:{i}")
    base = r.choice(BASES)
    g = load_grid(base)
    pick = r.sample(range(len(MUTATIONS)), r.randint(1, 4))
    pick = sorted(set(pick))
    applied = []
    for k in pick:
        name, _, fn = MUTATIONS[k]
        if fn(g, r):
            applied.append(name)
    return g, base.name, applied


def render(g: Grid) -> tuple[bytes, str]:
    header: list[list[str]]
    if g.split:
        top = [h.split(" ", 1)[0] for h in g.order]
        bottom = [h.split(" ", 1)[1] if " " in h else "" for h in g.order]
        header = [top, bottom]
    else:
        header = [list(g.order)]
    body = [[rec.get(h, "") for h in g.order] for rec in g.recs]
    if g.fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
        for row in [*g.title, *header, *body]:
            w.writerow(row)
        return buf.getvalue().encode("latin-1", errors="replace"), "variant.csv"
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "IO List"
    for row in g.title:
        ws.append(row)
    hdr_row = len(g.title) + 1
    for row in header:
        ws.append(row)
    for row in body:
        ws.append(row)
    for j in g.merges:
        ws.merge_cells(start_row=hdr_row, start_column=j + 1, end_row=hdr_row, end_column=j + 2)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue(), "variant.xlsx"


# ───────────────────────────── running one variant ─────────────────────────────

_LOC = re.compile(r"\[(\w+)[:\s][^\]]*?\(at ([^)\s]+)\)\]\s*$")


def _stage_of(tb: traceback.StackSummary) -> str:
    for f in reversed(tb):
        p = f.filename.replace("\\", "/")
        for key, stage in (("xio/reader", "read/map"), ("engine/normalise", "normalise"), ("engine/preflight", "preflight"),
                           ("engine/optimise", "optimise"), ("engine/allocate", "allocate"), ("engine/pipeline", "pipeline"),
                           ("xio/render", "render"), ("xio/writer", "write"), ("verify/", "verify"), ("engine/", "engine"),
                           ("app/", "app")):
            if key in p:
                return stage
    return "?"


# a variant may legitimately place little when one of these was applied: a required column is empty, or the header is damaged
JUSTIFIES_LOW_PLACEMENT = {"blank_required_column", "split_header_two_rows", "merge_header_cells"}
LOW_PLACEMENT = "placed under 50% with no justification"


def low_placement(stats: dict, mutations: list[str]) -> tuple[bool, bool]:
    """(placed under half of the live signals, and no applied mutation explains it)."""
    n, placed = stats.get("signals", 0), stats.get("allocated", 0)
    low = n > 0 and placed * 2 < n
    return low, low and not (set(mutations) & JUSTIFIES_LOW_PLACEMENT)


def evaluate(data: bytes, fname: str, mutations: list[str] | None = None) -> tuple[list[tuple[str, str]], dict]:
    """Run the pipeline on one file; return [(category, detail)] — empty means PASS — and some stats."""
    from app.service import Service
    from engine.pipeline import run
    from engine.rules import load_ruleset
    from verify.xlsx import verify_xlsx
    from xio.writer import write_allocation_safe

    fails: list[tuple[str, str]] = []
    stats: dict[str, Any] = {}
    stage = "run"
    try:
        rs = load_ruleset("default")
        out = run(data, rs, filename=fname)
        stats.update(signals=out.kpis.signals, allocated=out.kpis.allocated, tqs=len(out.tqs), quarantined=len(out.quarantine))
        stage = "export"
        xlsx, werr = write_allocation_safe(out.rows)
        if werr is not None:
            fails.append(("export: template write failed", f"{type(werr).__name__}: {werr}"))
        stage = "verify"
        rep = verify_xlsx(xlsx, out.signals, out.rules.rs, out.settings, out.tqs, filename="variant_allocation.xlsx",
                          claims=Service.claims(out))
        stats.update(violations=rep.violations, checks=rep.checks_total)
        for t in out.tqs:
            if t.category.startswith("SYS-"):
                m = _LOC.search(t.message)
                key = f"{m.group(1)} @ {m.group(2)}" if m else re.sub(r"\d+", "N", t.message)[:90]
                fails.append((f"{t.category}: {key}", t.message[:200]))
        for c in rep.checks:
            if c.failed and c.severity == "hard":
                v = c.violations[0] if c.violations else None
                fails.append((f"verify {c.id} {c.label}", f"{c.failed} row(s); first: row {v.row if v else '?'} {v.message[:160] if v else ''}"))
        low, unjustified = low_placement(stats, mutations or [])
        stats["low_placement"] = low
        if unjustified:
            fails.append((LOW_PLACEMENT, f"placed {stats['allocated']} of {stats['signals']} live signals; "
                                         f"{stats['quarantined']} quarantined; mutations: {', '.join(mutations or []) or '-'}"))
        if out.kpis.accounted_pct < 100 and not any(c.startswith("SYS-") for c, _ in fails):
            live = out.kpis.signals
            fails.append(("rows neither placed nor quarantined with a TQ",
                          f"accounted {out.kpis.accounted_pct}% of {live} live signals ({out.kpis.allocated} placed, "
                          f"{out.kpis.unallocated_with_tq} with a TQ)"))
    except BaseException as e:      # noqa: BLE001 — a hang (timeout) or any exception is a finding, not a crash of the harness
        tb = traceback.extract_tb(e.__traceback__)
        kind = "timeout" if isinstance(e, TimeoutError) else f"exception in {stage}/{_stage_of(tb)}: {type(e).__name__}"
        fails.append((kind, f"{type(e).__name__}: {str(e)[:160]} (at {'/'.join(Path(tb[-1].filename).parts[-2:])}:{tb[-1].lineno})"
                      if tb else str(e)[:160]))
    return fails, stats


def _alarm(_sig, _frm):
    raise TimeoutError(f"variant exceeded {VARIANT_TIMEOUT_S} s")


def run_variant(seed: int, i: int, keep: str | None) -> dict:
    t0 = time.perf_counter()
    try:
        signal.signal(signal.SIGALRM, _alarm)
        signal.alarm(VARIANT_TIMEOUT_S)
    except (ValueError, AttributeError):
        pass
    try:
        g, base, muts = make_variant(seed, i)
        data, fname = render(g)
    except BaseException as e:      # noqa: BLE001 — the generator failing is a harness bug: say so loudly
        return {"i": i, "base": "?", "mutations": [], "rows": 0, "fails": [("harness error", f"{type(e).__name__}: {e}")],
                "stats": {}, "ms": 0}
    fails, stats = evaluate(data, fname, muts)
    try:
        signal.alarm(0)
    except (ValueError, AttributeError):
        pass
    if fails and keep:
        Path(keep).mkdir(parents=True, exist_ok=True)
        (Path(keep) / f"v{i:03d}_{fname}").write_bytes(data)
    return {"i": i, "base": base, "mutations": muts, "rows": len(g.recs), "fails": fails, "stats": stats,
            "ms": round((time.perf_counter() - t0) * 1e3)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--only", default="", help="comma-separated variant numbers to run")
    ap.add_argument("--keep", default="", help="directory to save the files of failing variants")
    ap.add_argument("--json", default="", help="write every result here")
    ap.add_argument("--verbose", action="store_true", help="print every variant, not only the failures")
    a = ap.parse_args()
    ids = [int(x) for x in a.only.split(",") if x] or list(range(a.n))
    print(f"fuzz_surprise · seed {a.seed} · {len(ids)} variants · {a.workers} workers · bases: "
          f"{', '.join(sorted({p.name for p in BASES}))}", flush=True)
    results: list[dict] = []
    t0 = time.perf_counter()
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        futs = {pool.submit(run_variant, a.seed, i, a.keep or None): i for i in ids}
        for k, f in enumerate(as_completed(futs), 1):
            try:
                res = f.result()
            except Exception as e:      # noqa: BLE001 — a worker that died is a finding too
                res = {"i": futs[f], "base": "?", "mutations": [], "rows": 0, "stats": {}, "ms": 0,
                       "fails": [(f"worker died: {type(e).__name__}", str(e)[:160])]}
            results.append(res)
            if res["fails"] or a.verbose:
                print(f"[{k:3}/{len(ids)}] v{res['i']:03d} {'FAIL' if res['fails'] else 'ok  '} {res['base']} · {res['rows']} rows · "
                      f"{', '.join(res['mutations']) or '-'} · {res['ms']} ms", flush=True)
                for cat, det in res["fails"]:
                    print(f"          ✗ {cat}\n            {det}", flush=True)
    results.sort(key=lambda x: x["i"])
    bad = [x for x in results if x["fails"]]
    cats: dict[str, list[int]] = defaultdict(list)
    for x in bad:
        for cat in dict.fromkeys(c for c, _ in x["fails"]):
            cats[cat].append(x["i"])
    by_mut: Counter = Counter()
    tot_mut: Counter = Counter()
    for x in results:
        for m in x["mutations"]:
            tot_mut[m] += 1
            by_mut[m] += bool(x["fails"])
    print(f"\n══ summary · seed {a.seed} · {len(results)} variants · {len(results) - len(bad)} pass · {len(bad)} fail "
          f"· {time.perf_counter() - t0:.0f} s")
    for cat, vs in sorted(cats.items(), key=lambda kv: -len(kv[1])):
        print(f"  {len(vs):4} × {cat}\n         e.g. " + ", ".join(f"v{v:03d}" for v in vs[:6]))
    low = [x for x in results if x["stats"].get("low_placement")]
    print(f"\n  placed under 50% of live signals: {len(low)} variants, of which {len(low) - sum(1 for x in bad if any(c == LOW_PLACEMENT for c, _ in x['fails']))} "
          f"justified (blank required column / split or merged header) and "
          f"{sum(1 for x in bad if any(c == LOW_PLACEMENT for c, _ in x['fails']))} not")
    print("\n  failing share by mutation: " + " · ".join(f"{m} {by_mut[m]}/{tot_mut[m]}" for m, _ in sorted(
        tot_mut.items(), key=lambda kv: -(by_mut[kv[0]] / kv[1]))))
    if a.json:
        Path(a.json).write_text(json.dumps({"seed": a.seed, "results": results}, indent=1, default=str))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
