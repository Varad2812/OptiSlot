# Surprise-dataset drills — what each file tests and what MUST happen

Put all files in `data/drills/`. B1a/B1c runs them automatically. After U4 is built, also upload each one through the UI.
PASS for every file means: **no crash, every live tag either allocated or in a TQ, verifier 0 violations (or "excepted by TQ"), export opens**.

| File | What's messy | Expected behaviour |
|---|---|---|
| `drill_A_renamed_reordered_no_room.xlsx` | Columns renamed (`TAG NO.`, `IO TYPE`, `Cable No`, `Pair`, `Segregation`, `Cable Spec`, `Inst. Type`), shuffled; Technical Room, Design Area and OA columns **deleted** | Auto-mapping finds all key fields (low-confidence ones flagged to confirm); defaults used for location/area with **one** project-level TQ; full allocation, 0 violations |
| `drill_B_title_rows_blank_rows_junk.xlsx` | 3 title rows above the header; blank rows and a note row mid-table; junk: pair `1:0`, `Pair 99` on a 24-pair cable, missing pair, IO type `XX`, lowercase `ai`, a duplicate tag, a tag with extra spaces, DO with unknown instrument `UZV`, a row with no cable | Header found; blank/note rows ignored; `1:0`, `Pair 99`, missing pair, `XX`, no-cable → quarantined with TQs; `ai` → normalised to AIR and allocated; duplicate → TQ; spaced tag → trimmed and allocated; `UZV` → allocated on standard DO + TQ "confirm load" |
| `drill_C_IS_rows_AB_conflict_unknown_seg.xlsx` | 21 IS rows (all of cable 320-CE-0040 + 2 rows of 320-CE-0035 → a mixed IS/NON-IS cable); one A tag on B cable 320-CE-0045; segregation code `Z` on 2 rows | IS never shares a baseplate with NON-IS; the mixed cable → TQ "excepted by TQ"; A+B on one cable → TQ naming both rules ("re-tag or split"); `Z` → treated as neutral + TQ |
| `drill_D_multisheet.xlsx` | Workbook with `Cover` and `Instructions` sheets first; data on sheet `IO List` | The tool picks `IO List` automatically; same result as the sample |
| `drill_E1_part1.xlsx` + `drill_E2_part2_overlap.xlsx` | The MDB split into 2 files that overlap by 3 rows | Upload both at once → merged; the 3 duplicate tags reported as a TQ (not double-allocated); total = the sample |
| `drill_E3_full.csv` | The full sample as CSV | Same result as the xlsx sample |
| `drill_F_revB_manual.xlsx` | A hand-made Rev B: 3 tags DELETED, 1 standard DO changed to solenoid `XYV`, 2 new tags on spare pairs 23/24 of an existing cable, a new 6-pair cable `320-CE-0999` with 4 signals | Load as a revision of the sample → 3 freed slots, DO keeps its slot but swaps to SE4302T02 + SE4502, the 2 new tags land on their own pairs, the new cable gets a free block, **0 unchanged signals moved**, stability ≈ 97–99%, 0 violations |

## Manual UI drill (after U4)
For each file: Import → check the mapping chips → Allocate (Dive plays) → scoreboard → TQ Center → Proof (re-verify) → Export opens in Excel.
Write down anything that crashes, looks wrong, or is confusing, and send it to Claude.
