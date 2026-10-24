# Rule coverage — every rule in the problem statement and the guide → rule id · engine step · verifier check

Sources: `data/IO_Allocation_Fundamentals.docx` (the guide: "Basic allocation rules", "Spare and future-capacity philosophy",
"Quality checks before issuing") and the problem statement as summarised in `CLAUDE.md` §2–§7. Rule ids are those of
`rulesets/default.json`; engine steps are in `backend/engine/` (`preflight.py` = pre-flight, `allocate.py` = the engine);
checks are in `backend/verify/checks.py` (the verifier imports nothing from the engine). **Gaps are listed at the bottom — read them.**

Every rule below is *data*: it can be switched off, re-parameterised or extended in Rules Studio and the engine and the verifier both
follow (`backend/tests/test_no_hardcoded_literals.py` asserts that no part number or remark text lives in code).

## 1. Placement and addressing

| # | Rule (source) | Rule id | Engine step | Verifier check |
|---|---|---|---|---|
| 1 | Every live signal has a slot, or a TQ explains why not (PS; guide "Completeness") | `r-capacity` | pre-flight §0–§4 quarantines bad rows with a TQ; `Engine.fill()` writes one row per slot; unplaceable cables → `drop_unfittable` TQ | **C01** every live MDB tag appears exactly once (a tag with a TQ is reported as excepted, never as a silent pass) |
| 2 | One signal per slot, no duplicated channel/CHARM (guide "Uniqueness") | `r-capacity` | `Engine.commit` + `layout()` give every block distinct channels | **C02** no duplicate CIOC/baseplate/channel |
| 3 | One cable pair = one signal (guide "Keep cable, IO type and hardware consistent") | `r-capacity` | pre-flight §4 "Duplicate cable pair" quarantines the second row | **C03** no duplicate cable + pair |
| 4 | `CHARM_No = (baseplate − 1) × 12 + channel` (guide) | — (built in, geometry from Project Settings) | `Engine.base_slot` (`charm_no`) | **C04** |
| 5 | Baseplate prefix = parent CIOC sequence, e.g. `013-CBP-6` (guide) | `r-names` | `Engine.tokens` / `name("baseplate")` | **C05** |
| 6 | Cable pairs land in order and contiguously; ≥ 12-pair cables take whole baseplates, smaller cables never cross a baseplate (PS; guide "Preserve the field-cable sequence") | `r-cable` | `build_blocks` (footprint), `layout()` (first-fit, boundary rule) | **C06** |
| 7 | A and B never on one CIOC (PS; guide "Respect IO segregation") | `r-ab` | `compatible()` / `commit()` lock a CIOC to one family; pre-flight §4 turns an A+B-on-one-cable clash into a named TQ and places the cable as a **TQ-covered exception**; `optimise.py` (CP-SAT) has A/B as a hard constraint | **C07** (reports "excepted by TQ" for the clash cable) |
| 8 | IS and NON-IS never share a baseplate (drill C; guide "IS status") | `r-is` | `layout()` baseplate-level family mixing test; pre-flight §4b / mixed-cable TQ | **C07.2** |
| 9 | Unrecognised segregation code (`Z`, `A-B`, `B-A` — "project-defined, confirm") is neutral **and** raises one candidate TQ | `r-ab` (`neutral` list) | pre-flight `_unknown_primary_codes` | C07 (neutral is not a violation); the TQ is the safety net |
| 10 | Same IO grouping stays together, in sequence, in consecutive cabinets (PS; guide "Group logically") | `r-group` (soft) | `Block.sort_key` (family → group → size ↓ → cable), `assign_balanced` / `assign_greedy`, CP-SAT objective ("groups kept together and in sequence") | **C08** |
| 11 | Cabinets are separated by controller domain (room + area); overflow opens the next cabinet; capped → capacity TQ (PS) | `r-capacity`, Project Settings (`domain_keys`, `max_cabinets_per_*`) | `_run` partitions by domain, `new_cab`, `plan_domain_cabinets` | **C18** limits, **C10** names |
| 12 | Hierarchy 4 CIOC × 8 baseplates × 12 channels; the whole physical grid is listed, Spare Slots included (PS; guide "Cabinet capacity") | `r-capacity` | `reserve`, `instantiated`, `Engine.fill()` | **C13** full grid present for every cabinet (every instantiated CIOC in compact mode) |

## 2. Hardware

| # | Rule | Rule id | Engine step | Verifier check |
|---|---|---|---|---|
| 13 | CHARM + terminal block follow the IO type and signal (AIR/RTD, AIR, AOR, DIR, DOR) (guide "Selecting the CHARM") | `r-hw` | `hardware.resolve()` (first matching row of the map) | **C09** re-derives the expected hardware from the MDB + rule set and compares every row; descriptions are compared with `catalog.json` |
| 14 | DO load check: solenoid/horn/beacon/sounder → isolated DO + fused TB; unknown instrument type → standard DO **+ TQ** (guide "Critical DO check") | `r-hw` (`lists.high_current_do`, `normal_do`, `review`) | `hardware.resolve()` (`tq`, `review`), pre-flight §5 "Unknown DO type" and "DO hardware conflict" (candidate TQ, with Apply-able fix options worded from the map) | **C09** (the allocated hardware must equal the map's answer) |
| 15 | Terminal-block terminals / loop typical agree with the electrical arrangement (guide "Hardware match") | `r-hw` (`terminals`, `loop_typicals`) | `hardware.resolve()` | **C20** |
| 16 | Spare Slot = protection cover, tag `-`, no terminals (guide "What Spare Slot means for hardware") | `r-hw` (`spare_slot`; catalogue fallback) | `Engine.base_slot`, `hardware.spare_slot_hw` | **C14** status discipline, **C09** |
| 17 | IO type mapped per the map; unmapped type excluded + TQ (PS; drill B `XX`) | `r-io-map` | `normalise`, pre-flight §1 | **C16** |
| 18 | Custom hardware override (`io_type=="DOR" and instrument_type in [...] -> charm=…`) | `r-uzv`-style `custom_expr` | `hardware.resolve()` loop over `custom_expr` rules | **C09** (same evaluation, independent code) |

## 3. Spares, alarms, naming

| # | Rule | Rule id | Engine step | Verifier check |
|---|---|---|---|---|
| 19 | Wired spares: 10 % per IO type **per controller**, rounded up, correct CHARM/TB, traceable tag (guide "Spare and future-capacity") | `r-wired-spare` | `Engine.wired_spares` / `make_spare` (spares come from the cable's own unused pairs; shortfall → TQ) | **C11** (≥ target per IO type per controller, hardware per C09) |
| 20 | Extra wired spares for one IO type, on top of the global % | custom `extra_spares` | `CustomPlan.extra_target` | custom check (C23+) |
| 21 | Future space: 10 % of each cabinet's baseplates (≈ 3–4 of 32) kept free at the END of the cabinet | `r-future` | `Engine.reserve` | **C12** |
| 22 | Cabinet alarms (internal wiring / equipment is a cabinet) on baseplate 1 of CIOC 1 of each marshalling cabinet, exclusively | `r-alarm-bp` | `place_alarms`, `pack_alarms`, `alarm_remark` (remark text comes from the rule) | **C15** |
| 23 | Names follow the project patterns (system cabinet, controller, marshalling cabinet, CIOC, baseplate, wired-spare tag, visualization). A cable lands together, so its rows share ONE location: a row with a blank/unmapped room or area inherits the cable's (`app/cabledomain.py`, one function used by pre-flight and by C10) | `r-names` | `Engine.tokens`, `name()`, pre-flight §4 (`cable_homes`) | **C10** (expects the cable-resolved location, not the row's raw area) |
| 24 | Engineering columns are copied from the MDB (tag, service, signal type, …) | `r-out` | `xio/render.py` | **C17** |
| 25 | Tag Status discipline: Field / Wired Spare / Spare Slot / Cabinet Alarm are not interchanged (guide "Common mistakes") | — | `Engine.put_signal`, `fill` | **C14** |
| 26 | The CIOC count in the rows, the Capacity BOM and the KPIs agree | — | `compute_kpis`, `capacity_bom` | **C19** |

## 4. Input quality and revisions

| # | Rule | Rule id | Engine step | Verifier check |
|---|---|---|---|---|
| 27 | Bad input never crashes: missing cable/pair, duplicate tag, unreadable pair (`1:0`), pair > cable size, no tag, `DELETED` | — | `normalise` (note rows ignored), pre-flight §0–§4 quarantine + TQ with data-patch fix options | **C01** (a quarantined tag is "excepted by TQ") |
| 28 | Missing room/area/status columns use project defaults and raise ONE project-level TQ | Project Settings | `normalise` | — (TQ only) |
| 29 | Rev B keeps unchanged signals in the same slot; freezing never blocks a new hard rule | all hard rules | `revise.baseline_from`, `Engine.pin_blocks` (a pin that now violates a hard rule is dropped with a reason); chains A → B → C pin each revision against the previous one (`app/revisions.py`) | every rule check runs on the revised output; **C01** |
| 30 | A TQ fix (rule patch or data patch) re-allocates revision-style: nothing else moves | — | `app/sandbox.repin` + `Service.apply_tq_pins` (pins stored per revision, replayed silently) | same checks, run on the result |
| 31 | User-defined rules: `max_per_scope`, `scope_relation`, `forbid_mix`, `zone_cabinets`, `extra_spares`, `custom_expr` | custom rules (`app/customrules.py`) | `engine/custom.py` (`CustomPlan`: placement hooks + final check) | **C23, C24, …** one dynamic check per rule (`verify/custom.py`) |
| 32 | Tampered output is caught: any edited CHARM / pair / address fails with the exact row and check | — | — | **all checks**, run on the re-read Excel (`verify/xlsx.py`, `POST /verify-file`) |

## 5. Rule types (CLAUDE.md §5) — placement hook and verifier check

| Rule type | Placement hook | Verifier check |
|---|---|---|
| `capacity` | `reserve`, `layout`, `new_cab` | C01–C04, C13, C18, C19 |
| `cable_contiguous` | `build_blocks`, `layout` | C06 |
| `group_together` | `sort_key`, `assign_*`, CP-SAT | C08 |
| `segregate` | `compatible`, `commit`, `layout` (baseplate level) | C07, C07.2 … |
| `reserve_baseplate` | `place_alarms`, `pack_alarms`, `reserve` | C15 |
| `wired_spare_pct` | `wired_spares` | C11 |
| `future_spare_pct` | `reserve` | C12 |
| `hardware_map` | `hardware.resolve` | C09, C20 |
| `io_type_map` | `normalise`, pre-flight §1 | C16 |
| `naming_pattern` | `tokens`, `name` | C05, C10 |
| `output_map` | `xio/render.py` | C17 |
| `custom_expr` | `hardware.resolve` | C09 |

## 6. Gaps (what is **not** independently verified)

* **Change traceability** (guide "Change traceability": revision number, remarks, old tag, change type). The engine writes `Revision No`,
  `Change Type`, `Remarks`, `Old Tag` (`revise.annotate`) but no verifier check re-reads those four columns; a hand-edited `Change Type`
  would pass. Rev B stability and move reasons are checked by tests (`test_revisions.py`, `test_revision_chains_and_tq_apply.py`), not by the verifier.
* **Software alignment** (controller ↔ CIOC ↔ cabinet). The controller and system-cabinet *names* are checked by C10 against the
  patterns, and C18 checks the counts, but DeltaV's own assignment cannot be seen from the workbook.
* **Load / inrush of DO loads** is a TQ (candidate), not a computed check: the tool has no load data.
* **A-B / B-A and any other project-defined segregation code**: neutral + one candidate TQ; the tool cannot know their meaning (the guide says to confirm).
* **IRC / MCC signals** are out of scope (guide "Scope boundary"); rows on `Internal Wiring` are handled only as cabinet alarms (§22).
* **IS rule**: a cable that mixes IS and NON-IS is placed with its majority family and covered by a TQ (shown as "excepted by TQ").
* **CP-SAT vs greedy**: the optimiser's result is adopted only when the verifier passes it and it scores better; coverage is therefore
  identical for both strategies — the rules above are enforced in the layout (`layout`, `compatible`), not in the optimiser alone.
