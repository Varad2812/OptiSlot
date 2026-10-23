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

from app.ruleslang import ExprError, catalog, compiled_expr, derive, eval_cond, first_match, fmt, match_when
from app.schemas import CheckResult, ProjectSettings, RuleCheckReport, RuleSet, Signal, TQ, Violation

DASH = "-"
STATUSES = {"Field", "Wired Spare", "Spare Slot", "Cabinet Alarm"}
MAX_LISTED = 250
TOKEN_RX = {"cioc3": r"\d{3}", "bp": r"\d+", "ch": r"\d+", "ctrl2": r"\d{2}", "cab2": r"\d{2}", "seq2": r"\d{2}",
            "side": r"[A-Za-z]+", "area4": r"\d{4}", "area": r"[0-9A-Za-z]+", "loc": r"[0-9A-Za-z]+"}
_SIZE = re.compile(r"^\s*0*(\d{1,3})\s*[PTQ]?X", re.I)


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
    return re.compile("^" + "".join(out) + "$")


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
    seg = next((r.params for r in rs.rules if r.type == "segregate" and r.enabled), {})
    fam_of = {m.upper(): f for f, ms in seg.get("families", {}).items() for m in ms}
    out = []
    for i, d in enumerate(raw, start=2):
        g = lambda c: (d.get(c) or "").strip() or DASH  # noqa: E731
        r = Row(n=i, d=d, status=g("Tag Status"), tag=g("Tag Name"), key=_key(g("Tag Name")), io=g("IO Type"),
                cab=g("Electronic/ Marshalling Cabinet"), cioc=g("CIOC/CSLS Name"), baseplate=g("Baseplate"),
                controller=g("Controller"), syscab=g("System Cabinet"), cable=g("Field Cable No"),
                pair=_int(re.sub(r"\D", "", g("Field Cable Pair")) or "x"), ch=_int(g("Channel_No")),
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
    tq_rows = {n: t for t in ctx.tqs if t.status != "closed" for n in t.rows}
    tq_tags = {_key(x): t for t in ctx.tqs if t.status != "closed" for x in t.tags}
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


def c_segregation(ctx: Ctx) -> CheckResult:
    c = Check("C07", "A and B never on one CIOC", "segregate", ctx)
    if c.skip:
        return c.res
    by: dict[tuple, list[Row]] = defaultdict(list)
    for r in ctx.rows:
        if r.status in ("Field", "Wired Spare", "Cabinet Alarm") and r.family in ("A", "B"):
            by[(r.cab, r.cioc)].append(r)
    for (cab, cioc), rs_ in by.items():
        if len({r.family for r in rs_}) < 2:
            c.ok()
            continue
        excused, rest = [], []
        for r in rs_:
            remark = r.d.get("Remarks", "") or ""
            m = re.search(r"(TQ-[A-Z]+-\d+)", remark)
            (excused if m and "except" in remark.lower() else rest).append((r, m.group(1) if m else None))
        for r, tq in excused:
            c.excuse(r.v(f"{r.family} signal on {cioc} with the other family — excepted by {tq}"))
        fams = Counter(r.family for r, _ in rest)
        if len(fams) < 2:
            c.ok()
            continue
        minority = min(fams, key=lambda f: (fams[f], f != "B"))
        other = "A" if minority == "B" else "B"
        for r, _ in rest:
            if r.family == minority:
                c.fail(r.v(f"{r.family}-family {r.tag} shares CIOC {cioc} with {fams[other]} {other}-family signal(s)"))
    return c.res


def c_group(ctx: Ctx) -> CheckResult:
    c = Check("C08", "Each IO grouping kept together in one cabinet", "group_together", ctx)
    if c.skip:
        return c.res
    p = ctx.params("group_together")
    ignore = {x.upper() for x in p.get("ignore", ["", "-"])}
    by: dict[str, list[Row]] = defaultdict(list)
    for r in ctx.rows:
        if r.status == "Field" and r.seg.upper() not in ignore:
            by[r.seg].append(r)
    for grp, rs_ in by.items():
        cabs = sorted({r.cab for r in rs_})
        if len(cabs) > 1:
            c.fail(rs_[0].v(f"group '{grp}' is spread over {len(cabs)} cabinets ({', '.join(cabs)})"))
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


def c_hardware(ctx: Ctx) -> CheckResult:
    c = Check("C09", "CHARM / terminal block match the hardware map", "hardware_map", ctx)
    if c.skip:
        return c.res
    cat = catalog()
    spare = ctx.params("hardware_map").get("spare_slot", {"charm": "SE6103", "tb": "SE4501"})
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    field_on_cable: dict[tuple[str, str], list[Row]] = defaultdict(list)
    for r in ctx.rows:
        if r.status == "Field" and r.cable != DASH:
            field_on_cable[(r.cable, r.io)].append(r)
    cols = {"charm": "CHARM Type", "tb": "CHARM TB Part No", "tb1": "CHARM TB1", "tb2": "CHARM TB2", "tb3": "CHARM TB3",
            "loop_typical": "HW Loop Typical"}

    def compare(r: Row, exp: dict[str, str], what: str) -> None:
        got = {k: (r.d.get(col, "") or DASH).strip() or DASH for k, col in cols.items()}
        diff = [f"{cols[k]} '{got[k]}' ≠ '{exp[k]}'" for k in cols if exp.get(k) is not None and got[k] != str(exp[k])]
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

    for r in ctx.rows:
        if r.status in ("Field", "Cabinet Alarm"):
            s = by_key.get(r.key)
            if s is None:
                continue  # reported by C01
            sctx = {"io_type": _mapped_io(ctx, s.io_type_raw), "signal_type": s.signal_type, "signal_level": s.signal_level,
                    "instrument_type": s.instrument_type, "instrument_desc": s.instrument_desc, "equipment": s.equipment,
                    "kind": "cabinet_alarm" if r.status == "Cabinet Alarm" else "field", "cable": s.cable, "group": s.group,
                    "tag": s.tag, "room": s.room, "area": s.area, **s.extra}
            exp = _hardware(ctx, sctx)
            if exp is None:
                c.fail(r.v(f"no hardware-map row matches IO type {sctx['io_type']}"))
            else:
                compare(r, exp, f"{r.tag} ({sctx['io_type']}, {s.instrument_type})")
        elif r.status == "Wired Spare":
            tmpl = sorted(field_on_cable.get((r.cable, r.io), []), key=lambda x: x.pair or 0)
            if not tmpl:
                c.fail(r.v(f"wired spare {r.tag} is {r.io} but cable {r.cable} carries no {r.io} field signal"))
                continue
            t = tmpl[0]
            s = by_key.get(t.key)
            if s is None:
                exp = {k: (t.d.get(col, "") or DASH).strip() or DASH for k, col in cols.items()}
            else:  # expectation re-derived from the MDB, so a tampered field row cannot cascade
                exp = _hardware(ctx, {"io_type": _mapped_io(ctx, s.io_type_raw), "signal_type": s.signal_type,
                                      "signal_level": s.signal_level, "instrument_type": s.instrument_type,
                                      "instrument_desc": s.instrument_desc, "equipment": s.equipment, "kind": "field",
                                      "cable": s.cable, "group": s.group, "tag": s.tag, "room": s.room, "area": s.area,
                                      **s.extra}) or {}
            compare(r, exp, f"wired spare {r.tag} (modelled on {t.tag})")
        elif r.status == "Spare Slot":
            got = (r.d.get("CHARM Type", "") or "").strip(), (r.d.get("CHARM TB Part No", "") or "").strip()
            terms = [(r.d.get(x, "") or DASH).strip() or DASH for x in ("CHARM TB1", "CHARM TB2", "CHARM TB3")]
            if got != (spare.get("charm"), spare.get("tb")) or any(t != DASH for t in terms):
                c.fail(r.v(f"spare slot hardware {got[0]} / {got[1]} (terminals {terms}) ≠ {spare.get('charm')} / {spare.get('tb')}, no terminals"))
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
        if r.status in ("Field", "Wired Spare", "Cabinet Alarm"):
            dst = fmt(pats.get("dst", "{tag_nodash}_"), tag_nodash=r.key.replace("-", ""))
            if (r.d.get("DSTName", "") or "").strip() != dst:
                errs.append(f"DSTName '{r.d.get('DSTName')}' ≠ '{dst}'")
        if r.status in ("Field", "Cabinet Alarm") and r.key in by_key and "loc" in toks:
            s = by_key[r.key]
            loc = derive(derive_spec.get("loc"), s.room) or ctx.settings.loc_prefix_default
            area = derive(derive_spec.get("area"), s.area) or ctx.settings.area_code_default
            if loc != toks.get("loc") or ("area" in toks and area != toks["area"]):
                errs.append(f"{r.tag} (room {s.room}, area {s.area} → {loc}/{area}) is in cabinet {r.cab}")
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
    c = Check("C13", "Full physical grid present for every cabinet", "capacity", ctx, always=True)
    n_c, n_b, n_ch = ctx.settings.ciocs_per_cabinet, ctx.settings.baseplates_per_cioc, ctx.settings.channels_per_baseplate
    by: dict[str, set] = defaultdict(set)
    first: dict[str, Row] = {}
    for r in ctx.rows:
        by[r.cab].add((r.local, r.bp, r.ch))
        first.setdefault(r.cab, r)
    full = {(cl, b, ch) for cl in range(1, n_c + 1) for b in range(1, n_b + 1) for ch in range(1, n_ch + 1)}
    for cab, got in by.items():
        miss = full - got
        if miss:
            c.fail(first[cab].v(f"{cab}: {len(miss)} of {len(full)} slots missing from the grid"))
        else:
            c.ok()
    return c.res


def c_status(ctx: Ctx) -> CheckResult:
    c = Check("C14", "Tag Status discipline", "capacity", ctx, always=True)
    spare = ctx.params("hardware_map").get("spare_slot", {"charm": "SE6103"}).get("charm", "SE6103")
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
            if seq and seq.isdigit():
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


def c_output(ctx: Ctx) -> CheckResult:
    c = Check("C17", "Engineering columns copied from the MDB", "output_map", ctx)
    if c.skip:
        return c.res
    cols: dict[str, str] = ctx.params("output_map").get("columns", {})
    by_key = mdb_index(ctx.signals, {x.upper() for x in ctx.settings.deleted_statuses})
    for r in ctx.rows:
        if r.status != "Field" or r.key not in by_key:
            continue
        s = by_key[r.key]
        diffs = []
        for col, f in cols.items():
            exp = getattr(s, f, None) if f in Signal.model_fields and f != "extra" else s.extra.get(f)
            exp = (str(exp).strip() if exp is not None else "") or DASH
            got = (r.d.get(col, "") or "").strip() or DASH
            if col in r.d and got != exp:
                diffs.append(f"{col} '{got}' ≠ MDB '{exp}'")
        if diffs:
            c.fail(r.v("; ".join(diffs[:4])))
        else:
            c.ok()
    return c.res


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


CHECKS: list[Callable[[Ctx], CheckResult]] = [
    c_tags, c_unique_address, c_unique_pair, c_formula, c_bp_prefix, c_cable, c_segregation, c_group, c_hardware,
    c_names, c_wired, c_future, c_grid, c_status, c_alarm, c_io_map, c_output, c_capacity,
]


def verify_rows(raw_rows: list[dict[str, str]], signals: list[Signal], rs: RuleSet, settings: ProjectSettings,
                tqs: list[TQ] | None = None, source: str = "memory", file: str | None = None,
                missing_columns: list[str] | None = None) -> RuleCheckReport:
    rows = parse_rows(raw_rows, settings, rs)
    ctx = Ctx(rows=rows, signals=signals, rs=rs, settings=settings, tqs=tqs or [])
    results: list[CheckResult] = []
    if missing_columns is not None:
        res = CheckResult(id="C00", label="Workbook has every template column", passed=0 if missing_columns else 1,
                          failed=len(missing_columns),
                          violations=[Violation(row=1, message=f"missing column '{m}'") for m in missing_columns])
        results.append(res)
    for fn in CHECKS:
        try:
            res = fn(ctx)
        except Exception as e:  # a malformed file must never crash the verifier
            res = CheckResult(id=fn.__name__, label=fn.__name__, failed=1,
                              violations=[Violation(message=f"check could not run: {type(e).__name__}: {e}")])
        if res.rule_id is None and res.id not in ("C00",) and fn not in (c_tags, c_unique_address, c_unique_pair, c_formula,
                                                                          c_grid, c_status, c_capacity):
            continue  # rule disabled → check not applicable
        results.append(res)
    hard = sum(r.failed for r in results if r.severity == "hard")
    soft = sum(r.failed for r in results if r.severity == "soft")
    return RuleCheckReport(source=source, file=file, checks=results, checks_total=len(results),  # type: ignore[arg-type]
                           checks_passed=sum(1 for r in results if r.failed == 0), violations=hard, warnings=soft,
                           excepted=sum(r.excepted for r in results), verdict="PASS" if hard == 0 else "FAIL")
