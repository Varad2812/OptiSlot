"""Signal listing for the Signal Workbench: EVERY MDB signal with where it is, why, and what would fix it.

States
    allocated     has a slot, no open TQ
    warning       has a slot and an open TQ is linked to it
    unallocated   valid data but the engine could not place it (capacity, no feasible layout, a failed domain)
    quarantined   rejected before allocation because of its data (missing tag/cable/pair, unknown IO type, duplicates …)
    deleted       not live in the MDB (Status DELETED)

The index is light (no copies of the 143 source columns); full rows are built for the requested page only.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from app.schemas import (
    Signal, SignalCounts, SignalFix, SignalHardware, SignalList, SignalLocation, SignalRow, Slot, TQ, QuarantineRow,
)

STATES = ("allocated", "warning", "unallocated", "quarantined", "deleted")
SORTS = ("row", "tag", "io_type", "cable", "state", "cabinet", "cioc", "slot")


@dataclass
class Idx:
    s: Signal
    state: str
    slot: Slot | None = None
    tq_ids: list[str] = field(default_factory=list)
    q: QuarantineRow | None = None


def tag_key(tag: str) -> str:
    return re.sub(r"\s+", "", tag or "")


def is_flag(s: Signal) -> bool | None:
    """True = intrinsically safe (IS), False = NON-IS, None = the MDB does not say."""
    v = (s.extra.get("is_type") or "").strip().upper()
    if v in ("", "-"):
        return None
    if v.startswith("NON") or v.startswith("N-"):
        return False
    return v.startswith("IS") or v.startswith("I.S") or "INTRINSIC" in v


def build_index(comp) -> list[Idx]:
    out = comp.out
    slot_by_row: dict[int, Slot] = {}
    for sl in out.alloc.slots:
        if sl.status in ("Field", "Cabinet Alarm") and sl.source_row is not None:
            slot_by_row.setdefault(sl.source_row, sl)
    q_by_row = {q.row: q for q in out.quarantine}
    unplaced = {s.row for s in out.alloc.unplaced}
    row_tq: dict[int, list[str]] = defaultdict(list)
    tag_tq: dict[str, list[str]] = defaultdict(list)
    open_ids = {t.id for t in comp.tqs if t.status == "open"}
    for t in comp.tqs:
        for r in t.rows:
            row_tq[r].append(t.id)
        for g in t.tags:
            tag_tq[tag_key(g)].append(t.id)
    idx: list[Idx] = []
    for s in out.signals:
        slot = slot_by_row.get(s.row)
        ids = list(dict.fromkeys([*row_tq.get(s.row, []), *tag_tq.get(s.tag_key, []), *(slot.tq_ids if slot else [])]))
        q = q_by_row.get(s.row)
        if not s.live:
            state = "deleted"
        elif s.quarantined or slot is None:
            state = "unallocated" if (s.row in unplaced or (slot is None and not s.quarantined)) else "quarantined"
        else:
            state = "warning" if any(i in open_ids for i in ids) else "allocated"
        idx.append(Idx(s=s, state=state, slot=slot if state in ("allocated", "warning") else None, tq_ids=ids, q=q))
    return idx


# ───────────────────────────── explanations and fixes ─────────────────────────────

def _first(texts: list[str], n: int = 3) -> str:
    seen, keep = set(), []
    for t in texts:
        t = (t or "").strip()
        if t and t not in seen:
            seen.add(t)
            keep.append(t)
    return "; ".join(keep[:n])


def reason_for(ix: Idx, tqs: dict[str, TQ]) -> str:
    s, slot = ix.s, ix.slot
    linked = [tqs[i] for i in ix.tq_ids if i in tqs]
    if ix.state == "deleted":
        return f"Status '{s.status}' in the MDB — the signal is deleted, so it has no slot."
    if ix.state in ("quarantined", "unallocated"):
        why = (ix.q.reason if ix.q else None) or s.quarantine_reason or "no slot found for this signal"
        head = ("Quarantined — its data cannot be allocated: " if ix.state == "quarantined" else "Not placed — the data is valid but the engine could not fit it: ") + why + "."
        tq = next((t for t in linked if t.status != "closed"), linked[0] if linked else None)
        return head + (f" {tq.id}: {tq.message}" if tq else "")
    assert slot is not None
    where = f"{slot.cabinet} · CIOC {slot.cioc_seq:03d} · baseplate {slot.bp} · channel {slot.ch}"
    txt = f"{s.cable or 'no cable'}{f' pair {s.pair}' if s.pair else ''} sits at {where}."
    why = _first([w.text for w in slot.why if w.text and not w.text.startswith("Controller domain")], 3)
    if why:
        txt += " " + why + "."
    if slot.remarks not in ("", "-"):
        txt += f" Remarks: {slot.remarks}"
    open_tq = [t for t in linked if t.status == "open"]
    if open_tq:
        txt += f" Open TQ {open_tq[0].id}: {open_tq[0].message}"
    return txt


def _free_pairs(ix: Idx, all_signals: list[Signal], limit: int = 6) -> list[int]:
    s = ix.s
    if not s.cable:
        return []
    size = s.cable_size or max((x.pair or 0 for x in all_signals if x.cable == s.cable), default=0)
    used = {x.pair for x in all_signals if x.cable == s.cable and x.live and not x.quarantined and x.pair}
    return [p for p in range(1, size + 1) if p not in used][:limit]


def fixes_for(ix: Idx, tqs: dict[str, TQ], by_cable: dict[str, list[Signal]], io_map: dict[str, str],
              rule_ids: list[str]) -> list[SignalFix]:
    s = ix.s
    fixes: list[SignalFix] = []
    if ix.state in ("allocated", "deleted"):
        return fixes
    for tid in ix.tq_ids:
        t = tqs.get(tid)
        if t is None or t.status == "closed":
            continue
        for fo in t.fix_options:
            kind = "rule_patch" if fo.rule_patch else "data_patch" if fo.data_patch else "info"
            fixes.append(SignalFix(label=f"{t.id}: {fo.label}", kind=kind, patch=fo.rule_patch or fo.data_patch))
    if ix.state == "warning":
        return fixes
    why = ((ix.q.reason if ix.q else None) or s.quarantine_reason or "").lower()
    pairs = _free_pairs(ix, by_cable.get(s.cable, []))
    pair_problem = ("missing pair" in why or "unreadable pair" in why or re.search(r"duplicate of \S+ pair", why)
                    or re.search(r"pair \d+ > cable size", why))
    if "unknown io type" in why:
        raw = sorted({k for k, v in io_map.items() if k != v})[:6] or ["AI", "AO", "DI", "DO"]
        fixes += [SignalFix(label=f"Set the IO type to {v}", kind="data_patch", patch={"fields": {"io_type": v}}) for v in raw]
    elif pair_problem:
        fixes += [SignalFix(label=f"Set the pair to {p} (free on cable {s.cable})", kind="data_patch", patch={"fields": {"pair": str(p)}})
                  for p in pairs]
        if not pairs and s.cable:
            fixes.append(SignalFix(label=f"Cable {s.cable} has no free pair — move the signal to another cable", kind="info",
                                   patch={"field": "cable", "needs_value": True}))
        if "> cable size" in why:
            fixes.append(SignalFix(label="Correct the cable spec if the cable is bigger than stated", kind="info",
                                   patch={"field": "cable_spec", "needs_value": True}))
    elif "missing cable" in why:
        fixes.append(SignalFix(label="Give the signal a cable number", kind="data_patch", patch={"field": "cable", "needs_value": True}))
    elif "duplicate of row" in why:
        fixes.append(SignalFix(label="Rename the tag", kind="data_patch", patch={"field": "tag", "needs_value": True}))
        fixes.append(SignalFix(label="Mark the duplicate row as deleted", kind="data_patch", patch={"fields": {"status": "DELETED"}}))
    elif "no tag" in why:
        fixes.append(SignalFix(label="Give the row a tag", kind="data_patch", patch={"field": "tag", "needs_value": True}))
    elif "no capacity" in why or "larger than a cioc" in why:
        fixes.append(SignalFix(label="Raise 'max cabinets per domain' in Project Settings, or free capacity", kind="info",
                               patch={"settings": "max_cabinets_per_domain"}))
        fixes.append(SignalFix(label="Place the cable by hand on a free baseplate (POST /placement/check)", kind="placement"))
    elif "no feasible layout" in why:
        fixes += [SignalFix(label=f"Switch rule {rid} off to place it (the rule can no longer be met)", kind="rule_patch",
                            patch={"rule_id": rid, "op": "toggle", "value": False}) for rid in rule_ids[:3]]
        fixes.append(SignalFix(label="Place the cable by hand on a free baseplate (POST /placement/check)", kind="placement"))
    elif why.startswith("sys-"):
        fixes.append(SignalFix(label="Send this dataset and the TQ message to the OptiSlot team", kind="info"))
    return fixes


def location_of(sl: Slot) -> SignalLocation:
    return SignalLocation(cabinet=sl.cabinet, cabinet_seq=sl.cabinet_seq, controller=sl.controller, cioc=sl.cioc, cioc_seq=sl.cioc_seq,
                          cioc_local=sl.cioc_local, side=sl.side, baseplate=sl.baseplate, bp=sl.bp, ch=sl.ch, charm_no=sl.charm_no,
                          slot_id=sl.id)


def hardware_of(sl: Slot) -> SignalHardware:
    return SignalHardware(charm=sl.charm, charm_desc=sl.charm_desc, tb=sl.tb, tb_desc=sl.tb_desc, tb1=sl.tb1, tb2=sl.tb2, tb3=sl.tb3)


class Ctx:
    """Everything a row needs, computed once per request."""

    def __init__(self, comp):
        self.comp = comp
        self.out = comp.out
        self.tqs = {t.id: t for t in comp.tqs}
        self.src = {n: rec for n, rec in comp.out.table.rows}
        self.by_cable: dict[str, list[Signal]] = defaultdict(list)
        for s in comp.out.signals:
            if s.cable:
                self.by_cable[s.cable].append(s)
        self.io_map = comp.out.rules.params("io_type_map").get("map", {}) if comp.out.rules.first("io_type_map") else {}
        self.block_of = {m.tag_key: b.id for b in comp.out.alloc.blocks for m in b.members.values()}


def to_row(ix: Idx, cx: Ctx) -> SignalRow:
    s, slot = ix.s, ix.slot
    from_why = [w.rule_id for w in slot.why if w.rule_id] if slot else []
    rule_ids = list(dict.fromkeys([*from_why, *(r for i in ix.tq_ids if i in cx.tqs for r in cx.tqs[i].rules_in_conflict)]))
    block_id = slot.block_id if slot else cx.block_of.get(s.tag_key) if ix.state == "unallocated" else None
    norm = s.model_dump(mode="json")
    return SignalRow(
        tag=s.tag or "-", tag_key=s.tag_key, row=s.row, state=ix.state,  # type: ignore[arg-type]
        tag_status=slot.status if slot else "-", io_type=s.io_type or "-", io_type_raw=s.io_type_raw or "-",
        instrument_type=s.instrument_type, cable=s.cable or "-", pair=s.pair, cable_size=s.cable_size, family=s.family,
        group=s.group, is_flag=is_flag(s), reason=reason_for(ix, cx.tqs), rule_ids=rule_ids, tq_ids=ix.tq_ids,
        fixes=fixes_for(ix, cx.tqs, cx.by_cable, cx.io_map, rule_ids),
        location=location_of(slot) if slot else None, hardware=hardware_of(slot) if slot else None,
        block_id=block_id, can_move=bool(slot and slot.status == "Field" and slot.block_id) or (ix.state == "unallocated" and bool(block_id)),
        quarantine_reason=(ix.q.reason if ix.q else s.quarantine_reason), source=dict(cx.src.get(s.row, {})), normalised=norm,
    )


# ───────────────────────────── listing ─────────────────────────────

def _haystack(ix: Idx) -> str:
    s, sl = ix.s, ix.slot
    parts = [s.tag, s.tag_key, s.cable, s.instrument_type, s.extra.get("service", ""), s.equipment, s.io_type, s.io_type_raw,
             s.group, s.area, s.room]
    if sl:
        parts += [sl.cabinet, sl.cioc, sl.baseplate, sl.id]
    return " ".join(p for p in parts if p).lower()


def _match(ix: Idx, f: dict[str, Any], skip: str | None = None) -> bool:
    s, sl = ix.s, ix.slot
    if skip != "q" and f.get("q") and f["q"].lower() not in _haystack(ix):
        return False
    if skip != "io_type" and f.get("io_type"):
        want = {x.strip().upper() for x in f["io_type"].split(",") if x.strip()}
        if (s.io_type or "").upper() not in want and (s.io_type_raw or "").upper() not in want:
            return False
    if skip != "status" and f.get("status"):
        want = {x.strip().lower() for x in f["status"].split(",") if x.strip()}
        if ix.state not in want and (sl.status.lower() if sl else "") not in want:
            return False
    if skip != "cabinet" and f.get("cabinet"):
        if not sl or f["cabinet"].lower() not in sl.cabinet.lower():
            return False
    if skip != "cioc" and f.get("cioc"):
        c = f["cioc"].strip().lower()
        if not sl or not (c in sl.cioc.lower() or (c.isdigit() and int(c) == sl.cioc_seq)):
            return False
    if skip != "cable" and f.get("cable") and f["cable"].lower() not in (s.cable or "").lower():
        return False
    if skip != "tq" and f.get("tq") and f["tq"] not in ix.tq_ids:
        return False
    return True


def _sort_key(name: str):
    def key(ix: Idx):
        s, sl = ix.s, ix.slot
        if name == "tag":
            return (s.tag_key.lower(), s.row)
        if name == "io_type":
            return (s.io_type or "~", s.row)
        if name == "cable":
            return (s.cable or "~", s.pair or 0, s.row)
        if name == "state":
            return (STATES.index(ix.state), s.row)
        if name == "cabinet":
            return (sl.cabinet if sl else "~", s.row)
        if name == "cioc":
            return (sl.cioc_seq if sl else 10 ** 9, s.row)
        if name == "slot":
            return (sl.cabinet_seq, sl.cioc_seq, sl.bp, sl.ch) if sl else (10 ** 9, 0, 0, s.row)
        return (s.row,)
    return key


def list_signals(st, comp, *, q: str | None = None, io_type: str | None = None, status: str | None = None,
                 cabinet: str | None = None, cioc: str | None = None, cable: str | None = None, tq: str | None = None,
                 sort: str = "row", order: str = "asc", limit: int = 100, offset: int = 0) -> SignalList:
    if sort not in SORTS:
        raise ValueError(f"sort must be one of {', '.join(SORTS)}")
    if order not in ("asc", "desc"):
        raise ValueError("order must be asc or desc")
    f = {"q": q, "io_type": io_type, "status": status, "cabinet": cabinet, "cioc": cioc, "cable": cable, "tq": tq}
    idx = build_index(comp)
    hit = [ix for ix in idx if _match(ix, f)]
    facet = [ix for ix in idx if _match(ix, f, skip="status")]       # state chips stay informative while a state is selected
    hit.sort(key=_sort_key(sort), reverse=order == "desc")
    cx = Ctx(comp)
    page = hit[offset:offset + limit]
    counts = SignalCounts(
        total=len(idx), matching=len(hit),
        by_state={k: sum(1 for ix in facet if ix.state == k) for k in STATES},
        by_io_type=dict(sorted(Counter(ix.s.io_type or "-" for ix in hit).items())),
        by_cabinet=dict(sorted(Counter(ix.slot.cabinet for ix in hit if ix.slot).items())))
    return SignalList(project_id=st.project.id, revision=st.project.revision, run_id=comp.cert.run_id, limit=limit, offset=offset,
                      counts=counts, rows=[to_row(ix, cx) for ix in page])


def find_signal(comp, tag: str, row: int | None = None) -> Idx:
    """The signal for a tag (whitespace/case-insensitive). A tag on several MDB rows needs `row`."""
    key = tag_key(tag).lower()
    hits = [ix for ix in build_index(comp) if ix.s.tag_key.lower() == key and (row is None or ix.s.row == row)]
    if not hits:
        raise KeyError(f"signal {tag}" + (f" (row {row})" if row else ""))
    if len(hits) > 1:
        placed = [h for h in hits if h.slot is not None]
        if len(placed) == 1:
            return placed[0]
        raise ValueError(f"tag {tag} is on {len(hits)} MDB rows ({', '.join(str(h.s.row) for h in hits)}) — pass `row`")
    return hits[0]


def row_for(comp, tag: str, row: int | None = None) -> SignalRow:
    ix = find_signal(comp, tag, row)
    return to_row(ix, Ctx(comp))
