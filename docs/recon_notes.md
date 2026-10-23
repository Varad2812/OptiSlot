# Recon notes — what the sample data actually says

Learned in P0 by diffing the MDB against the reference allocation. These feed the engine and the
rule set; none of them are hard-coded in engine code.

## Cabinets
- The reference has 3 marshalling cabinets: `P30-DCM-32001-01`, `P30-DCM-32001-04`, `P24-DCM-50002-01`.
- **Cabinets are declared by the cabinet-alarm rows.** Their `Equipment Name` is the cabinet
  (`P30-DCM-32001-04` ⇒ cabinet seq 04). Any cabinet declared this way must be instantiated with that seq.
- CIOC seq = (cabinet seq − 1) × 4 + local ⇒ DCM-04 holds CIOCs 013–016. Baseplate prefix = CIOC seq.
- Controller / system cabinet seq = ordinal of the cabinet inside its domain (max 1 cabinet per
  controller): DCM-01 → DPK…01 / DCS-…-01, DCM-04 → DPK…02 / DCS-…-02.
- Cabinet alarms whose equipment is a **system** cabinet (`P30-DCS-32001-01`, real cables
  `P30-ICE-0001` triad + `P30-ICE-0002` 2-pair) go to BP1 of CIOC1 of that controller's first DCM, after the DCM's own alarms (ch 4–6).

## Slot rules seen in the reference
- Pair p of a cable block lands on channel `offset + p` (24-pair: pairs 1–12 on BP n, 13–24 on BP n+1).
- 6-pair cables pack 2 per baseplate (ch 1–6 and 7–12). A 12-pair cable starts at ch 1 even if pair 1 is unused.
- Unused pairs of a placed cable that are not wired spares are **Spare Slot but keep Field Cable No/Size/Pair**.
- Spare Slot rows keep Technical Room / Operating Area / Risk Area / Unit of the cabinet's domain; Location `-`; DSTName `_`.
- The reference is hand-made and sparse (alternating A/B CIOCs, gaps). Address agreement is informative only.

## Column derivations (Field rows)
| Output | Source |
|---|---|
| Operating Area | `OA No.` |
| Unit | `WBS` |
| Service Description | `Tag Service 1 and 2` |
| NON-IS / IS | `Execution` |
| External Power | `External Power Supply` |
| Instrument type | `Instrument Type Description` |
| Segregation | `IO Grouping` |
| Old Tag | `Old Tag Number` |
| Section / Sub Unit | not derivable (left `-` unless a column is mapped) |
| CHARM TB1/2/3 | by signal level: 2-wire/contacts → `1,2,-`; 3-wire → `1,2,4`; 4-wire and SE4502 → `-,2,4` |
| HW Loop Typical | AIR LT-01 (4-wire LT-02B), AOR LT-04, DIR LT-05, DOR std LT-07, DOR iso LT-08A; cabinet alarms SA-AMI-… |

Wired spares inherit room/area/location/signal type/level/loop typical from the cable's members of that IO type;
service = `SPARE AI|AO|DI|DO`; tag = `{area4}DSP{ctrl2}{cioc3}{bp}{ch}`.

## Traps
- `440-PI-20077-L` (New, AO, `500-CE-LP-0003-A` pair 14) is in the MDB; the reference has `440-PI-20076-L` on that pair instead.
- `320-FT-80002` is DELETED (pair 3 of `320-CE-0001`) — reference shows that pair as Spare Slot "Tag Deleted".
- The 12 cabinet-alarm rows have an empty `Revision Change Type`; all others say `PDR-1`.
- No cable mixes A and B families in the sample (the hidden test may).
- All 41 DO rows have known instrument types (XYV/ZYV → isolated; XA/ZLO/MHL/MXA/MXL/QAX → standard).
