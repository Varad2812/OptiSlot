"""Hardware resolution: CHARM + terminal block + TB terminals + HW loop typical, all from rules."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from engine.rules import ExprError, Rules, catalog, compiled_expr, eval_cond, first_match, match_when


@dataclass
class Hardware:
    charm: str = ""
    tb: str = ""
    tb1: str = "-"
    tb2: str = "-"
    tb3: str = "-"
    loop_typical: str = "-"
    tq: str | None = None            # a hardware row asked for a TQ (e.g. unknown DO type)
    review: str | None = None        # PS-conflict review message (candidate TQ)
    why: list[tuple[str | None, str]] = field(default_factory=list)

    @property
    def charm_desc(self) -> str:
        return catalog()["charms"].get(self.charm, self.charm or "-")

    @property
    def tb_desc(self) -> str:
        return catalog()["terminal_blocks"].get(self.tb, self.tb or "-")


def signal_ctx(s, **over: Any) -> dict[str, Any]:
    ctx = {
        "io_type": s.io_type, "signal_type": s.signal_type, "signal_level": s.signal_level,
        "instrument_type": s.instrument_type, "instrument_desc": s.instrument_desc, "equipment": s.equipment,
        "kind": s.kind, "cable": s.cable, "group": s.group, "tag": s.tag, "room": s.room, "area": s.area,
        **{k: v for k, v in s.extra.items()},
    }
    ctx.update(over)
    return ctx


def resolve(ctx: dict[str, Any], rules: Rules) -> Hardware:
    hw = Hardware()
    hm = rules.first("hardware_map")
    p = hm.params if hm else {}
    lists = p.get("lists", {})
    row = first_match(p.get("rows", []), ctx, lists) if hm else None
    if row:
        hw.charm, hw.tb = row.get("charm", ""), row.get("tb", "")
        hw.tq = row.get("tq")
        hw.why.append((hm.id, f"{ctx.get('io_type')} → {hw.charm} + {hw.tb}"
                       + (f" (instrument {ctx.get('instrument_type')})" if ctx.get("io_type") == "DOR" else "")))
    for r in rules.all("custom_expr"):
        try:
            cond, assigns = compiled_expr(r.params.get("expr", ""))
        except ExprError:
            continue
        if eval_cond(cond, ctx):
            for k, v in assigns.items():
                setattr(hw, k, v)
            if "charm" in assigns:
                hw.tq = None
            hw.why.append((r.id, f"custom rule: {r.label}"))
    if hm:
        review = p.get("review")
        if review and hw.charm != "SE4302T02" and any(match_when(w, ctx, lists) for w in review.get("when_any", [])):
            hw.review = review.get("message")
        hctx = {**ctx, "charm": hw.charm, "tb": hw.tb}
        t = first_match(p.get("terminals", []), hctx, lists)
        if t:
            hw.tb1, hw.tb2, hw.tb3 = t.get("tb1", "-"), t.get("tb2", "-"), t.get("tb3", "-")
        lt = first_match(p.get("loop_typicals", []), hctx, lists)
        if lt and hw.loop_typical == "-":
            hw.loop_typical = lt.get("value", "-")
    return hw


def spare_slot_hw(rules: Rules) -> tuple[str, str]:
    p = rules.params("hardware_map").get("spare_slot", {})
    return p.get("charm", "SE6103"), p.get("tb", "SE4501")
