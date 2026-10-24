"""The independent verifier. It knows NOTHING about the engine.

Inputs: output rows (the 76 template columns as text — from memory or read back from any xlsx),
the normalised MDB, the rule set and the project settings (+ optionally the TQ register, which may
excuse a missing tag). Every expectation is re-derived here from the rule set; nothing is copied from
the allocation. A TQ-covered exception is reported as "excepted", never as a silent pass.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable

from app.cabledomain import cable_homes, row_home
from app.ruleslang import ExprError, catalog, compiled_expr, derive, eval_cond, first_match, fmt, match_when
from app.schemas import CheckResult, ProjectSettings, RuleCheckReport, RuleSet, Signal, TQ, Violation

DASH = "-"
STATUSES = {"Field", "Wired Spare", "Spare Slot", "Cabinet Alarm"}
MAX_LISTED = 250
TOKEN_RX = {"cioc3": r"\d{3}", "bp": r"\d+", "ch": r"\d+", "ctrl2": r"\d{2}", "cab2": r"\d{2}", "seq2": r"\d{2}",
            "side": r"[A-Za-z]+", "area4": r"\d{4}", "area": r"[0-9A-Za-z]+", "loc": r"[0-9A-Za-z]+"}
_SIZE = re.compile(r"^\s*0*(\d{1,3})\s*[PTQ]?X", re.I)


_PAIR_RX = re.compile(r"(?:pair|triad|pr)?\s*#?\s*(\d{1,4})(?:\.0+)?", re.I)  # same clean forms as the MDB reader accepts


def _pair(v: str) -> int | None:
    m = _PAIR_RX.fullmatch((v or "").strip())
    return int(m.group(1)) if m and int(m.group(1)) > 0 else None


def _int(v: str) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        try:
            f = float(str(v).strip())
            return int(f) if f.is_integer() else None
        except (TypeError, ValueError):
            return None


def _key(tag: str) -> str:
    return re.sub(r"\s+", "", tag or "")


def mdb_index(signals: list[Signal], deleted: set[str] | None = None) -> dict[str, Signal]:
    """Tag key → MDB row. When a tag repeats, the FIRST live row is the signal (the documented MDB policy)."""
    deleted = deleted or {"DELETED"}
    out: dict[str, Signal] = {}
    for s in sorted(signals, key=lambda s: ((s.status or "").upper() in deleted, s.row)):
        if s.tag_key:
            out.setdefault(s.tag_key, s)
    return out


def ab_rule(rs: RuleSet):
    """The A/B segregate rule: the first enabled one on the IO grouping at CIOC or cabinet level."""
    return next((r for r in rs.rules if r.type == "segregate" and r.enabled and (r.params.get("field") or "group") == "group"
                 and r.params.get("level", "cioc") != "baseplate"), None)


def pattern_parser(pattern: str) -> re.Pattern:
    """Pattern with {tokens} → regex with named groups (repeated tokens become back-references)."""
    out, seen = [], set()
    for part in re.split(r"(\{[a-z0-9_]+\})", pattern):
        if part.startswith("{") and part.endswith("}"):
            tok = part[1:-1]
            if tok in seen:
                out.append(f"(?P={tok})")
            else:
                seen.add(tok)
                out.append(f"(?P<{tok}>{TOKEN_RX.get(tok, '.+?')})")
        else:
            out.append(re.escape(part))
    return re.compile("^" + "".join(out) + "$", re.ASCII)


@dataclass
class Row:
    n: int
    d: dict[str, str]
    status: str
    tag: str
    key: str
    io: str
    cab: str
    cioc: str
    baseplate: str
    controller: str
    syscab: str
    cable: str
    pair: int | None
    ch: int | None
    charm_no: int | None
    bp: int | None = None
    cioc3: int | None = None
    local: int | None = None
    seg: str = DASH
    family: str = DASH

    def v(self, msg: str) -> Violation:
        return Violation(row=self.n, tag=self.tag if self.tag != DASH else None, message=msg,
                         slot_id=f"{self.cab}/{self.cioc3:03d}/{self.bp}/{self.ch}" if self.cioc3 and self.bp else None)


@dataclass
class Ctx:
    rows: list[Row]
    signals: list[Signal]
    rs: RuleSet
    settings: ProjectSettings
    tqs: list[TQ]
    rules: dict[str, Any] = field(default_factory=dict)
    claims: dict[str, Any] = field(default_factory=dict)  # CIOC counts other artefacts claim (BOM, KPIs)

    @property
    def compact(self) -> bool:
        return self.rs.settings.cioc_strategy == "compact"

    def rule(self, rtype: str):
        return next((r for r in self.rs.rules if r.type == rtype and r.enabled), None)

    def params(self, rtype: str) -> dict:
        r = self.rule(rtype)
        return r.params if r else {}


class Check:
    def __init__(self, cid: str, label: str, rtype: str | None, ctx: Ctx, always: bool = False):
        self.rule = ctx.rule(rtype) if rtype else None
        self.skip = rtype is not None and self.rule is None and not always
        if rtype and self.rule is None and always:
            self.rule = ctx.rule("capacity")
        self.res = CheckResult(id=cid, label=label, rule_id=self.rule.id if self.rule else None,
                               severity=self.rule.severity if self.rule else "hard")

    def ok(self, n: int = 1) -> None:
        self.res.passed += n

    def fail(self, v: Violation) -> None:
        self.res.failed += 1
        if len(self.res.violations) < MAX_LISTED:
            self.res.violations.append(v)

    def excuse(self, v: Violation) -> None:
        self.res.excepted += 1
        if len(self.res.exceptions) < MAX_LISTED:
            self.res.exceptions.append(v)


# ───────────────────────────── row parsing ─────────────────────────────

def parse_rows(raw: list[dict[str, str]], ctx_settings: ProjectSettings, rs: RuleSet) -> list[Row]:
    pats = next((r.params for r in rs.rules if r.type == "naming_pattern" and r.enabled), {}).get("patterns", {})
    cioc_rx = pattern_parser(pats.get("cioc", "{loc}DCIOC{area4}{cioc3}"))
    bp_rx = pattern_parser(pats.get("baseplate", "{cioc3}-CBP-{bp}"))
    seg = ab.params if (ab := ab_rule(rs)) else {}
    fam_of = {m.upper(): f for f, ms in seg.get("families", {}).items() for m in ms}
    out = []
    for i, d in enumerate(raw, start=2):
        g = lambda c: (d.get(c) or "").strip() or DASH  # noqa: E731
        r = Row(n=i, d=d, status=g("Tag Status"), tag=g("Tag Name"), key=_key(g("Tag Name")), io=g("IO Type"),
                cab=g("Electronic/ Marshalling Cabinet"), cioc=g("CIOC/CSLS Name"), baseplate=g("Baseplate"),
                controller=g("Controller"), syscab=g("System Cabinet"), cable=g("Field Cable No"),
                pair=_pair(g("Field Cable Pair")), ch=_int(g("Channel_No")),
                charm_no=_int(g("CHARM_No")), seg=g("Segregation"))
        r.family = fam_of.get(r.seg.upper(), DASH)
        m = cioc_rx.match(r.cioc)
        if m and "cioc3" in m.groupdict():
            r.cioc3 = int(m.group("cioc3"))
            r.local = (r.cioc3 - 1) % ctx_settings.ciocs_per_cabinet + 1
        m = bp_rx.match(r.baseplate)
        if m and "bp" in m.groupdict():
            r.bp = int(m.group("bp"))
        out.append(r)
    return out


# ───────────────────────────── checks ─────────────────────────────

def c_tags(ctx: Ctx) -> CheckResult:
    c = Check("C01", "Every live MDB tag appears exactly once", "capacity", ctx, always=True)
    deleted = {s.upper() for s in ctx.settings.deleted_statuses}
    live = {k: s for k, s in mdb_index(ctx.signals, deleted).items() if (s.status or "").upper() not in deleted}
    dead = {s.tag_key for s in ctx.signals if s.tag_key and (s.status or "").upper() in deleted}
    placed: dict[str, list[Row]] = defaultdict(list)
    for r in ctx.rows:
        if r.status in ("Field", "Cabinet Alarm"):
            placed[r.key].append(r)
    tq_rows = {n: t for t in ctx.tqs for n in t.rows}      # open, applied or closed: a TQ still explains the gap
    tq_tags = {_key(x): t for t in ctx.tqs for x in t.tags}
    for k, s in live.items():
        n = len(placed.get(k, []))
        if n == 1:
            c.ok()
        elif n == 0:
            t = tq_rows.get(s.row) or tq_tags.get(k)
            v = Violation(row=None, tag=s.tag, message=f"MDB row {s.row}: live tag {s.tag} is missing from the allocation"
                          + (f" — explained by {t.id}" if t else ""))
            (c.excuse if t else c.fail)(v)
        else:
            c.fail(placed[k][1].v(f"tag {s.tag} appears {n} times (rows {', '.join(str(r.n) for r in placed[k])})"))
    for k, rs_ in placed.items():
        if k not in live:
            why = "is DELETED in the MDB" if k in dead else "is not in the MDB"
            for r in rs_:
                c.fail(r.v(f"tag {r.tag} {why}"))
    return c.res


def c_unique_address(ctx: Ctx) -> CheckResult:
    c = Check("C02", "No duplicate CIOC / baseplate / channel", "capacity", ctx, always=True)
    seen: dict[tuple, Row] = {}
    for r in ctx.rows:
        k = (r.cab, r.cioc, r.baseplate, r.ch)
        if k in seen:
            c.fail(r.v(f"address {r.cioc} {r.baseplate} ch {r.ch} already used by row {seen[k].n}"))
        else:
            seen[k] = r
            c.ok()
    return c.res


def c_unique_pair(ctx: Ctx) -> CheckResult:
    c = Check("C03", "No duplicate cable + pair", "capacity", ctx, always=True)
    seen: dict[tuple, Row] = {}
    for r in ctx.rows:
        if r.cable == DASH or r.pair is None:
            continue
        k = (r.cable, r.pair)
        if k in seen:
            c.fail(r.v(f"{r.cable} pair {r.pair} already on row {seen[k].n}"))
        else:
            seen[k] = r
            c.ok()
    return c.res


def c_formula(ctx: Ctx) -> CheckResult:
    c = Check("C04", "CHARM_No = (baseplate − 1) × 12 + channel", "capacity", ctx, always=True)
    chs, bps = ctx.settings.channels_per_baseplate, ctx.settings.baseplates_per_cioc
    for r in ctx.rows:
        if r.bp is None or r.ch is None or r.charm_no is None:
            c.fail(r.v(f"unreadable address: baseplate '{r.baseplate}', channel '{r.d.get('Channel_No')}', CHARM_No '{r.d.get('CHARM_No')}'"))
        elif not (1 <= r.ch <= chs and 1 <= r.bp <= bps):
            c.fail(r.v(f"baseplate {r.bp} / channel {r.ch} out of range"))
        elif r.charm_no != (r.bp - 1) * chs + r.ch:
            c.fail(r.v(f"CHARM_No {r.charm_no} ≠ ({r.bp}−1)×{chs}+{r.ch} = {(r.bp - 1) * chs + r.ch}"))
        else:
            c.ok()
    return c.res


def c_bp_prefix(ctx: Ctx) -> CheckResult:
    c = Check("C05", "Baseplate prefix = CIOC sequence", "naming_pattern", ctx)
    pats = ctx.params("naming_pattern").get("patterns", {})
    bp_rx = pattern_parser(pats.get("baseplate", "{cioc3}-CBP-{bp}"))
    for r in ctx.rows:
        m = bp_rx.match(r.baseplate)
        if not m or r.cioc3 is None or "cioc3" not in m.groupdict():
            c.fail(r.v(f"cannot read CIOC sequence from '{r.cioc}' / '{r.baseplate}'"))
        elif int(m.group("cioc3")) != r.cioc3:
            c.fail(r.v(f"baseplate {r.baseplate} does not belong to CIOC {r.cioc3:03d}"))
        else:
            c.ok()
    return c.res


def c_cable(ctx: Ctx) -> CheckResult:
    c = Check("C06", "Cable pairs contiguous and in order", "cable_contiguous", ctx)
    if c.skip:
        return c.res
    chs = ctx.settings.channels_per_baseplate
    whole = int(ctx.params("cable_contiguous").get("whole_baseplate_min_pairs", chs))
    by: dict[str, list[Row]] = defaultdict(list)
    for r in ctx.rows:
        if r.cable != DASH and r.pair is not None and r.bp and r.ch:
            by[r.cable].append(r)
    for cable, rs_ in by.items():
        rs_.sort(key=lambda r: r.pair)  # type: ignore[arg-type, return-value]
        m = _SIZE.match(rs_[0].d.get("Field Cable Size", "") or "")
        size = int(m.group(1)) if m else max(r.pair for r in rs_)  # type: ignore[type-var]
        homes = {(r.cab, r.cioc) for r in rs_}
        lin = [((r.bp - 1) * chs + r.ch) - r.pair for r in rs_]  # type: ignore[operator]
        bad = None
        if len(homes) > 1:
            bad = f"cable {cable} is split across {len(homes)} CIOCs"
        elif len(set(lin)) > 1:
            bad = f"cable {cable} pairs are not contiguous / in order"
        elif size >= whole or size > chs // 2:
            if lin[0] % chs != 0:
                bad = f"{size}-pair cable {cable} does not start at channel 1 of a baseplate"
        elif len({r.bp for r in rs_}) > 1:
            bad = f"{size}-pair cable {cable} crosses a baseplate boundary"
        if bad:
            c.fail(rs_[0].v(bad))
        else:
            c.ok()
    return c.res


def c_segregation(ctx: Ctx) -> list[CheckResult]:
    """One check per segregate rule, at that rule's level (baseplate, CIOC or cabinet) and on that rule's field
    (default: the IO grouping). A field value is read from the MDB for the row's tag, else from the row's own column
    (wired spares); a blank or unrecognised value takes the rule's `default_family`."""
    out = []
    rules = [r for r in ctx.rs.rules if r.type == "segregate" and r.enabled]
    colmap = {f: c for c, f in ctx.params("output_map").get("columns", {}).items()}
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    tq_ids = {t.id for t in ctx.tqs}
    for n, rule in enumerate(rules):
        c = Check("C07" if n == 0 else f"C07.{n + 1}", rule.label or "Segregation", None, ctx)
        c.rule = rule
        c.res.rule_id, c.res.severity = rule.id, rule.severity
        fam_of = {m.strip().upper(): f for f, ms in rule.params.get("families", {}).items() for m in ms}
        dflt = rule.params.get("default_family")
        fld = rule.params.get("field") or "group"
        level = rule.params.get("level", "cioc")
        noun = {"cabinet": "cabinet", "baseplate": "baseplate"}.get(level, "CIOC")

        def value(r: Row) -> str:
            if fld == "group":
                return r.seg
            s = by_key.get(r.key) if r.status in ("Field", "Cabinet Alarm") else None
            if s is not None:
                v = getattr(s, fld, None) if fld in Signal.model_fields and fld != "extra" else s.extra.get(fld)
                return str(v or "").strip()
            return (r.d.get(colmap.get(fld, ""), "") or "").strip()

        by: dict[tuple, list[tuple[Row, str]]] = defaultdict(list)
        for r in ctx.rows:
            if r.status not in ("Field", "Wired Spare", "Cabinet Alarm"):
                continue
            f = fam_of.get(value(r).upper()) or dflt
            if f:
                key = (r.cab,) if level == "cabinet" else (r.cab, r.cioc, r.baseplate) if level == "baseplate" else (r.cab, r.cioc)
                by[key].append((r, f))
        for key, rs_ in by.items():
            where = key[-1]
            if len({f for _, f in rs_}) < 2:
                c.ok()
                continue
            excused, rest = [], []
            for r, f in rs_:
                remark = r.d.get("Remarks", "") or ""
                m = re.search(r"(TQ-[A-Z]+-\d+)", remark)
                # a Remarks edit must not be able to hide a violation: the cited TQ has to exist in this project's TQ register
                (excused if m and "except" in remark.lower() and m.group(1) in tq_ids else rest).append((r, f, m.group(1) if m else None))
            for r, f, tq in excused:
                c.excuse(r.v(f"{f} signal on {noun} {where} with another family — excepted by {tq}"))
            fams = Counter(f for _, f, _ in rest)
            if len(fams) < 2:
                c.ok()
                continue
            minority = min(fams, key=lambda f: (fams[f], f != "B"))
            others = ", ".join(f"{fams[f]} {f}" for f in sorted(fams) if f != minority)
            for r, f, _ in rest:
                if f == minority:
                    c.fail(r.v(f"{f}{'-family' if fld == 'group' else ''} {r.tag} shares {noun} {where} with {others}"
                               f"{'-family' if fld == 'group' else ''} signal(s) — rule {rule.id}"))
        out.append(c.res)
    return out


def c_group(ctx: Ctx) -> CheckResult:
    c = Check("C08", "Each IO grouping kept together, in consecutive cabinets", "group_together", ctx)
    if c.skip:
        return c.res
    p = ctx.params("group_together")
    ignore = {x.upper() for x in p.get("ignore", ["", "-"])}
    order: dict[tuple, list[str]] = defaultdict(list)     # domain → cabinets in physical order
    by: dict[tuple, list[Row]] = defaultdict(list)
    for r in ctx.rows:
        dom = (r.d.get("Technical Room", ""), r.d.get("Risk Area", ""))
        if r.status == "Field":
            if r.cab not in order[dom]:
                order[dom].append(r.cab)
            if r.seg.upper() not in ignore:
                by[(dom, r.seg)].append(r)
    for (dom, grp), rs_ in by.items():
        idx = sorted({order[dom].index(r.cab) for r in rs_})
        if idx != list(range(idx[0], idx[-1] + 1)):
            cabs = [order[dom][i] for i in idx]
            c.fail(rs_[0].v(f"group '{grp}' is split over non-consecutive cabinets ({', '.join(cabs)})"))
        else:
            c.ok()
    return c.res


def _hardware(ctx: Ctx, sctx: dict) -> dict[str, str] | None:
    p = ctx.params("hardware_map")
    lists = p.get("lists", {})
    row = first_match(p.get("rows", []), sctx, lists)
    if not row:
        return None
    hw = {"charm": row.get("charm", ""), "tb": row.get("tb", ""), "tb1": DASH, "tb2": DASH, "tb3": DASH, "loop_typical": DASH}
    for r in ctx.rs.rules:
        if r.type == "custom_expr" and r.enabled:
            try:
                cond, assigns = compiled_expr(r.params.get("expr", ""))
            except ExprError:
                continue
            if eval_cond(cond, sctx):
                hw.update(assigns)
    h2 = {**sctx, "charm": hw["charm"], "tb": hw["tb"]}
    t = first_match(p.get("terminals", []), h2, lists)
    if t:
        hw.update(tb1=t.get("tb1", DASH), tb2=t.get("tb2", DASH), tb3=t.get("tb3", DASH))
    lt = first_match(p.get("loop_typicals", []), h2, lists)
    if lt and hw["loop_typical"] == DASH:
        hw["loop_typical"] = lt.get("value", DASH)
    return hw


def _mapped_io(ctx: Ctx, raw: str) -> str:
    m = {k.upper(): v for k, v in ctx.params("io_type_map").get("map", {}).items()}
    return m.get(raw.upper().replace(" ", ""), "") if ctx.rule("io_type_map") else raw.upper()


HW_COLS = {"charm": "CHARM Type", "tb": "CHARM TB Part No", "loop_typical": "HW Loop Typical"}
TERM_COLS = {"tb1": "CHARM TB1", "tb2": "CHARM TB2", "tb3": "CHARM TB3"}


def _sig_ctx(ctx: Ctx, s: Signal, kind: str) -> dict:
    return {"io_type": _mapped_io(ctx, s.io_type_raw), "signal_type": s.signal_type, "signal_level": s.signal_level,
            "instrument_type": s.instrument_type, "instrument_desc": s.instrument_desc, "equipment": s.equipment,
            "kind": kind, "cable": s.cable, "group": s.group, "tag": s.tag, "room": s.room, "area": s.area, **s.extra}


def _spare_slot(ctx: Ctx) -> dict:
    """Hardware a slot with no cable must carry: the hardware map's `spare_slot`, else the catalogue's."""
    return ctx.params("hardware_map").get("spare_slot") or catalog().get("spare_slot") or {}


def _expected_hw(ctx: Ctx) -> Callable[[Row], tuple[dict | None, str, str | None]]:
    """Row → (expected hardware incl. terminals, description, error). Spare slots → the protection cover, no terminals.
    A wired spare is modelled on the first field signal of its IO type on its cable (skipping TQ-excepted clash rows),
    re-derived from the MDB so a tampered field row cannot cascade."""
    spare = _spare_slot(ctx)
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    field_on_cable: dict[tuple[str, str], list[Row]] = defaultdict(list)
    for r in ctx.rows:
        if r.status == "Field" and r.cable != DASH:
            field_on_cable[(r.cable, r.io)].append(r)

    def expect(r: Row) -> tuple[dict | None, str, str | None]:
        if r.status in ("Field", "Cabinet Alarm"):
            s = by_key.get(r.key)
            if s is None:
                return None, "", None  # reported by C01
            sctx = _sig_ctx(ctx, s, "cabinet_alarm" if r.status == "Cabinet Alarm" else "field")
            exp = _hardware(ctx, sctx)
            if exp is None:
                return None, "", f"no hardware-map row matches IO type {sctx['io_type']}"
            return exp, f"{r.tag} ({sctx['io_type']}, {s.instrument_type}, {s.signal_type}, {s.signal_level})", None
        if r.status == "Wired Spare":
            # modelled on the lowest pair of that IO type, preferring rows that are not a TQ-excepted clash
            tmpl = sorted(field_on_cable.get((r.cable, r.io), []),
                          key=lambda x: ("except" in (x.d.get("Remarks", "") or "").lower(), x.pair or 0))
            if not tmpl:
                return None, "", f"wired spare {r.tag} is {r.io} but cable {r.cable} carries no {r.io} field signal"
            t = tmpl[0]
            s = by_key.get(t.key)
            cols = {**HW_COLS, **TERM_COLS}
            exp = ({k: (t.d.get(col, "") or DASH).strip() or DASH for k, col in cols.items()} if s is None
                   else _hardware(ctx, _sig_ctx(ctx, s, "field")) or {})
            return exp, f"wired spare {r.tag} (modelled on {t.tag})", None
        if r.status == "Spare Slot":
            return {"charm": spare.get("charm", DASH), "tb": spare.get("tb", DASH), "tb1": DASH, "tb2": DASH, "tb3": DASH}, "spare slot", None
        return None, "", None

    return expect


def _diffs(r: Row, exp: dict, cols: dict[str, str]) -> list[str]:
    got = {k: (r.d.get(col, "") or DASH).strip() or DASH for k, col in cols.items()}
    return [f"{cols[k]} '{got[k]}' ≠ '{exp[k]}'" for k in cols if exp.get(k) is not None and got[k] != str(exp[k])]


def c_hardware(ctx: Ctx) -> CheckResult:
    c = Check("C09", "CHARM / terminal block match the hardware map", "hardware_map", ctx)
    if c.skip:
        return c.res
    cat = catalog()
    expect = _expected_hw(ctx)
    for r in ctx.rows:
        exp, what, err = expect(r)
        if err:
            c.fail(r.v(err))
            continue
        if exp is None:
            continue
        cols = {k: v for k, v in HW_COLS.items() if r.status != "Spare Slot" or k != "loop_typical"}
        diff = _diffs(r, exp, cols)
        dc = (r.d.get("Charm Description", "") or "").strip()
        dt = (r.d.get("CHARM TB Description", "") or "").strip()
        if exp.get("charm") in cat["charms"] and dc != cat["charms"][exp["charm"]]:
            diff.append(f"Charm Description '{dc}' ≠ catalogue '{cat['charms'][exp['charm']]}'")
        if exp.get("tb") in cat["terminal_blocks"] and dt != cat["terminal_blocks"][exp["tb"]]:
            diff.append(f"TB Description '{dt}' ≠ catalogue '{cat['terminal_blocks'][exp['tb']]}'")
        if diff:
            c.fail(r.v(f"{what}: " + "; ".join(diff)))
        else:
            c.ok()
    return c.res


def c_terminals(ctx: Ctx) -> CheckResult:
    """CHARM TB1/TB2/TB3 follow the terminal table (IO type × signal type × signal level × TB), re-derived from the MDB."""
    c = Check("C20", "CHARM TB terminals match the terminal table", "hardware_map", ctx)
    if c.skip:
        return c.res
    expect = _expected_hw(ctx)
    for r in ctx.rows:
        exp, what, err = expect(r)
        if err or exp is None:
            continue  # reported by C09 / C01
        diff = _diffs(r, exp, TERM_COLS)
        if diff:
            c.fail(r.v(f"{what}: " + "; ".join(diff)))
        else:
            c.ok()
    return c.res


def c_names(ctx: Ctx) -> CheckResult:
    c = Check("C10", "Names follow the project patterns", "naming_pattern", ctx)
    if c.skip:
        return c.res
    p = ctx.params("naming_pattern")
    pats = p.get("patterns", {})
    sides = p.get("sides", {})
    n = ctx.settings.ciocs_per_cabinet
    rx = {k: pattern_parser(pats[k]) for k in ("system_cabinet", "controller", "marshalling", "cioc", "baseplate") if k in pats}
    derive_spec = p.get("derive", {})
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    homes = cable_homes(ctx.signals, derive_spec, ctx.settings)   # a cable lands together: its rows share ONE location
    for r in ctx.rows:
        errs: list[str] = []
        got: dict[str, dict] = {}
        for k, col in (("system_cabinet", r.syscab), ("controller", r.controller), ("marshalling", r.cab), ("cioc", r.cioc),
                       ("baseplate", r.baseplate)):
            if k not in rx:
                continue
            m = rx[k].match(col)
            if not m:
                errs.append(f"{k.replace('_', ' ')} '{col}' does not match pattern {pats[k]}")
            else:
                got[k] = m.groupdict()
        toks: dict[str, str] = {}
        for k, d in got.items():
            for t, v in d.items():
                if t in toks and toks[t] != v and t not in ("bp",):
                    errs.append(f"token {{{t}}} disagrees between names ('{toks[t]}' vs '{v}' in {k.replace('_', ' ')})")
                toks.setdefault(t, v)
        cab2 = _int(got.get("marshalling", {}).get("cab2") or got.get("marshalling", {}).get("seq2") or "")
        if cab2 and r.cioc3 and not ((cab2 - 1) * n < r.cioc3 <= cab2 * n):
            errs.append(f"CIOC {r.cioc3:03d} is outside cabinet {cab2:02d} (expected {(cab2 - 1) * n + 1:03d}–{cab2 * n:03d})")
        if r.local:
            exp_side = sides.get(str(r.local)) or ("F" if r.local <= (n + 1) // 2 else "R")
            side = (r.d.get("Cabinet Side (F/R)", "") or "").strip()
            if side != exp_side:
                errs.append(f"side '{side}' ≠ '{exp_side}' for CIOC position {r.local}")
            vis = fmt(pats.get("visualization", "{dcm}({side})"), dcm=r.cab, side=exp_side)
            if (r.d.get("Cabinet Name for Visualization", "") or "").strip() != vis:
                errs.append(f"visualisation name ≠ '{vis}'")
        if r.status == "Wired Spare" and "wired_spare" in pats and r.cioc3 and r.bp and r.ch:
            exp = fmt(pats["wired_spare"], area4=toks.get("area4", ""), ctrl2=toks.get("ctrl2", ""), cioc3=f"{r.cioc3:03d}",
                      bp=r.bp, ch=r.ch, loc=toks.get("loc", ""), area=toks.get("area", ""))
            if r.tag != exp:
                errs.append(f"wired spare tag '{r.tag}' ≠ '{exp}'")
        if r.status in ("Field", "Wired Spare", "Cabinet Alarm", "Spare Slot"):
            dst = fmt(pats.get("dst", "{tag_nodash}_"), tag_nodash="" if r.status == "Spare Slot" else r.key.replace("-", ""))
            if (r.d.get("DSTName", "") or "").strip() != dst:
                errs.append(f"DSTName '{r.d.get('DSTName')}' ≠ '{dst}'")
        if r.status in ("Field", "Cabinet Alarm") and r.key in by_key and "loc" in toks:
            s = by_key[r.key]
            own = row_home(s, derive_spec, ctx.settings)
            home = homes.get(s.cable)
            loc, area = (home.loc, home.area_code) if home else (own.loc, own.area_code)
            if loc != toks.get("loc") or ("area" in toks and area != toks["area"]):
                via = f"; cable {s.cable} resolves to {loc}/{area}" if home and (loc, area) != (own.loc, own.area_code) else ""
                errs.append(f"{r.tag} (room {s.room}, area {s.area} → {own.loc}/{own.area_code}{via}) is in cabinet {r.cab}")
        if errs:
            c.fail(r.v("; ".join(errs)))
        else:
            c.ok()
    return c.res


def c_wired(ctx: Ctx) -> CheckResult:
    c = Check("C11", "Wired spares ≥ target per IO type per controller", "wired_spare_pct", ctx)
    if c.skip:
        return c.res
    p = ctx.params("wired_spare_pct")
    pct = float(p.get("pct", 10))
    by: dict[str, list[Row]] = defaultdict(list)
    for r in ctx.rows:
        by[r.controller].append(r)
    for ctrl, rs_ in by.items():
        f = Counter(r.io for r in rs_ if r.status == "Field")
        w = Counter(r.io for r in rs_ if r.status == "Wired Spare")
        for io, nf in f.items():
            target = math.ceil(nf * pct / 100 - 1e-9) if p.get("rounding", "ceil") == "ceil" else round(nf * pct / 100)
            if w[io] >= target:
                c.ok()
                continue
            io_cables = {r.cable for r in rs_ if r.status == "Field" and r.io == io and r.cable != DASH}
            free = [r for r in rs_ if r.status == "Spare Slot" and r.cable in io_cables and r.pair]
            v = Violation(message=f"{ctrl} {io}: {w[io]} wired spare(s) < target {target} ({pct:g}% of {nf})"
                          + (f" while {len(free)} free pair(s) remain on {io} cables" if free else " — no free pair left (shortfall TQ)"))
            (c.fail if free else c.excuse)(v)
    return c.res


def c_future(ctx: Ctx) -> CheckResult:
    c = Check("C12", "Future-spare baseplates kept free at the end of each cabinet", "future_spare_pct", ctx)
    if c.skip:
        return c.res
    p = ctx.params("future_spare_pct")
    n_c, n_b = ctx.settings.ciocs_per_cabinet, ctx.settings.baseplates_per_cioc
    total = n_c * n_b
    pct = float(p.get("pct", 10))
    need = math.ceil(total * pct / 100 - 1e-9) if p.get("rounding", "ceil") == "ceil" else round(total * pct / 100)
    need = min(need, total - 1)
    alarm = ctx.params("reserve_baseplate") if ctx.rule("reserve_baseplate") else {}
    alarm_key = (int(alarm.get("cioc", 1)), int(alarm.get("baseplate", 1))) if alarm else None
    order = [(cl, b) for cl in range(n_c, 0, -1) for b in range(n_b, 0, -1) if (cl, b) != alarm_key][:need]
    by: dict[str, dict[tuple, list[Row]]] = defaultdict(lambda: defaultdict(list))
    for r in ctx.rows:
        if r.local and r.bp:
            by[r.cab][(r.local, r.bp)].append(r)
    for cab, bps in by.items():
        bad = [(k, r) for k in order for r in bps.get(k, []) if r.status != "Spare Slot" or r.cable != DASH]
        if bad:
            (cl, b), r = bad[0]
            c.fail(r.v(f"{cab}: future-spare baseplate {b} of CIOC position {cl} is used ({len(bad)} slot(s))"))
        else:
            c.ok()
    return c.res


def c_grid(ctx: Ctx) -> CheckResult:
    """balanced: every CIOC position of every cabinet is present. compact: every CIOC that appears is complete."""
    label = "Full physical grid present for every " + ("instantiated CIOC" if ctx.compact else "cabinet")
    c = Check("C13", label, "capacity", ctx, always=True)
    n_c, n_b, n_ch = ctx.settings.ciocs_per_cabinet, ctx.settings.baseplates_per_cioc, ctx.settings.channels_per_baseplate
    by: dict[tuple, set] = defaultdict(set)
    first: dict[tuple, Row] = {}
    for r in ctx.rows:
        k = (r.cab, r.cioc) if ctx.compact else (r.cab,)
        by[k].add((r.local, r.bp, r.ch))
        first.setdefault(k, r)
    for k, got in by.items():
        locals_ = [first[k].local] if ctx.compact else range(1, n_c + 1)
        full = {(cl, b, ch) for cl in locals_ for b in range(1, n_b + 1) for ch in range(1, n_ch + 1)}
        miss = full - got
        if miss:
            c.fail(first[k].v(f"{' '.join(k)}: {len(miss)} of {len(full)} slots missing from the grid"))
        else:
            c.ok()
    return c.res


def c_cioc_count(ctx: Ctx) -> CheckResult:
    """The allocation rows, the Capacity/BOM workbook and the KPIs must name the same CIOCs. In compact mode an
    instantiated CIOC must hold at least one signal; in balanced mode C13 already demands every CIOC position."""
    c = Check("C19", "CIOC count agrees: allocation rows · BOM · KPIs", "capacity", ctx, always=True)
    ciocs: dict[tuple[str, str], list[Row]] = defaultdict(list)
    for r in ctx.rows:
        ciocs[(r.cab, r.cioc)].append(r)
    if ctx.compact:
        for (cab, cioc), rs_ in ciocs.items():
            if any(r.status in ("Field", "Wired Spare", "Cabinet Alarm") for r in rs_):
                c.ok()
            else:
                c.fail(rs_[0].v(f"CIOC {cioc} in {cab} is instantiated but holds no signal "
                                f"(cioc_strategy compact instantiates only CIOCs with signals)"))
    n = len(ciocs)
    kpi = ctx.claims.get("kpi_ciocs")
    if kpi is not None:
        if kpi == n:
            c.ok()
        else:
            c.fail(Violation(message=f"KPIs claim {kpi} CIOC(s) but the allocation rows instantiate {n}"))
    bom = ctx.claims.get("bom")
    if bom is not None and bom.get("error"):
        c.fail(Violation(message=f"Capacity/BOM workbook could not be read: {bom['error']}"))
    elif bom is not None:
        listed = set(bom.get("ciocs", []))
        rows_ = set(ciocs)
        total = bom.get("cabinet_total")
        if listed != rows_:
            extra, missing = sorted(listed - rows_), sorted(rows_ - listed)
            c.fail(Violation(message=f"BOM lists {len(listed)} CIOC(s), the allocation rows {n}"
                             + (f"; only in BOM: {', '.join(f'{a} {b}' for a, b in extra[:4])}" if extra else "")
                             + (f"; missing from BOM: {', '.join(f'{a} {b}' for a, b in missing[:4])}" if missing else "")))
        elif total is not None and total != n:
            c.fail(Violation(message=f"BOM 'Cabinets' sheet totals {total} CIOC(s), the allocation rows {n}"))
        else:
            c.ok()
    return c.res


def c_status(ctx: Ctx) -> CheckResult:
    c = Check("C14", "Tag Status discipline", "capacity", ctx, always=True)
    spare = _spare_slot(ctx).get("charm", "-")
    for r in ctx.rows:
        charm = (r.d.get("CHARM Type", "") or "").strip()
        e = None
        if r.status not in STATUSES:
            e = f"unknown Tag Status '{r.status}'"
        elif r.status == "Spare Slot":
            if r.tag != DASH or r.io != DASH or charm != spare:
                e = f"Spare Slot must have tag '-', IO type '-' and {spare} (has '{r.tag}', '{r.io}', {charm})"
        else:
            if r.tag == DASH or r.io == DASH:
                e = f"{r.status} row needs a tag and an IO type"
            elif charm == spare:
                e = f"{r.status} row cannot use the protection cover {spare}"
            elif r.status in ("Field", "Wired Spare") and r.cable == DASH:
                e = f"{r.status} row {r.tag} has no field cable"
        if e:
            c.fail(r.v(e))
        else:
            c.ok()
    return c.res


def c_alarm(ctx: Ctx) -> CheckResult:
    c = Check("C15", "Cabinet alarms on the reserved baseplate, exclusively", "reserve_baseplate", ctx)
    if c.skip:
        return c.res
    p = ctx.params("reserve_baseplate")
    cl, b0 = int(p.get("cioc", 1)), int(p.get("baseplate", 1))
    seq_rx = ctx.params("naming_pattern").get("derive", {}).get("cabinet_seq")
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    alarm_bps: set[tuple] = set()
    for r in ctx.rows:
        if r.status == "Cabinet Alarm":
            alarm_bps.add((r.cab, r.local, r.bp))
            if r.local != cl or (r.bp or 0) < b0:
                c.fail(r.v(f"cabinet alarm {r.tag} is on CIOC position {r.local} BP {r.bp}, not the reserved CIOC {cl} BP {b0}"))
                continue
            s = by_key.get(r.key)
            seq = derive(seq_rx, s.equipment) if s else None
            if seq and seq.isascii() and seq.isdigit():
                m = re.search(r"(\d+)\s*$", r.cab)
                if m and int(m.group(1)) != int(seq):
                    c.fail(r.v(f"cabinet alarm {r.tag} belongs to {s.equipment} but is in {r.cab}"))  # type: ignore[union-attr]
                    continue
            c.ok()
    for r in ctx.rows:
        if r.status in ("Field", "Wired Spare") and ((r.cab, r.local, r.bp) in alarm_bps or (r.local == cl and r.bp == b0)):
            c.fail(r.v(f"{r.status} {r.tag} sits on a reserved cabinet-alarm baseplate"))
    return c.res


def c_io_map(ctx: Ctx) -> CheckResult:
    c = Check("C16", "IO type mapped per the IO type map", "io_type_map", ctx)
    if c.skip:
        return c.res
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    for r in ctx.rows:
        if r.status in ("Field", "Cabinet Alarm") and r.key in by_key:
            exp = _mapped_io(ctx, by_key[r.key].io_type_raw)
            if r.io != exp:
                c.fail(r.v(f"IO type '{r.io}' ≠ mapped '{exp}' (MDB '{by_key[r.key].io_type_raw}')"))
            else:
                c.ok()
    return c.res


def c_output(ctx: Ctx) -> list[CheckResult]:
    """Column contract of the output_map rule, re-derived from the MDB (never from the engine).

    C17   (hard): every column whose edit changes meaning equals the MDB — the engineering columns copied from it, plus the
                  field cable number, size and pair. A wired spare's cable must be a real cable of the MDB with that cable's
                  size and its inherited values; a spare slot carries no signal data.
    C17.2 (soft): columns the rule lists in `soft_columns` (descriptive text), the rule's constants, the columns this project
                  never fills (`dash_columns`) and the row numbering. A warning, never a silent pass."""
    hard = Check("C17", "Identity and engineering columns equal the MDB", "output_map", ctx)
    soft = Check("C17.2", "Descriptive, constant and unused columns are as written", "output_map", ctx)
    if hard.skip:
        return [hard.res, soft.res]
    hard.res.severity, soft.res.severity = "hard", "soft"
    p = ctx.params("output_map")
    cols: dict[str, str] = p.get("columns", {})
    soft_cols: dict[str, str] = p.get("soft_columns", {})
    blank_for: dict[str, list[str]] = p.get("blank_for", {})
    consts: dict[str, str] = p.get("constants", {})
    dash_cols: list[str] = p.get("dash_columns", [])
    spare_inh, slot_inh = set(p.get("spare_inherit", [])), set(p.get("slot_inherit", []))
    pats = ctx.params("naming_pattern").get("patterns", {}) if ctx.rule("naming_pattern") else {}
    deleted = {x.upper() for x in ctx.settings.deleted_statuses}
    by_key = mdb_index(ctx.signals, deleted)
    live = [s for s in by_key.values() if (s.status or "").upper() not in deleted]

    def mdb(s: Signal, f: str) -> str:
        v = getattr(s, f, None) if f in Signal.model_fields and f != "extra" else s.extra.get(f)
        return (str(v).strip() if v is not None else "") or DASH

    def cell(r: Row, col: str) -> str:
        return (r.d.get(col, "") or "").strip() or DASH

    by_cable: dict[str, list[Signal]] = defaultdict(list)
    for s in live:
        if s.cable:
            by_cable[s.cable].append(s)
    by_cab: dict[str, list[Signal]] = defaultdict(list)
    for r in ctx.rows:
        if r.status in ("Field", "Cabinet Alarm") and r.key in by_key:
            by_cab[r.cab].append(by_key[r.key])

    for pos, r in enumerate(ctx.rows, start=1):
        h: list[str] = []      # hard differences
        w: list[str] = []      # soft differences

        def diff(col: str, exp: str, soft_: bool = False) -> None:
            got = cell(r, col)
            if col in r.d and got != exp:
                (w if soft_ or col in soft_cols else h).append(f"{col} '{got}' ≠ {'MDB ' if r.status in ('Field', 'Cabinet Alarm') else 'expected '}'{exp}'")

        def one_of(col: str, allowed: set[str], what: str) -> None:
            if col in r.d and cell(r, col) not in allowed:
                (w if col in soft_cols else h).append(f"{col} '{cell(r, col)}' is not a value of {what}")

        s = by_key.get(r.key) if r.status in ("Field", "Cabinet Alarm") else None
        if r.status in ("Field", "Cabinet Alarm") and s is not None:
            for col, f in cols.items():
                diff(col, DASH if col in blank_for.get(r.status, []) else mdb(s, f))
            # an internal-wiring alarm has no cable to land: it keeps a cable only when number, size and pair are all known
            cabled = bool(s.cable) and (r.status == "Field" or (s.cable_size and s.pair is not None))
            diff("Field Cable No", s.cable if cabled else DASH)
            diff("Field Cable Size", s.cable_spec if cabled else DASH)
            diff("Field Cable Pair", s.pair_label if cabled else DASH)
        elif r.status in ("Wired Spare", "Spare Slot"):
            members = by_cable.get(r.cable, []) if r.cable != DASH else []
            if r.cable == DASH:     # a slot with no cable carries no cable data (a Wired Spare without one is C14's finding)
                for col in ("Field Cable Size", "Field Cable Pair"):
                    diff(col, DASH)
            elif not members:
                h.append(f"Field Cable No '{r.cable}' is not a cable of the MDB")
            else:                   # an unused pair of a placed cable keeps that cable's number and size
                one_of("Field Cable Size", {m.cable_spec for m in members}, f"cable {r.cable}")
                if r.pair is None:
                    h.append(f"Field Cable Pair '{cell(r, 'Field Cable Pair')}' is not a pair number")
            if r.status == "Wired Spare":
                for col, f in cols.items():
                    if col in spare_inh and members:
                        one_of(col, {mdb(m, f) for m in members}, f"cable {r.cable}")
                    elif col not in spare_inh and col != "Service Description":
                        diff(col, DASH)
                if "spare_service" in pats and r.io != DASH:
                    diff("Service Description", fmt(pats["spare_service"], io2=r.io[:2]), soft_=True)
            else:
                here = by_cab.get(r.cab) or live
                for col, f in cols.items():
                    if col in slot_inh:
                        one_of(col, {mdb(m, f) for m in here} | {DASH}, f"cabinet {r.cab}")
                    else:
                        diff(col, DASH)
                diff("HW Loop Typical", DASH)
        for col in dash_cols:
            diff(col, DASH, soft_=True)
        for col, val in consts.items():
            diff(col, str(val), soft_=True)
        if "Sr. No." in r.d and cell(r, "Sr. No.") != str(pos):
            w.append(f"Sr. No. '{cell(r, 'Sr. No.')}' ≠ row position {pos}")
        (hard.fail(r.v("; ".join(h[:4]))) if h else hard.ok())
        (soft.fail(r.v("; ".join(w[:4]))) if w else soft.ok())
    return [hard.res, soft.res]


def c_capacity(ctx: Ctx) -> CheckResult:
    c = Check("C18", "Cabinets and controllers within configured limits", "capacity", ctx, always=True)
    per_ctrl: dict[str, set] = defaultdict(set)
    first: dict[str, Row] = {}
    for r in ctx.rows:
        per_ctrl[r.controller].add(r.cab)
        first.setdefault(r.controller, r)
    for ctrl, cabs in per_ctrl.items():
        if len(cabs) > ctx.settings.max_cabinets_per_controller:
            c.fail(first[ctrl].v(f"controller {ctrl} owns {len(cabs)} cabinets (max {ctx.settings.max_cabinets_per_controller})"))
        else:
            c.ok()
    return c.res


CHECKS: list[Callable[[Ctx], Any]] = [
    c_tags, c_unique_address, c_unique_pair, c_formula, c_bp_prefix, c_cable, c_segregation, c_group, c_hardware,
    c_terminals, c_names, c_wired, c_future, c_grid, c_status, c_alarm, c_io_map, c_output, c_capacity, c_cioc_count,
]


def verify_rows(raw_rows: list[dict[str, str]], signals: list[Signal], rs: RuleSet, settings: ProjectSettings,
                tqs: list[TQ] | None = None, source: str = "memory", file: str | None = None,
                missing_columns: list[str] | None = None, claims: dict[str, Any] | None = None) -> RuleCheckReport:
    """claims: optional CIOC counts from the other artefacts — {"kpi_ciocs": int, "bom": read_bom(...)}."""
    try:
        rows = parse_rows(raw_rows, settings, rs)
        ctx = Ctx(rows=rows, signals=signals, rs=rs, settings=settings, tqs=tqs or [], claims=claims or {})
    except Exception as e:  # unreadable rows: the verdict is FAIL (never a silent PASS, never a crash)
        bad = CheckResult(id="C00", label="Allocation rows can be read", failed=1,
                          violations=[Violation(message=f"rows could not be parsed: {type(e).__name__}: {e}")])
        return RuleCheckReport(source=source, file=file, checks=[bad], checks_total=1, checks_passed=0,  # type: ignore[arg-type]
                               violations=1, verdict="FAIL")
    results: list[CheckResult] = []
    if missing_columns is not None:
        res = CheckResult(id="C00", label="Workbook has every template column", passed=0 if missing_columns else 1,
                          failed=len(missing_columns),
                          violations=[Violation(row=1, message=f"missing column '{m}'") for m in missing_columns])
        results.append(res)
    for fn in CHECKS:
        crashed = False
        try:
            got = fn(ctx)
        except Exception as e:  # a malformed file must never crash the verifier — and a crashed check is a FAIL, never skipped
            crashed = True
            got = CheckResult(id=fn.__name__, label=fn.__name__, failed=1,
                              violations=[Violation(message=f"check could not run: {type(e).__name__}: {e}")])
        for res in (got if isinstance(got, list) else [got]):
            if not crashed and res.rule_id is None and fn not in (c_tags, c_unique_address, c_unique_pair, c_formula, c_grid, c_status,
                                                  c_capacity, c_cioc_count):
                continue  # rule disabled → check not applicable
            results.append(res)
    try:                       # custom rules: one dynamic check each (C23, C24, …); a failure here is a FAIL, never a crash
        from verify.custom import custom_checks
        results.extend(custom_checks(ctx))
    except Exception as e:  # noqa: BLE001
        results.append(CheckResult(id="C23", label="Custom rules can be checked", failed=1,
                                   violations=[Violation(message=f"custom-rule checks could not run: {type(e).__name__}: {e}")]))
    hard = sum(r.failed for r in results if r.severity == "hard")
    soft = sum(r.failed for r in results if r.severity == "soft")
    return RuleCheckReport(source=source, file=file, checks=results, checks_total=len(results),  # type: ignore[arg-type]
                           checks_passed=sum(1 for r in results if r.failed == 0), violations=hard, warnings=soft,
                           excepted=sum(r.excepted for r in results), verdict="PASS" if hard == 0 else "FAIL")
