# OptiSlot — IO Signal Sudoku

**Allocate. Prove. Revise.** Hackathon finals · Emerson track · Problem Statement #02 · team Brownie.

OptiSlot reads any IO MDB workbook, allocates every live signal to a CHARM slot (cabinet → CIOC → baseplate → channel),
proves the result with an independent verifier that re-reads the exported Excel, and revises (Rev B) while moving only what changed.

## Verified facts (HEAD `05f6399`)

| Item | Value |
|---|---|
| Backend tests | 748 passed, 0 failed |
| Fuzz harness | 300 of 300 variants pass (seed 20261024) |
| Verifier checks | 22 per run in memory; the exported `Rule_Check_Report` has 23 rows (adds C00, "workbook has every template column"). There is no C21 or C22. Each enabled custom rule adds one (C23+) |
| Rules | 13 in `rulesets/default.json` |
| Time, sample MDB (189 live signals) | 1.2–1.4 s end to end |
| Time, 950-row replica | 6.3–6.4 s end to end |
| Time, 10,000-row replica | ~19 s end to end (read + allocate + write xlsx + verify); ~3 s allocate + verify in memory |
| Reproducibility | the output sha256 is identical across repeated runs |
| Optimality | only the CP-SAT solver status (OPTIMAL for the CIOC assignment) is reported; **no lower bound is reported** |
| Revisions | Rev B runs greedy by design (CP-SAT is off for revisions, so pinned signals never move) |
| Tamper matrix | 335 cases; only `Revision No`, `Remarks` and `Change Type` go undetected |
| Cold start | the first Allocate after a cold start waits ~15 s for the solver warm-up |

Sources: `docs/qa_facts.md` (older measurements, kept as written), `docs/drill_report.md`, `docs/fidelity_report.md`, `docs/rule_coverage.md`.
`docs/qa_facts.md` was measured at an earlier commit; where it differs from the table above, the table is newer.

## Run

```
make demo      # builds the frontend; FastAPI serves it on :8000 (one process, offline-safe)
make dev       # backend :8000 + Vite :5173
```

Wait ~20 s after start for the OR-Tools warm-up before the first Allocate. No CDN, fonts or scripts are fetched; the optional AI assistant falls back to built-in rule templates when offline.

## Layout

`backend/` engine, verifier, FastAPI · `frontend/` React + three.js · `rulesets/default.json` the 13 rules as data · `data/` sample MDB, blank template, reference answer, drills · `docs/` architecture, rule coverage, QA.

## Known difference vs the reference

The MDB contains `440-PI-20077-L` (row 157) and no `440-PI-20076-L`. The reference allocation places `440-PI-20076-L` on the same cable and pair. We allocate what the MDB says. Which side is right cannot be proven from the data. Details: `docs/qa_facts.md` §1.

## More

`DEMO_SCRIPT.md` (8-minute plan) · `JUDGE_QA.md` · `FINALS_DECK_OUTLINE.md` · `docs/ARCHITECTURE.md` · `docs/questions.md`.
