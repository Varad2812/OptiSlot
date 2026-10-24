# OptiSlot — the deep questions (rules, computation, data, proof) and the tough Q&A

Answers use only what the repo and the reports show. **[CHECK]** = confirm on the demo machine before you say it. Where a number is quoted, the source is named.

---

## Part 1 — "What are your rules based on? How do they compute, change the data, and can we see it happening?"

### 1.1 What are the rules based on?
Three sources, and every rule can be traced to one of them:

1. **The problem statement and the allocation guide** (`data/IO_Allocation_Fundamentals.docx`): A/B segregation, IS vs NON-IS, cable pairs contiguous, 12-pair cables take whole baseplates, 10% wired spares per IO type per controller, 10% future baseplates, cabinet alarms on baseplate 1 of CIOC 1, the CHARM/terminal-block choice per IO type, the DO load check, naming patterns.
2. **The sample IO MDB and the reference allocation**: the hardware map and terminal table were read from the reference (`backend/catalog.json`), and the sample is our regression test.
3. **Project settings**: the hierarchy (4 CIOC × 8 baseplates × 12 channels = 384 slots per cabinet), spare percentages, controller domain keys.

`docs/rule_coverage.md` is the table that maps **every** rule to: its rule id, the engine step that applies it, and the verifier check that proves it. It also lists the gaps honestly.

### 1.2 What does a rule look like?
Plain JSON in `rulesets/default.json` (13 rules), copied into each project's ruleset in the database. Example:

```json
{"id":"r-ab","type":"segregate","enabled":true,"severity":"hard",
 "label":"Never put A and B on the same CIOC",
 "params":{"level":"cioc","field":"group","families":{"A":["A","A-CONTROL"],"B":["B","B-ALARM"]},"neutral":["-","C","D","E"]}}
```

Two kinds of rule:
- **Constraint rules** decide *where* things may go: `segregate` (A/B at CIOC level, IS/NON-IS at baseplate level), `capacity`, `cable_contiguous`, `group_together` (soft), `reserve_baseplate`, `wired_spare_pct`, `future_spare_pct`.
- **Transform rules** decide *what the data becomes*: `io_type_map` (AI → AIR, DO → DOR), `hardware_map` (IO type + instrument → CHARM and terminal block), `naming_pattern` (cabinet, CIOC, baseplate names), `output_map` (which MDB columns go into which output columns).

### 1.3 How do the rules compute? (the pipeline)
`backend/engine/pipeline.py`, in order:

1. **Read** (`xio/reader.py`): find the header row, pick the sheet, auto-map columns with a confidence score.
2. **Normalise** (`engine/normalise.py`): trim and uppercase tags, map IO types (`r-io-map`), read pairs; missing columns use project defaults and raise **one** project TQ.
3. **Pre-flight** (`engine/preflight.py`): every data problem (duplicate tag, pair beyond cable size, unreadable pair, unknown IO type, A and B on one cable, mixed IS/NON-IS cable, unknown segregation code) becomes a **TQ**; unplaceable rows are quarantined, never dropped silently.
4. **Cable blocks**: signals on the same cable become one block. Blocks are sorted by family → IO group → size (biggest first) → cable.
5. **Place**: the CP-SAT optimiser (`engine/optimise.py`) chooses the CIOC for each cable block per controller domain; the exact slots come from the deterministic layout (first-fit, contiguous pairs, cables of 12 or more pairs take whole baseplates). If CP-SAT fails or its result does not pass the verifier, the greedy result is kept.
6. **Hardware**: `engine/hardware.py` looks up the first matching row of `r-hw` (CHARM + terminal block + terminals); solenoids (XYV/ZYV) get the isolated, fused DO; unknown DO types get standard DO **plus a TQ**.
7. **Spares and alarms**: wired spares are drawn from a cable's own unused pairs (10% per IO type per controller, rounded up); the last 10% of each cabinet's baseplates stay free; cabinet alarms go to baseplate 1 of CIOC 1.
8. **Names and rows**: names come from the naming patterns; every one of the 384 slots of every cabinet gets a row, Spare Slots included (`xio/render.py`).
9. **Verify** (`backend/verify/checks.py`): the separate verifier re-reads the output and checks every rule.

`CHARM_No = (baseplate − 1) × 12 + channel`, and the verifier recomputes it for every row.

### 1.4 How do rules change data, and how is the original protected?
- The **uploaded MDB is never edited**. Its bytes and sha256 are stored in SQLite; the allocation is recomputed from it plus the ruleset.
- When an engineer fixes a data problem (a pair number, an IO type, a cable), it is saved as a **data patch** (`xio/patches.py`, via `POST /signals/{tag}/patch`) on top of the stored file, with a preview first. The original file stays as uploaded, and the patch can be removed.
- Rule edits create a **new ruleset version** plus a decision-log entry; they can be undone. Same inputs + same ruleset → same hashes (the run certificate records input, ruleset and output sha256).

### 1.5 Can we see it happening? Yes — five live views
1. **Impact preview before saving** (Rules Studio): change a parameter and see violations, signals moved, wired spares, stability and TQs update. Example: raising wired spare % from 10 to 20 moved wired spares from 24 to 39 in the preview.
2. **"Why here?"** on any slot (3D Room inspector, Workbench): the ordered list of rules and decisions that put that signal there (`why[]` per slot, `GET /slots/{id}/why`).
3. **Workbench check**: try moving a signal and read ALLOWED / REFUSED with the rule id, plain-English reason and the signals involved. "Allowed" means the independent verifier found no new violation.
4. **Proof**: Re-verify ticks every check live; a tampered copy fails with the exact row and check.
5. **Under the surface**: `python3 scripts/dbwatch.py` shows each run, ruleset version and decision landing in the database as you click (new rows highlight), alongside the server log and the browser Network tab. Open `docs/ARCHITECTURE.md` for the setup.

**A 60-second demo of "rules compute and change data":**
1. Open `rulesets/default.json`, point at `r-ab`.
2. In Rules Studio, toggle `r-ab` off, read the preview, then discard (or save to show a new version).
3. Show the new version in `dbwatch.py` and the decision-log line.
4. Open Proof: the rule's verifier check (C07) and its status.
5. Open a slot → "Why here?" to show the rule steps for one signal.

---

## Part 2 — Tough questions

**Correctness**

1. **How do you know the allocation is correct?** A separate verifier re-reads the exported Excel and checks every enabled rule: each live tag once, no duplicate slots or cable pairs, the CHARM_No formula, A/B and IS separation, hardware, names, spares, full 384-row grids. On all drill files it reported 0 violations or violations excepted by a named TQ (`docs/drill_report.md`).
2. **Doesn't the verifier just trust your allocator?** No. `backend/verify` imports nothing from the engine. It works from the output rows, the normalised MDB and the ruleset, and it can check any xlsx, including a hand-edited one.
3. **Show me it can fail.** The Tamper test changes one CHARM in a copy of our own export and the verifier names the row and check. The copy is separate, so your real allocation is never touched.
4. **Is the result optimal?** We don't claim global optimality. The verifier proves validity; CP-SAT minimises CIOCs and keeps groups together and in sequence. No lower bound is reported anywhere (backend, API or UI); only the solver status (OPTIMAL on the sample) is shown (`docs/qa_facts.md` §3c).
5. **"Excepted by TQ": isn't that hiding failures?** It is the opposite of silent: when a clash cannot be satisfied (A and B on one cable, a mixed IS/NON-IS cable), we place the cable, raise a TQ naming the clash, and the verifier labels it "excepted by TQ", not a pass. Each one is counted and visible.
6. **Why 23 checks?** It is the number of rule checks the verifier ran, not the signal count. The default rule set runs 22 (C01–C20, plus C07.2 for IS/NON-IS and C17.2 for descriptive columns); re-reading the exported workbook adds C00 (all template columns present). Each enabled custom rule adds one (C23 and up). Verified by counting the Checks sheet of Rule_Check_Report.xlsx for the sample and the adversarial MDB (23 rows each).

**Rules and flexibility**

7. **Can I add a rule that you didn't write?** Yes, in Rules Studio: pick a template (max-per-scope, same/different scope, forbid-mix, zone→cabinets, extra spares), set the filter and scope, preview, add. Both the engine and a new independent verifier check enforce it. It's a safe declarative language, no `eval`.
8. **What if my rule contradicts another?** The preview shows the impact before saving (violations, TQs). A malformed rule is rejected with the reason; a rule change that would add a violation is rolled back.
9. **What does the AI do?** It only drafts a rule from English; the draft must validate against the rule schema, then you preview and press Add. It never places a signal. With no key or no network, a built-in parser handles the common phrasings.
10. **What data goes to the AI provider?** Only your sentence and our rule catalogue. No signal rows or project data. **[CHECK]** the provider on the day (Gemini); the key lives in an environment variable.
11. **Another DCS platform?** Hierarchy sizes, hardware map and naming are data, so it would be a new rule pack. We have only built and tested against the DeltaV-style sample.

**Surprise data**

12. **What if the file is different from the sample?** Columns are auto-mapped with confidence (override any). We ran 8 messy files (renamed columns, title rows, multi-sheet, multi-file, CSV, IS rows, A/B clash, junk values): all 0 violations, no crashes.
13. **What if room or area columns are missing?** Defaults apply and one project TQ lists them.
14. **Bad rows?** Quarantined with a TQ and visible in the list; the verifier checks every live tag is accounted for.
15. **A cable with A and B signals?** One TQ naming both rules ("re-tag or split"); the cable is placed on one family and marked excepted.
16. **What if capacity runs out?** New cabinets are created within the configured limits; beyond them a capacity TQ names the rule. The 10,000-signal test produced 46 cabinets.
17. **Speed at 10,000 signals?** The target is under 3 s. Measured (`docs/qa_facts.md` §5): allocate + verify on 10,000 synthetic signals in memory is ~3.0–3.2 s (allocate ~2.2–2.5 s); from an xlsx, read to export takes ~19 s end to end. **[CHECK]** re-measure on the demo machine and quote only that.

**Revisions**

18. **How does Rev B work?** Unchanged signals are pinned to their slots; new ones take wired spares and free slots first. Stability = unchanged-in-place ÷ previous live signals. On drill F: 0 unchanged signals moved, stability 97.9%.
19. **Can pinning block a new rule?** No. If a pinned signal violates a hard rule it moves, with the reason recorded.
20. **A signal changes hardware in Rev B?** It keeps its slot and its CHARM and terminal block swap in place (drill F: DO → XYV).

**Fidelity**

21. **Your addresses don't match the reference.** Correct: 16% on baseplate, 35.6% on CHARM_No. The reference is hand-placed and many layouts satisfy the same rules. We report non-address columns: 97.86% match, 60 of 66 columns at 100%. The unmatched ones are hand-typed (Revision No, Remarks, Section / Sub Unit).
22. **`440-PI-20077-L` vs `440-PI-20076-L`?** The MDB contains only `440-PI-20077-L` (row 157); the reference places `440-PI-20076-L` on the same cable and pair. We allocate what the MDB says; which side is right cannot be proven from the data (`docs/qa_facts.md` §1).

**Engineering**

23. **Is it reproducible?** Every run records sha256 of the input, ruleset and output plus the engine version; tests confirm the same inputs give the same hashes, also after a restart. **[CHECK]** show it live once.
24. **How is it tested?** 664 backend tests, including Hypothesis property tests (allocator vs verifier agreement, junk rows never crash, workbench "allowed" implies the verifier agrees) and a drill test that fails if any drill regresses.
25. **Does it work offline?** Yes: no CDN, fonts or textures are fetched; the only optional network call is the AI assistant, which falls back automatically.
26. **Where is the data stored?** SQLite (`projects/optislot.db`): uploaded files, ruleset versions, runs, decisions, activity. Outputs are recomputed, never trusted from storage.
27. **Why a separate verifier?** So the checker can't share a bug with the allocator, and so it can audit files we didn't make.

**Honesty**

28. **What doesn't it do?** It's decision support, not a live DCS link; DO load/inrush is a TQ, not a calculation (no load data); project-specific segregation codes beyond A/B are neutral plus a TQ; four traceability columns (Revision No, Change Type, Remarks, Old Tag) are written but not independently verified (`docs/rule_coverage.md` gaps).
29. **What did you promise in the semifinals and not deliver?** Answer from the "Promised → delivered" slide; mark anything not demonstrated as not done.
30. **Show me the backend actually working with the UI.** Three windows: the app, the server log (one line per request), and `scripts/dbwatch.py`. Click; point at the line and the database row. Also `/docs` for the API contract.
