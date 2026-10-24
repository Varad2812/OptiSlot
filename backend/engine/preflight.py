"""Pre-flight: find every data problem BEFORE allocation and turn it into a TQ.

Bad rows are quarantined (kept, reported, linked to their TQ) — never silently dropped, never a crash.
Returns the set of cables that are allocated as TQ-covered exceptions (A+B family on one cable).
"""
from __future__ import annotations

from collections import Counter, defaultdict

from app.schemas import ProjectSettings, Signal
from engine.hardware import default_hw, listed_hw, resolve, signal_ctx
from engine.normalise import blank
from engine.rules import Rules, seg_field, seg_value
from engine.tqs import TQBook

STANDARD_SIZES = (1, 2, 6, 12, 24, 36, 48)


def _rows(sigs: list[Signal]) -> list[int]:
    return [s.row for s in sigs]


def _span(rows: list[int]) -> str:
    rows = sorted(rows)
    if not rows:
        return ""
    return f"row {rows[0]}" if len(rows) == 1 else f"rows {rows[0]}–{rows[-1]}"


def preflight(signals: list[Signal], rules: Rules, settings: ProjectSettings, book: TQBook) -> dict[str, str]:
    """Mutates signals (quarantine flags, inferred sizes, forced domains). Returns {cable: tq_id} exceptions."""
    io_rule = rules.rid("io_type_map") or "r-io-map"

    # 0 ── duplicate tags: the FIRST row in MDB order is the signal, later ones are quarantined
    live = [s for s in signals if s.live and not s.quarantined]
    first: dict[str, Signal] = {}
    for s in live:
        if s.tag_key in first:
            f = first[s.tag_key]
            fs, ss = f.extra.get("source", ""), s.extra.get("source", "")
            across = bool(fs and ss and fs.rsplit(":", 1)[0] != ss.rsplit(":", 1)[0])
            where = f" ({fs} and {ss})" if fs and ss else ""
            t = book.add("data", "Duplicate tag across files" if across else "Duplicate tag", "high",
                         f"Tag {s.tag} appears twice (rows {f.row} and {s.row}){where}. Row {f.row} is kept as the signal, row {s.row} is quarantined.",
                         rows=[f.row, s.row], tags=[s.tag], field="Tag",
                         fixes=[{"label": f"Delete row {s.row}"}, {"label": f"Rename the tag on row {s.row}"}])
            book.quarantine_signal(s, f"duplicate of row {f.row}", t)
        else:
            first[s.tag_key] = s

    # 1 ── IO type not in the map → excluded + TQ (one per raw type)
    live = [s for s in signals if s.live and not s.quarantined]
    by_raw: dict[str, list[Signal]] = defaultdict(list)
    for s in live:
        if not s.io_type:
            by_raw[s.io_type_raw or "(blank)"].append(s)
    for raw, sigs in by_raw.items():
        fixes = [{"label": f"Map '{raw}' → {t}", "rule_patch": {"rule_id": io_rule, "op": "map_set", "path": "map",
                                                                 "key": raw.upper(), "value": t}}
                 for t in rules.io_types()]
        t = book.add("io", "Unknown IO type", "high",
                     f"IO type '{raw}' is not in the IO type map — {len(sigs)} signal(s) excluded ({_span(_rows(sigs))}). "
                     f"Fix: map it to an IO type; everything else unchanged.",
                     rows=_rows(sigs), tags=[s.tag for s in sigs], field="IO type", rules=[io_rule], fixes=fixes)
        for s in sigs:
            book.quarantine_signal(s, f"unknown IO type '{raw}'", t)

    # 3 ── field signals need a cable and a pair
    for s in [s for s in signals if s.live and not s.quarantined and s.kind == "field"]:
        if not s.cable:
            t = book.add("data", "Missing cable", "high", f"{s.tag} (row {s.row}) has no cable number — quarantined. "
                         "Fix: add the cable in the MDB; everything else unchanged.", rows=[s.row], tags=[s.tag], field="Cable no.",
                         rules=[rules.rid("cable_contiguous") or "r-cable"], fixes=[{"label": "Add the cable number in the MDB"}])
            book.quarantine_signal(s, "missing cable", t)
        elif s.pair is None:
            if s.cable_size == 1 and blank(s.pair_label):
                s.pair = 1
                continue
            unreadable = not blank(s.pair_label)
            t = book.add("data", "Unreadable pair" if unreadable else "Missing pair", "high",
                         (f"{s.tag} (row {s.row}) on cable {s.cable} has pair '{s.pair_label}', which is not a clean pair number "
                          "(expected e.g. 'Pair 10' or '10') — quarantined. Fix: correct the pair in the MDB; everything else unchanged.")
                         if unreadable else
                         (f"{s.tag} (row {s.row}) on cable {s.cable} has no pair number — quarantined. "
                          "Fix: add the pair in the MDB; everything else unchanged."), rows=[s.row], tags=[s.tag], field="Pair",
                         rules=[rules.rid("cable_contiguous") or "r-cable"],
                         fixes=[{"label": "Correct the pair number in the MDB" if unreadable else "Add the pair number in the MDB"}])
            book.quarantine_signal(s, "unreadable pair" if unreadable else "missing pair", t)

    # 4 ── cable-level consistency (cabinet alarms on real cables are checked too)
    exceptions: dict[str, str] = {}
    cables: dict[str, list[Signal]] = defaultdict(list)
    for s in signals:
        if s.live and not s.quarantined and (s.kind == "field" or (s.cable and s.cable_size and s.pair)):
            cables[s.cable].append(s)
    for cable, sigs in list(cables.items()):
        kinds = {s.kind for s in sigs}
        alarm_sigs = [s for s in sigs if s.kind == "cabinet_alarm"]
        whole = int(rules.params("cable_contiguous").get("whole_baseplate_min_pairs", settings.channels_per_baseplate)) \
            if rules.first("cable_contiguous") else 10 ** 6
        too_big = any((s.cable_size or 0) >= whole or (s.cable_size or 0) > settings.channels_per_baseplate // 2
                      for s in alarm_sigs)
        if alarm_sigs and (len(kinds) > 1 or too_big):
            book.add("data", "Cabinet alarm on field cable", "low",
                     f"Cabinet alarm row(s) on cable {cable} "
                     + ("share it with field signals" if len(kinds) > 1 else "need whole baseplates")
                     + " — allocated with the cable as field signals.", rows=_rows(alarm_sigs), tags=[s.tag for s in alarm_sigs],
                     rules=[rules.rid("reserve_baseplate") or "r-alarm-bp"], confidence="candidate")
            for s in alarm_sigs:
                s.kind = "field"
        if not all(s.kind == "field" for s in sigs):
            # pure cabinet-alarm cable: only pair sanity matters
            for s in sigs:
                if s.pair and s.cable_size and s.pair > s.cable_size:
                    t = book.add("data", "Pair exceeds cable size", "high",
                                 f"Cabinet alarm {s.tag} uses pair {s.pair} of {s.cable_size}-pair cable {cable} — quarantined.",
                                 rows=[s.row], tags=[s.tag], field="Pair", rules=[rules.rid("capacity") or "r-capacity"])
                    book.quarantine_signal(s, f"pair {s.pair} > cable size {s.cable_size}", t)
            seen_a: dict[int, Signal] = {}
            for s in sorted(sigs, key=lambda x: x.row):
                if s.quarantined:
                    continue
                if s.pair in seen_a:
                    t = book.add("data", "Duplicate cable pair", "high",
                                 f"{cable} pair {s.pair} is used by {seen_a[s.pair].tag} and {s.tag} — row {s.row} quarantined.",
                                 rows=[seen_a[s.pair].row, s.row], tags=[s.tag], field="Pair")
                    book.quarantine_signal(s, f"duplicate of {cable} pair {s.pair}", t)
                else:
                    seen_a[s.pair] = s  # type: ignore[index]
            continue
        sizes = {s.cable_size for s in sigs if s.cable_size}
        size = max(sizes) if sizes else None
        if len(sizes) > 1:
            # one cable, one spec: every row carries the spec text of the size used, so the written Field Cable Size
            # always agrees with the block the engine lays out
            spec = next(s.cable_spec for s in sorted(sigs, key=lambda x: x.row) if s.cable_size == size)
            book.add("cable", "Cable spec mismatch", "medium",
                     f"Cable {cable} has different sizes across its rows ({sorted(sizes)}) — using {size} pairs ({spec}) for every row.",
                     rows=_rows(sigs), field="Cable spec / size", confidence="candidate")
            for s in sigs:
                s.cable_spec = spec
        max_pair = max(s.pair or 0 for s in sigs)
        if size is None:
            size = next((n for n in STANDARD_SIZES if n >= max_pair), ((max_pair + 11) // 12) * 12)
            book.add("cable", "Cable size inferred", "low",
                     f"Cable {cable} has no readable size — inferred {size} pairs from its highest pair ({max_pair}). Confirm the cable spec.",
                     rows=_rows(sigs), field="Cable spec / size", confidence="candidate",
                     fixes=[{"label": f"Accept {size}-pair"}, {"label": "Fix the cable spec in the MDB"}])
        for s in sigs:
            s.cable_size = size

        over = [s for s in sigs if s.pair and s.pair > size]
        if over:
            t = book.add("data", "Pair exceeds cable size", "high",
                         f"Cable {cable} is {size}-pair but {', '.join(f'{s.tag} uses pair {s.pair}' for s in over)} — quarantined. "
                         "Fix: correct the pair or the cable spec; everything else unchanged.",
                         rows=_rows(over), tags=[s.tag for s in over], field="Pair", rules=[rules.rid("capacity") or "r-capacity"])
            for s in over:
                book.quarantine_signal(s, f"pair {s.pair} > cable size {size}", t)

        seen: dict[int, Signal] = {}
        for s in sorted(sigs, key=lambda x: x.row):
            if s.quarantined:
                continue
            if s.pair in seen:
                f = seen[s.pair]
                t = book.add("data", "Duplicate cable pair", "high",
                             f"{cable} pair {s.pair} is used by {f.tag} (row {f.row}) and {s.tag} (row {s.row}). "
                             f"Row {f.row} is kept as the signal, row {s.row} is quarantined.", rows=[f.row, s.row], tags=[f.tag, s.tag],
                             field="Pair", rules=[rules.rid("capacity") or "r-capacity"],
                             fixes=[{"label": f"Give {s.tag} a free pair"}, {"label": f"Delete row {s.row}"}])
                book.quarantine_signal(s, f"duplicate of {cable} pair {s.pair}", t)
            else:
                seen[s.pair] = s  # type: ignore[index]

        ok = [s for s in sigs if not s.quarantined]
        domains = Counter(s.domain for s in ok)
        if len(domains) > 1:
            main = ok[0].domain
            book.add("cable", "Cable spans domains", "medium",
                     f"Cable {cable} has rows in {len(domains)} controller domains ({', '.join(domains)}) — kept together in {main}.",
                     rows=_rows(ok), field="Technical room", confidence="candidate")
            for s in ok:
                s.domain = main

        fams = {s.family for s in ok} - {"-"}
        if {"A", "B"} <= fams:
            seg = rules.ab_rid or "r-ab"
            a_rows = [s.row for s in ok if s.family == "A"]
            b_rows = [s.row for s in ok if s.family == "B"]
            t = book.add("segregation", "A/B on one cable", "critical",
                         f"Cable {cable} carries A-family ({_span(a_rows)}) and B-family ({_span(b_rows)}) signals — rule {seg} "
                         f"(A/B never on one CIOC) vs rule {rules.rid('cable_contiguous') or 'r-cable'} (a cable lands together) is unsatisfiable. "
                         f"Placed on an A CIOC as a TQ-covered exception. Fix: re-tag the B signals or split the cable.",
                         rows=_rows(ok), tags=[s.tag for s in ok if s.family == "B"], field="IO grouping / segregation",
                         rules=[seg, rules.rid("cable_contiguous") or "r-cable"],
                         fixes=[{"label": "Re-tag the B signals to their own cable"}, {"label": "Split the cable"},
                                {"label": "Accept the exception"}],
                         unchanged="Everything else unchanged.")
            exceptions[cable] = t.id

    # 4b ── secondary segregation (e.g. IS / NON-IS): a blank or unrecognised value takes the rule's default family.
    # ONE project-level TQ per rule and kind — never one per row (and no rows[]/tags[]: this TQ must not excuse a
    # missing tag in the verifier).
    for rule in rules.all("segregate"):
        if rule is rules.primary_seg:
            _unknown_primary_codes(rule, signals, book)
            continue
        if not rule.params.get("default_family"):
            continue
        f, dflt = seg_field(rule), rule.params["default_family"]
        label = rule.params.get("field_label") or f
        known = {m.strip().upper() for ms in rule.params.get("families", {}).values() for m in ms}
        live_ = [s for s in signals if s.live and not s.quarantined]
        empty = [s for s in live_ if seg_value(s, f).upper() in ("", "-")]
        odd = [s for s in live_ if seg_value(s, f).upper() not in known | {"", "-"}]
        if empty:
            book.add("project", f"{label} missing", "medium",
                     f"{label} is blank for {len(empty)} signal(s) ({_span(_rows(empty))}) — treated as {dflt} under rule "
                     f"{rule.id} ({rule.label}). Confirm, or fill the column in the MDB.",
                     field=label, rules=[rule.id], confidence="candidate", key=f"segdefault:{rule.id}",
                     fixes=[{"label": f"Fill {label} in the MDB and re-import"}, {"label": f"Accept {dflt}"}],
                     unchanged=f"Allocation proceeds; these signals are segregated as {dflt}.")
        if odd:
            vals = sorted({seg_value(s, f) for s in odd})
            book.add("project", f"Unrecognised {label}", "medium",
                     f"{label} value(s) {', '.join(repr(v) for v in vals[:6])} on {len(odd)} signal(s) ({_span(_rows(odd))}) "
                     f"match no family of rule {rule.id} — treated as {dflt}. Add them to the rule's families or fix the MDB.",
                     field=label, rules=[rule.id], confidence="candidate", key=f"segunknown:{rule.id}",
                     fixes=[{"label": f"Add {v!r} to a family of rule {rule.id}"} for v in vals[:3]] + [{"label": f"Accept {dflt}"}],
                     unchanged=f"Allocation proceeds; these signals are segregated as {dflt}.")

    # 5 ── hardware: unknown DO types (allocated + TQ), unresolvable hardware (quarantined), PS conflicts
    hw_rule = rules.rid("hardware_map") or "r-hw"
    unknown: dict[str, list[Signal]] = defaultdict(list)
    review: list[Signal] = []
    review_msg = ""
    for s in [s for s in signals if s.live and not s.quarantined]:
        hw = resolve(signal_ctx(s), rules)
        if not hw.charm:
            t = book.add("hardware", "No hardware rule", "high",
                         f"No hardware-map row matches {s.tag} (IO {s.io_type}) — quarantined. Fix: add a hardware-map row.",
                         rows=[s.row], tags=[s.tag], field="IO type", rules=[hw_rule], key=f"nohw:{s.io_type}")
            book.quarantine_signal(s, "no hardware rule matches", t)
            continue
        if hw.tq:
            unknown[s.instrument_type].append(s)
        if hw.review:
            review.append(s)
            review_msg = hw.review
    std = default_hw(rules)
    std_txt = f"standard DO {std[0]} + {std[1]}" if std else "the hardware map's default DO"
    hi = listed_hw(rules, "high_current_do")
    hi_txt = f"isolated DO {hi[0]} + fused TB {hi[1]}" if hi else "the high-current DO hardware"
    hi_short = f"{hi[0]} + {hi[1]}" if hi else "high-current hardware"
    for inst, sigs in unknown.items():
        book.add("hardware", "Unknown DO type", "medium",
                 f"DO instrument type '{inst}' is not in the hardware map ({len(sigs)} signal(s), {_span(_rows(sigs))}). "
                 f"Allocated with {std_txt} — confirm the load/inrush.",
                 rows=_rows(sigs), tags=[s.tag for s in sigs], field="Instrument type", rules=[hw_rule],
                 fixes=[{"label": f"Treat {inst} as high-current: {hi_txt}",
                         "rule_patch": {"rule_id": hw_rule, "op": "list_add", "path": "lists.high_current_do", "value": inst}},
                        {"label": f"Confirm {inst} as standard DO",
                         "rule_patch": {"rule_id": hw_rule, "op": "list_add", "path": "lists.normal_do", "value": inst}}],
                 unchanged="Only the CHARM/TB of these rows can change; no slot moves.")
    if review:
        insts = sorted({s.instrument_type for s in review})
        book.add("hardware", "DO hardware conflict", "medium", f"{review_msg} Instrument type(s) {', '.join(insts)}, "
                 f"{len(review)} signal(s).", rows=_rows(review), tags=[s.tag for s in review], field="Instrument type",
                 rules=[hw_rule], confidence="candidate",
                 fixes=[{"label": f"Treat {i} as high-current ({hi_short})",
                         "rule_patch": {"rule_id": hw_rule, "op": "list_add", "path": "lists.high_current_do", "value": i}}
                        for i in insts] + [{"label": "Keep standard DO (as in the sample)",
                                            "rule_patch": {"rule_id": hw_rule, "op": "list_remove", "path": "lists.review_do",
                                                           "value": insts[0]}}],
                 unchanged="Only the CHARM/TB of these rows can change; no slot moves.")
    return exceptions


def _unknown_primary_codes(rule, signals: list[Signal], book: TQBook) -> None:
    """The primary A/B rule lists the group codes it knows as neutral (`neutral`); any other code is treated as neutral
    and raises ONE candidate TQ (project level: no rows[]/tags[], so it never excuses a missing tag in the verifier)."""
    if "neutral" not in rule.params:
        return
    f = seg_field(rule)
    known = {m.strip().upper() for ms in rule.params.get("families", {}).values() for m in ms}
    known |= {m.strip().upper() for m in rule.params["neutral"]} | {"", "-"}
    odd = [s for s in signals if s.live and not s.quarantined and seg_value(s, f).upper() not in known]
    if not odd:
        return
    vals = sorted({seg_value(s, f) for s in odd})
    book.add("project", "Unrecognised segregation code", "medium",
             f"IO grouping code(s) {', '.join(repr(v) for v in vals[:6])} on {len(odd)} signal(s) ({_span(_rows(odd))}) are in "
             f"no family of rule {rule.id} ({rule.label}) — treated as neutral (they may share any CIOC). Confirm which family "
             f"they belong to.", field="IO grouping / segregation", rules=[rule.id], confidence="candidate",
             key=f"segunknown:{rule.id}",
             fixes=[{"label": f"Add {v!r} to a family of rule {rule.id}"} for v in vals[:3]]
             + [{"label": f"Confirm {v!r} as neutral",
                 "rule_patch": {"rule_id": rule.id, "op": "list_add", "path": "neutral", "value": v}} for v in vals[:3]],
             unchanged="Allocation proceeds; these signals are neutral.")
