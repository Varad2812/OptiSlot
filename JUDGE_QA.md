# OptiSlot — judge Q&A

Facts come from the repo and `docs/qa_facts.md`. Items not covered by those are marked [VERIFY].

## How is the Excel calculated and the allocation decided?
1. **Read and map** the MDB (header row found automatically, columns mapped with a confidence score).
2. **Normalise** (tag key, IO type map AI→AIR etc., cable size and pair parsed from the cable text).
3. **Pre-flight**: every bad row becomes a TQ.
4. **Group** signals by cable into blocks; sort by segregation family → IO group → cable size (largest first) → cable number.
5. **Place**: CP-SAT chooses the CIOC for each block per controller domain (greedy is the fallback and is used if CP-SAT's result fails the verifier). The exact slot comes from a deterministic first-fit layout: cables of 12+ pairs start at channel 1 and take whole baseplates; smaller cables stay inside one baseplate; pairs stay contiguous and in order.
6. **Address**: `CHARM_No = (baseplate − 1) × 12 + channel`. Hardware comes from the editable hardware map; names from the naming patterns.
7. **Write** one row per physical slot (384 per cabinet) into a copy of the blank template (76 columns).

**Worked example (real rows of `data/Sample_IO_Allocation_VIT_v2_1.xlsx`, sheet "IO Assignment", filter Field Cable No = `320-CE-0001`):**

| Pair | Tag / status | Baseplate | Ch | CHARM_No | CHARM |
|---|---|---|---:|---:|---|
| 1 | `320-FT   -20645-A` · Field | `001-CBP-2` | 1 | **13** | SE4303T01 |
| 1–12 | all on `001-CBP-2` | `001-CBP-2` | 1–12 | 13–24 | |
| 3 | `-` · **Spare Slot** (empty, protection cover) | `001-CBP-2` | 3 | 15 | SE6103 |
| 13 | `320-PV   -80017-A` · Field | `001-CBP-3` | 1 | **25** | SE4304T01 |
| 17 | `3201DSP0100135` · **Wired Spare** | `001-CBP-3` | 5 | 29 | SE4303T01 |
| 21 | `3201DSP0100139` · **Wired Spare** | `001-CBP-3` | 9 | 33 | SE4303T01 |

All rows are on CIOC `P30DCIOC3201001`. The formula `CHARM_No = (baseplate − 1) × 12 + channel` gives (2 − 1) × 12 + 1 = 13 for pair 1 and (3 − 1) × 12 + 1 = 25 for pair 13. This 24-pair cable takes two whole baseplates, with pairs contiguous and in order. Unused pairs are either wired spares (the cable's own pair, with the functional CHARM and a spare tag) or an empty slot with the SE6103 cover. Our engine's output matches this reference address for pair 1 (`001-CBP-2`, channel 1, CHARM_No 13).

## What if the headers are different?
Columns are matched with rapidfuzz plus a synonyms table and shown with a confidence score; any mapping can be overridden. A value-based inference covers required columns whose header is unrecognised. If a column such as room or area is missing, a project default applies and **one** project-level TQ is raised. Drills A (renamed/reordered, no room), B (title rows, junk), D (multi-sheet) and E3 (CSV) all ended with 0 violations and no crash (`docs/drill_report.md`).

## How do you know it is optimal?
We do not claim it. CP-SAT solves the CIOC assignment per controller domain, and the UI/API reports the solver **status** (OPTIMAL on the sample). **No lower bound is reported**, so OPTIMAL means optimal for the model's weighted objective, not a proof that the cabinet count is the minimum. What we do prove is validity: the independent verifier passes the result, and CP-SAT is adopted only if it verifies and scores better; otherwise greedy is kept. On the 950-row replica the 2 s limit is reached and the status is FEASIBLE; at 10,000 rows CP-SAT is skipped by design. Rev B uses greedy by design so pinned signals never move.

## What does Gemini do?
Only the optional "English → rule" box. Gemini (or Anthropic, if configured) receives your sentence plus our rule catalogue, never signal rows or project data, and returns a rule **draft**. The draft must validate against the rule's pydantic schema or it is rejected, then you preview the impact and add it. It never places a signal. The key comes from an environment variable. With no key or no network, a deterministic phrase parser answers and the UI shows which provider replied. [VERIFY] which provider and key are configured on the demo machine.

## What happens on a bad row?
It is **quarantined, never dropped**: kept in the Quarantine list, shown in the UI and in the TQ register, with a TQ that names the problem (missing cable or pair, duplicate cable+pair, pair beyond cable size, unreadable pair, unknown IO type). Unknown DO instrument types are still allocated, with a TQ. An A+B clash on one cable gets a TQ naming both rules, the cable is placed and the verifier reports it as "excepted by TQ", not a silent pass. Check C01 confirms every live tag is placed exactly once or TQ-covered. Drill B: 198 live, 192 allocated, 6 quarantined, 0 violations.

## What is the known difference vs the reference (`440-PI-20076-L` / `440-PI-20077-L`)?
The MDB contains only `440-PI-20077-L` (MDB row 157, AO, Pair 14 of `500-CE-LP-0003-A`). The reference allocation places `440-PI-20076-L` on that same cable and pair. We allocate what the MDB says, so `...20077-L` is allocated and `...20076-L` does not appear in our output. The verifier flags the pair when run on the reference workbook. Which side is correct cannot be proven from the data. Our CIOC for that pair also differs (`...002` vs the reference `...003`); address agreement with the reference is informational only (30/189 exact addresses).

## Other likely questions
- **Does the verifier trust the allocator?** No. `backend/verify` imports nothing from the engine and can check any xlsx, including a hand-edited one.
- **How many checks?** 22 per run; 23 rows in the exported `Rule_Check_Report` (adds C00). No C21/C22.
- **Show me it can fail.** Tamper test: edit one CHARM in the export; the verifier names the row and check. Across a 335-case tamper matrix, only `Revision No`, `Remarks` and `Change Type` are undetected.
- **Is it reproducible?** The output sha256 is identical across repeated runs; the certificate records input, ruleset and output hashes.
- **Speed?** Sample 1.2–1.4 s; 950 rows 6.3–6.4 s; 10,000 rows ~19 s end to end, ~3 s allocate + verify in memory. The first Allocate after a cold start waits ~15 s for the solver warm-up.
- **Tests?** 748 backend tests passing, 0 failed, including Hypothesis property tests. The fuzz harness passes 300 of 300 variants (seed 20261024).
