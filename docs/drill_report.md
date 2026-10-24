# Drill report — surprise-dataset files

Generated headlessly by `backend/xio/drills.py` (`cd backend && uv run python -m xio.drills --md ../docs/drill_report.md` regenerates
the tables below; `backend/tests/test_drills.py` fails if any drill regresses). Each file goes through the real `Service`:
import → auto-map → normalise → pre-flight → allocate (CP-SAT with greedy fallback) → export → the **independent verifier on the exported
workbook**. drill_F is loaded as Rev B of the sample; E1 + E2 go in as one multi-file import.

**PASS** = no crash · every live tag allocated, or covered by a TQ / quarantined · verifier 0 violations (or excepted by TQ) ·
the allocation export re-opens in openpyxl with 76 columns and a whole number of 384-slot cabinets · every file-specific expectation
from `data/drills/README_drills.md` (listed under each drill).

## What failed at the first run, and the fix

| Drill | Expectation (README) | First run | Fix |
|---|---|---|---|
| A | defaults for location/area with **one** project-level TQ | two TQs (`TQ-PROJ-001` room, `TQ-PROJ-002` area) | `normalise` raises one "Project setting" TQ that names every missing location/area column |
| B | blank/**note rows ignored** | a note row (`NOTE: rows below added in revision`) became a "Missing tag" TQ and was quarantined | a row with no tag, IO type, cable **and** pair is a note/separator row: skipped, and counted in the import notes |
| C | segregation code `Z` → neutral + TQ | allocated as neutral, but **no TQ** | the A/B rule lists its `neutral` codes (`-`, `C`, `E`, learned from the sample); any other code raises ONE candidate TQ "Unrecognised segregation code" with Apply-able fix options |
| (all) | export opens | drill A's export check assumed 3 cabinets (it correctly has 2 when no room/area splits the domain) | the check now asserts 76 columns and a whole number of 384-slot cabinets |

Everything else passed on the first run (D sheet pick, E1+E2 merge with the 3 overlapping tags as TQs, E3 CSV byte-identical addresses
to the xlsx sample, F with 0 unchanged signals moved).

# Results

| Drill | Files | Live | Allocated | Quarantined | TQs | Violations | Export | Result |
|---|---|---:|---:|---:|---:|---:|---|---|
| A renamed/reordered/no room | drill_A_renamed_reordered_no_room.xlsx | 189 | 189 | 0 | 2 | 0 (PASS) | opens | **PASS** |
| B title rows/junk | drill_B_title_rows_blank_rows_junk.xlsx | 198 | 192 | 6 | 9 | 0 (PASS) | opens | **PASS** |
| C IS/AB/unknown seg | drill_C_IS_rows_AB_conflict_unknown_seg.xlsx | 189 | 189 | 0 | 4 | 0 (PASS) | opens | **PASS** |
| D multisheet | drill_D_multisheet.xlsx | 189 | 189 | 0 | 1 | 0 (PASS) | opens | **PASS** |
| E1+E2 multi-file | drill_E1_part1.xlsx, drill_E2_part2_overlap.xlsx | 192 | 189 | 3 | 4 | 0 (PASS) | opens | **PASS** |
| E3 csv | drill_E3_full.csv | 189 | 189 | 0 | 1 | 0 (PASS) | opens | **PASS** |
| drill_F revB | drill_F_revB_manual.xlsx | 192 | 192 | 0 | 1 | 0 (PASS) | opens | **PASS** |

### A renamed/reordered/no room

TQ categories: DO hardware conflict, Project setting · optimiser: cpsat

- ✅ auto-maps `tag` — TagNumber (1.0)
- ✅ auto-maps `io_type` — IO TYPE (1.0)
- ✅ auto-maps `cable` — Cable No (1.0)
- ✅ auto-maps `pair` — Pair (1.0)
- ✅ auto-maps `group` — Segregation (1.0)
- ✅ auto-maps `cable_spec` — Cable Spec (1.0)
- ✅ auto-maps `instrument_type` — Inst. Type (1.0)
- ✅ ONE project-level TQ for the defaults — 1: Technical room and Design / risk area column not found in the MDB — ev
- ✅ full allocation — 189/189
- ✅ no row-level default TQs

### B title rows/junk

TQ categories: Cable spec mismatch, DO hardware conflict, Duplicate tag, Missing cable, Missing pair, Pair exceeds cable size, Unknown DO type, Unknown IO type, Unreadable pair · optimiser: cpsat

- ✅ pair `1:0` → quarantined + TQ — Unreadable pair
- ✅ `Pair 99` on a 24-pair cable → quarantined + TQ — Pair exceeds cable size
- ✅ missing pair → quarantined + TQ — Missing pair
- ✅ IO type `XX` → quarantined + TQ — Unknown IO type
- ✅ no-cable row quarantined — Missing cable
- ✅ duplicate tag → TQ — Cable spec mismatch, DO hardware conflict, Duplicate tag, Missing cable, Missing pair, Pair exceeds cable size, Unknown DO type, Unknown IO type, Unreadable pair
- ✅ `UZV` allocated + TQ
- ✅ lowercase `ai` normalised to AIR and allocated
- ✅ header found below 3 title rows — header row 4

### C IS/AB/unknown seg

TQ categories: A/B on one cable, DO hardware conflict, Segregation clash on one cable, Unrecognised segregation code · optimiser: cpsat

- ✅ mixed IS/NON-IS cable → TQ — A/B on one cable, DO hardware conflict, Segregation clash on one cable, Unrecognised segregation code
- ✅ A+B on one cable → TQ naming the rules
- ✅ unknown segregation `Z` → TQ — A/B on one cable, DO hardware conflict, Segregation clash on one cable, Unrecognised segregation code
- ✅ IS never shares a baseplate with NON-IS (verifier) — 0 violations

### D multisheet

TQ categories: DO hardware conflict · optimiser: cpsat

- ✅ picks sheet `IO List` — IO List
- ✅ same result as the sample — 189 vs 189

### E1+E2 multi-file

TQ categories: DO hardware conflict, Duplicate tag across files · optimiser: cpsat

- ✅ 3 duplicate tags reported as a TQ — 3 tags in 3 TQ(s)
- ✅ not double-allocated (total = sample) — 189 vs 189

### E3 csv

TQ categories: DO hardware conflict · optimiser: cpsat

- ✅ same result as the xlsx sample — 189/1 TQ vs 189/1 TQ
- ✅ identical addresses to the xlsx sample

### drill_F revB

TQ categories: DO hardware conflict · optimiser: greedy

- ✅ 0 unchanged signals moved — 0 moved
- ✅ 3 slots freed — 3 deleted
- ✅ stability ≈ 97–99% — 97.9%
- ✅ DO → XYV swaps in place to SE4302T02 + SE4502 — 1
- ✅ swapped hardware is T02 + SE4502
- ✅ 4 + 2 = 6 signals added — 6
- ✅ 2 new tags land on their own pair of an existing cable — 2
- ✅ new cable 320-CE-0999 has 4 signals placed — 4
