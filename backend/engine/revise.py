"""Revisions: Rev B keeps every unchanged signal in its slot and moves only what must move — each with a reason.

    baseline_from(previous run)     → what must be preserved (cabinets, cable positions, alarms, wired spares)
    revise(new MDB, baseline)       → the engine runs with those positions pinned (hard rules can still unpin)
    annotate(...)                   → Change Type / Remarks / Revision No / Old Tag on every changed slot + impact
"""
from __future__ import annotations

from app.schemas import MoveItem, ProjectSettings, RevisionImpact, RuleSet, Signal, WhyStep
from engine.allocate import Allocation, Baseline, Engine
from engine.kpis import compute_kpis
from engine.pipeline import RunOutput, run
from engine.tqs import TQBook
from xio.render import render_rows

HW_FIELDS = ("charm", "tb")
SIG_FIELDS = (("io_type", "IO type"), ("signal_type", "signal type"), ("signal_level", "signal level"),
              ("instrument_type", "instrument type"), ("group", "IO grouping"))


def baseline_from(out: RunOutput) -> Baseline:
    alloc = out.alloc
    blocks = {b.cable: (b.cab.ns, b.cab.seq, b.cioc, b.bp, b.ch, b.size) for b in alloc.blocks
              if b.cab is not None and b.bp is not None and b.ch is not None and b.cioc is not None}
    cab_of = {(c.seq, c.domain): c for c in alloc.cabs}
    alarms = {}
    for s in alloc.slots:
        c = cab_of.get((s.cabinet_seq, s.domain))
        if s.status == "Cabinet Alarm" and c is not None:
            alarms[s.tag_key] = (c.ns, c.seq, s.cioc_local, s.bp, s.ch)
    spares = {(s.cable, s.pair): s.io_type for s in alloc.slots if s.status == "Wired Spare" and s.pair}
    live = {s.tag_key: s for s in alloc.slots if s.status in ("Field", "Cabinet Alarm")}
    return Baseline(cabs=[(c.ns, c.seq, c.domain, c.declared) for c in sorted(alloc.cabs, key=lambda c: (c.dorder, c.seq))],
                    blocks=blocks, alarms=alarms, spares=spares, slots=live, by_id={s.id: s for s in alloc.slots},
                    live=len(live))


def revise(src: bytes, prev: RunOutput, ruleset: RuleSet | None = None, settings: ProjectSettings | None = None,
           filename: str | None = None, from_rev: str = "A", to_rev: str = "B", rev_no: str = "01",
           overrides=None, table=None) -> tuple[RunOutput, RevisionImpact]:
    base = baseline_from(prev)
    settings = (settings or prev.settings).model_copy(update={"cpsat_enabled": False})
    prev_sig = {s.tag_key: s for s in prev.signals if s.live and not s.quarantined}

    def move_tqs(signals: list[Signal], book: TQBook) -> None:
        for s in signals:
            if not s.live or s.quarantined:
                continue
            old = prev_sig.get(s.tag_key)
            if old and (old.cable, old.pair) != (s.cable, s.pair) and s.kind == "field" and old.kind == "field":
                book.add("revision", "Cable/pair changed", "medium",
                         f"{s.tag} moved from {old.cable} pair {old.pair} to {s.cable} pair {s.pair} in Rev {to_rev} — "
                         f"it follows its new cable. Confirm the field wiring change.", rows=[s.row], tags=[s.tag],
                         field="Pair", unchanged="Every other signal keeps its slot.")

    out = run(src, ruleset or prev.rules.rs, settings, overrides, filename, table=table, baseline=base,
              assign=Engine.assign_greedy, extra_tqs=[move_tqs])
    impact = annotate(out, prev, base, from_rev, to_rev, rev_no)
    out.rows = render_rows(out.alloc.slots, out.signals, out.rules)
    out.kpis = compute_kpis(out.signals, out.alloc.slots, out.alloc.cabinets, out.tqs, out.rules,
                            stability_pct=impact.stability_pct)
    return out, impact


def annotate(out: RunOutput, prev: RunOutput, base: Baseline, from_rev: str, to_rev: str, rev_no: str) -> RevisionImpact:
    alloc: Allocation = out.alloc
    new_sig = {s.tag_key: s for s in out.signals if s.live and not s.quarantined}
    by_row = {s.row: s for s in out.signals}
    prev_sig = {s.tag_key: s for s in prev.signals if s.live and not s.quarantined}
    blocks = {b.cable: b for b in alloc.blocks}
    added, deleted, modified, moved = [], [], [], []
    unchanged = 0
    touched: set[str] = set()
    now_live = {s.tag_key: s for s in alloc.slots if s.status in ("Field", "Cabinet Alarm")}

    for slot in alloc.slots:
        if slot.status not in ("Field", "Cabinet Alarm"):
            continue
        k = slot.tag_key
        sig = by_row.get(slot.source_row) if slot.source_row else None
        old_tag_key = (sig.extra.get("old_tag", "-").replace(" ", "") if sig else "-")
        a = base.slots.get(k)
        renamed_from = None
        if a is None and old_tag_key not in ("", "-") and old_tag_key in base.slots and old_tag_key not in now_live:
            a = base.slots[old_tag_key]
            renamed_from = a.tag
        if a is None:
            b = blocks.get(slot.cable)
            if slot.cable in base.blocks:
                was_spare = (slot.cable, slot.pair) in base.spares
                reason = (f"New tag on existing cable {slot.cable} pair {slot.pair} → its own pair position"
                          + (" (used the cable's wired spare)" if was_spare else ""))
            elif slot.status == "Cabinet Alarm":
                reason = "New cabinet alarm → first free channel on the reserved baseplate"
            else:
                span = f"{b.span} whole baseplate(s)" if b and b.span else f"{b.foot if b else 1} channel(s)"
                reason = f"New cable {slot.cable} → first free {span} on CIOC {slot.cioc_seq:03d} (normal engine)"
            slot.change_type, slot.revision, slot.remarks = "Added", rev_no, reason
            slot.why.append(_why(reason))
            added.append(MoveItem(tag=slot.tag, to_slot=slot.id, reason=reason))
            touched.add(slot.cabinet)
            continue
        old = prev_sig.get(a.tag_key)
        changes = []
        if renamed_from:
            changes.append(f"renamed from {renamed_from}")
            slot.old_tag = renamed_from
        if sig and old:
            for f, label in SIG_FIELDS:
                if str(getattr(sig, f, "")) != str(getattr(old, f, "")):
                    changes.append(f"{label} {getattr(old, f, '')} → {getattr(sig, f, '')}")
        hw = [(a.charm, slot.charm), (a.tb, slot.tb)]
        hw_changed = any(x != y for x, y in hw)
        if slot.id != a.id:
            b = blocks.get(slot.cable)
            if old and sig and (old.cable, old.pair) != (sig.cable, sig.pair):
                reason = f"cable/pair changed ({old.cable} pair {old.pair} → {sig.cable} pair {sig.pair}) — follows its cable"
            elif b and b.move_reason:
                reason = f"freezing overridden by a hard rule: {b.move_reason}"
            else:
                reason = "its cable could not stay in place"
            reason = f"Moved {a.id} → {slot.id}: {reason}"
            slot.change_type, slot.revision, slot.remarks = "Moved", rev_no, reason
            slot.why.append(_why(reason))
            moved.append(MoveItem(tag=slot.tag, from_slot=a.id, to_slot=slot.id, reason=reason))
            touched.update({slot.cabinet, a.cabinet})
        elif hw_changed or changes:
            if hw_changed:
                changes.append(f"hardware {a.charm}/{a.tb} → {slot.charm}/{slot.tb} in the same slot")
            reason = "Modified: " + "; ".join(changes)
            slot.change_type, slot.revision, slot.remarks = "Modified", rev_no, reason
            slot.why.append(_why(reason))
            modified.append(MoveItem(tag=slot.tag, from_slot=a.id, to_slot=slot.id, reason=reason))
            touched.add(slot.cabinet)
        else:
            slot.revision = a.revision
            slot.pinned = True
            slot.why.append(_why(f"Unchanged since Rev {from_rev} — frozen in its slot"))
            unchanged += 1

    renamed = {s.old_tag.replace(" ", "") for s in alloc.slots if s.change_type == "Modified" and s.old_tag not in ("", "-")}
    by_id = {s.id: s for s in alloc.slots}
    for k, a in base.slots.items():
        if k in now_live or k in renamed:
            continue
        s = new_sig.get(k)
        why = "quarantined in this revision (see its TQ)" if any(x.tag_key == k and x.quarantined for x in out.signals) \
            else "deleted in the MDB" if s is None else "no longer allocated"
        slot = by_id.get(a.id)
        reason = f"Deleted: {a.tag} {why} — slot freed"
        if slot is not None and slot.status in ("Spare Slot", "Wired Spare"):
            slot.change_type, slot.revision, slot.old_tag = "Deleted", rev_no, a.tag
            slot.remarks = reason + (" → kept as a wired spare (target needs it)" if slot.status == "Wired Spare" else " → Spare Slot")
            slot.why.append(_why(slot.remarks))
        deleted.append(MoveItem(tag=a.tag, from_slot=a.id, reason=reason))
        touched.add(a.cabinet)

    prev_tqs = {(t.category, tuple(sorted(t.tags))) for t in prev.tqs}
    new_tqs = [t.id for t in out.tqs if (t.category, tuple(sorted(t.tags))) not in prev_tqs]
    stability = round(100.0 * unchanged / base.live, 1) if base.live else 100.0
    return RevisionImpact(from_rev=from_rev, to_rev=to_rev, added=added, deleted=deleted, modified=modified, moved=moved,
                          unchanged_in_place=unchanged, previous_live=base.live, stability_pct=stability,
                          cabinets_touched=sorted(touched), new_tqs=new_tqs)


def _why(text: str) -> WhyStep:
    return WhyStep(rule_id=None, text=text)
