# OptiSlot — 18-Hour Prompt Book
*IO Signal Sudoku · Emerson track finals*

> **Built on our semifinal deck (team Brownie · OptiSlot · "Allocate. Prove. Revise.").** The judges have already seen what we promised, so this book makes sure every promise is visibly delivered. See the checklist at Gate B.
>
> **The pitch in one line:** "Engineers spend weeks hand-placing 10,000 signals in Excel and redo it every revision. OptiSlot does it in seconds from rules they control — and *proves* zero violations."

---

## ▶ NOW: Control Room UI build (supersedes the UI parts of P3, P3b, P4, P5, P6)
Backend is done and verified (commits ab12a7d → a17669e). The UI spec is **CLAUDE.md §10 "OptiSlot Control Room"**. One phase = one fresh Claude Code session (`/clear` first).

| Time (approx.) | Phase | Who | Model |
|---|---|---|---|
| 23:00–02:30 | **U1** Design system + shell + Flow Rail + Scoreboard + the World (Cabinet Explorer, Upload Dive, cabinet glide) | everyone watches; 1 driver | Opus 5.5 |
| 23:00–02:30 | **B1** Backend fixes + P7 hidden-test drills (separate branch, no frontend) | backend person | Opus 5.5 |
| 02:30–05:30 | **U2** Mission Control + Proof Center | Person B | Opus 5.5 |
| 02:30–05:30 | **U3** Try-out Lab + Revision Center | Person A | Opus 5.5 |
| 02:30–05:30 | **U4** Import & Mapping, Rules Studio, TQ Center, Allocation Grid, Export | Person C | Sonnet 5.5 |
| 05:30 | **GATE B** — merge branches, feature freeze, checklist below | all | — |
| 05:30–07:00 | **U5** Motion + polish pass + projector check | 1 driver | Opus 5.5 |
| 07:00–08:00 | **P8b** Offline cold-start drill + backup video | all | Sonnet 5.5 |
| 08:00–09:00 | **P9** README, demo script, pitch, rehearse twice | all | Sonnet 5.5 |
Solo? Run U1 → U2 → U3 → U4 → U5 in order and cut U4 screens to the minimum.

### U1 · Foundation + the World (23:00–02:30)
**Model: Opus 5.5** · plan mode
```
Read CLAUDE.md, especially §10 "OptiSlot Control Room" — it is the spec. Backend + API are complete
and tested; build UI ONLY. Use TanStack Query against the real API, with the generated fixtures as
the offline fallback. Never change engine/verifier code; if the UI needs a field, add it to
backend/app/schemas.py and run `make types`. Delete the temporary /kit page.
Build:
1. §10.1 tokens (dark + light), the radial background, the glass and hairline utilities, IO colour
   constants, typography — wired into Tailwind + shadcn.
2. §10.2 shell: top bar with the Flow Rail (step states driven by real project state), the
   scoreboard strip with count-up numbers, the left sidebar with all 10 routes (placeholders allowed
   for screens built later — but styled, never blank), the Inspector drawer with "Why here?",
   ⌘K, the keyboard shortcuts, the theme and Motion (Cinematic/Calm) toggles.
3. §10.3 <CabinetWorld>: 2.5D SVG, camera with spring transforms, the Plant → Cabinet → CIOC/Baseplate
   → Slot semantic zoom, the minimap, level of detail, memoised slots, front/rear flip.
4. The Cabinet Explorer screen (§10.5.2) using it, fully working on real data.
5. Motion moments §10.4.1 (Upload Dive — trigger it from the demo project for now; U4 connects the
   real upload) and §10.4.2 (cabinet-to-cabinet glide). Both skippable; Calm mode = fades.
   `?demo=1` exposes hooks so Playwright can trigger and freeze sequences at given progress points.
6. Extend scripts/shots.mjs to capture motion frames (0/25/50/75/100%) for the dive and the glide.
Visual QA loop (§10.6) at least 3 rounds: look at every PNG and frame, critique in docs/ui_review.md,
fix, re-shoot. Check that FPS stays ~60 during the glide, and that the 10k stress project is still usable.
Commit on master as "ui: control room foundation + world".
Done when: the Explorer looks premium and full in both themes, the dive and the glide are smooth
and glitch-free in the frame captures, and every route is styled (no blank pages).
```

### B1 · Backend fixes + hidden-test drills (parallel with U1, own branch `backend/drills`)
**Model: Opus 5.5**
```
Do NOT touch frontend/. Fix these deviations from CLAUDE.md, with tests, without changing any verified
output on the sample:
1. engine/hardware.py: the SE4302T02 literal → read the isolated-DO CHARM from the ruleset.
2. Revisions: support chains (A→B→C); revision numbers come from settings, not hard-coded "01".
3. TQ Apply: re-allocate revision-style (pinned), not from scratch.
4. TQ data-patch fix options: actually apply the patch (e.g. rename a tag), then re-run.
5. Move the remaining literals (spare cover SE6103, alarm remark, the IO order fallback) into
   the ruleset/catalog.
Then run Phase P7 hidden-test drills (both cioc_strategy modes; include files with the room/area
columns deleted) and write docs/drill_report.md. Keep `make fixtures` and the API schemas unchanged
unless strictly needed — if you change a schema, say so loudly in the commit message.
```

### U2 · Mission Control + Proof Center (Person B, branch `ui/mission-proof`)
**Model: Opus 5.5**
```
Context: the backend is complete; the design system, shell and <CabinetWorld> exist from U1. Reuse
them; no new colours or ad-hoc components. Build ONLY:
1. Mission Control (CLAUDE.md §10.5.1) — full from the first second; the live Plant strip uses
   <CabinetWorld> at Plant level, and clicking a cabinet dives into the Explorer with the camera
   transition; every tile clickable.
2. Proof Center (§10.5.4) with the Verify scan (§10.4.3) and Tamper caught (§10.4.4) motion:
   certificate stamp; the verifier's checks ticking (the report's count, 23 on the default rule set); "Re-verify now"; the "Verify any Excel" drop zone
   using POST /api/verify-file; failing rows → "fly to slot"; run history with hashes.
Visual QA loop incl. motion frames. Commit on your branch.
Done when: tampering an exported file and dropping it in shows the red pulse on the exact slot,
and Mission Control looks full and premium in both themes.
```

### U3 · Try-out Lab + Revision Center (Person A, branch `ui/tryout-revision`)
**Model: Opus 5.5**
```
Context: the backend is complete (whatif, commit, undo, revisions, gauntlet endpoints exist); the
design system, shell and <CabinetWorld> exist from U1. Reuse them. Build ONLY:
1. Try-out Lab (CLAUDE.md §10.5.3) with the Try-out motion (§10.4.6): split Current | Proposed with
   synced cameras, the Impact panel, click-to-move slot/whole cable block, rule toggles, spare
   sliders, the balanced/compact switch, Commit/Discard, undo/redo.
2. Revision Center (§10.5.5) with the Rev B diff motion (§10.4.5): Inject Rev B, upload your own,
   stability gauge, change cards, from→to list with reasons, and an automatic re-verify (show the
   scoreboard staying at 0 violations). Wire the top-bar Inject Rev B button to it.
Visual QA loop incl. motion frames. Commit on your branch.
Done when: you can demo — B cable onto an A CIOC is refused with a shake + reason; the compact switch
shows the CIOC saving in Impact; Inject Rev B animates only the changed slots.
```

### U4 · Supporting screens (Person C, branch `ui/supporting`)
**Model: Sonnet 5.5**
```
Context: the backend is complete; the design system, shell and <CabinetWorld> exist from U1. Reuse
them. Build ONLY these screens per CLAUDE.md §10.5: Import & Mapping (6) — and connect the REAL upload
to the Upload Dive sequence from U1; Rules Studio (7); TQ Center (8) with Apply + patch preview;
Allocation Grid (9) with row → fly-to-slot; Export (10). Visual QA loop. Commit on your branch.
Done when: upload the sample MDB → mapping → pre-flight → Allocate plays the Dive → the Grid, TQs,
Rules and Export all work against the real API.
```

### ✅ GATE B (≈05:30) — merge all branches into master, then check
- [ ] `make test` + `npm run typecheck` + `npm run shots` all pass after the merge
- [ ] The full demo flow below runs end to end without touching code
- [ ] Every item in the "Semifinal promises checklist" (Gate B in the original section) is visible in the UI

### U5 · Motion + polish pass (≈05:30–07:00)
**Model: Opus 5.5**
```
Act as the lead product designer before a hackathon final judged by Emerson engineers on a projector.
Run `npm run shots` (incl. motion frames). Review every screen and sequence against CLAUDE.md §10 in
docs/ui_review.md: emptiness, hierarchy, colour harmony, contrast on a projector (check the light
theme too), alignment, consistency, motion timing (too slow? janky? gimmicky?), mid-animation glitches,
truncation. Fix the top 20 issues. Make sure the Upload Dive, the cabinet glide, the Verify scan and
the Rev B diff each feel cinematic but finish fast, and that Calm mode works. Re-shoot and repeat once.
Commit.
```
---

## ▶ 3D Marshalling Room (window 2, from ~07:30) — spec: CLAUDE.md §10.7
Base: our approved prototype at `frontend/legacy3d/3d_prototype.html` (vanilla three.js). Port it; don't redesign it. T1 only, one prompt per fresh session.

### 3D-0 · Port the prototype as an engine + real data (≈ 1 h)
**Model: Opus 5.5 · high** · plan mode
```
Read CLAUDE.md §10 and §10.7 fully, and study frontend/legacy3d/3d_prototype.html line by line — it is
the approved look. Don't touch backend/; commit with explicit paths only.
1. npm-install pinned three@0.160.x and camera-controls@2.8.x (no CDN, no React Three Fiber).
2. Port the prototype into src/world3d/engine.ts (class World3DEngine, the imperative API in §10.7)
   + src/world3d/World3D.tsx (React wrapper + HTML overlay in our design system). Keep its visuals,
   transitions, Bloom, doors, explode, fade registry and Dive trails.
3. Apply §10.7 "Changes the port MUST make" items 1, 2, 3 and 7: real allocation data + settings-driven
   counts and layout; remove the fake Value readings; the scale work (instancing, focus ±1 detail,
   colour updates only on change); offline.
4. Show World3D in Cabinet Explorer behind a "3D / 2D" toggle (default 3D).
5. Measure FPS on the sample and stress10k (headless swiftshader — indicative) + time to first frame;
   capture frames at L0, L1 and mid-Dive.
Report the numbers + frames and STOP. Commit "3d: engine port".
Done when: it looks like the prototype but on real data, works offline, ≥ 55 fps on the sample and
≥ 30 at 10k.
```
Send Claude (in chat) the report + frames before continuing.

### 3D-A · Navigation, levels, fallback, integration (≈ 1.5 h)
**Model: Opus 5.5 · high**
```
Continue from "3d: engine port" per CLAUDE.md §10.7 items 4, 5 and 6: ←/→ sibling nav, F rear rotate,
hover highlight, / search → flyToSlot; level labels via CSS2DRenderer (focused level only); L4 →
the app Inspector with "Why here?"; filter chips dim non-matching CHARMs; A/B rings; the WebGL/FPS
fallback to 2.5D. Make World3D the default in Cabinet Explorer, the Mission Control plant strip and
the Workbench "show in cabinet" view. Implement CLAUDE.md §10.8: a new /room page that is the landing
page after Import→Allocate→Dive; door-open → CIOC → baseplate → CHARM; hover cards with a "Try changes"
button deep-linking into the Workbench with the signal preselected; the [Before | Now] toggle + Compare
mode + changes list driven by the Workbench's apply/preview (animateMove); "Show in 3D" on every
table row; restyle other pages' header/legend if they clash with the 3D page. Visual QA: 2 rounds with frames at every level and
mid-transition. Commit.
Done when: Room → CHARM → back is smooth with no popping/overlap/blank frames; the fallback works; FPS
targets are held.
```

### 3D-B · Motion moments + Cinematic Tour (≈ 1.5 h)
**Model: Opus 5.5 · high**
```
Implement §10.7 "Motion moments" 1–6 on the engine API and wire them in: the Dive → Import's Allocate;
Verify scan + Tamper → Proof Center; check/apply animations → Workbench + Try-out; the Rev B diff →
Revision Center; a "Cinematic Tour" button in the top bar. All skippable, Calm = cuts + fades, and
?demo=1 seek hooks for Playwright. Visual QA: 2 rounds with frames. Commit after every 2 moments.
Done when: every moment plays smoothly on the sample with real data, and the Tour runs end to end
without input.
```

---

## How to use this book

**Before hour 0**
1. Create the repo. Put `CLAUDE.md` in the root and this file at `docs/PROMPT_BOOK.md`.
2. Copy the 4 data files into `/data`, renamed to drop the random prefixes:
   - `Sample_IO_MDB_VIT_v2_1.xlsx`
   - `Blank_IO_Allocation_Template.xlsx`
   - `Sample_IO_Allocation_VIT_v2_1.xlsx`
   - `IO_Allocation_Fundamentals.docx`
3. Install Python 3.11+, **uv**, Node 20+ and git. Pre-download npm and uv/pip packages (including `ortools` and `hypothesis`) while you still have internet. Set `ANTHROPIC_API_KEY` only if the venue allows internet.
4. Optional, for offline AI: install **Ollama** and pre-pull one small instruct model that is good at JSON (e.g. a 7B Qwen or Llama instruct). Skip this if your laptops are weak — the template parser fallback is enough.
5. If the finale turns out to be 24 hours instead of 18: give the extra time to P4b (CP-SAT) and P8a (polish). Don't add new features.

**Session rules (these matter more than the prompts)**
- **One phase = one fresh Claude Code session.** Clear the context between phases, because long sessions get sloppy. CLAUDE.md is re-read automatically every time.
- For **Opus phases**, start in **plan mode**: let it propose a plan, skim it, then approve.
- Paste prompts **exactly**. Every prompt ends with a **Done when** checklist. Don't move on until every item is true.
- **Commit at the end of every phase**: `git commit -am "phase N: …"`.
- When something breaks, use the **Rescue prompts** at the end of this book instead of improvising.
- **Usage limits**: 18 hours of Opus can hit plan limits. Every teammate runs Claude Code on their own account; use Sonnet for anything not marked Opus. If Opus is rate-limited mid-phase, continue that phase on Sonnet with the same prompt — the Done-when checklist still applies.

**Models**
| Model | Use it for |
|---|---|
| **Opus 5.5** | Architecture, the allocation engine, the verifier, revision logic, the sandbox, design-system and UI quality passes, hidden-test drills. Use it anywhere correctness or taste decides the score. |
| **Sonnet 5.5** | Building screens on an existing design system, wiring APIs, exports, tests, README and pitch text. Faster for volume work. |

**Team layout**
- **2+ people**: run **Track E (Engine)** and **Track U (UI)** in parallel from hour 0:45. Use separate branches or git worktrees and merge at the gates.
- **Solo**: follow the hours in order. UI phase 3 starts right after Gate A.

---

## Timeline at a glance

| Time | Track E — Engine | Track U — UI | Model |
|---|---|---|---|
| 0:00–0:45 | **P0** Setup + data recon (together) | | Opus |
| 0:45–3:30 | **P1** Parse → normalise → pre-flight → allocate (full grid) | **P3** Design system + shell + Cabinet Floor (mock JSON) | Opus / Opus |
| 3:30–5:45 | **P2** Verifier + Excel writer + reports | P3 cont. → Mission Control | Opus / Sonnet |
| **6:00** | **GATE A** — engine proven on sample | **GATE A** — shell + Cabinet Floor look great | — |
| 6:00–7:00 | **P4** API + SQLite + integration | **P4** Import, Grid, TQ Center, Export screens | Sonnet |
| 7:00–8:30 | **P4b** CP-SAT optimiser (greedy stays as fallback) | P4 cont. | Opus |
| 8:30–11:00 | **P5** Revisions + Inject Rev B Gauntlet | P5 Revision Diff screen | Opus |
| 11:00–13:30 | **P6** What-if Sandbox + TQ Apply + Why-here + BOM | P6 Rules Studio | Opus / Sonnet |
| **13:30** | **GATE B** — feature freeze | | — |
| 13:30–15:30 | **P7** Hidden-test drills + 10k stress | **P8a** Design polish pass | Opus |
| 15:30–16:30 | **P8b** Offline cold-start drill + record backup demo video | | Sonnet |
| 16:30–17:15 | **P9** README, demo script, pitch | | Sonnet |
| **17:15** | **CODE FREEZE.** Rehearse the demo twice. | | — |

**Cut list if you fall behind** (cut from the top; same spirit as the deck's cut line):
1. Ollama / AI layer — keep the template parser
2. Light theme
3. BOM sheet
4. Sandbox sliders
5. CP-SAT — greedy plus the verifier is still a valid, proven answer; say "CP-SAT improves it when time allows"
6. Drag-and-drop (it's stretch anyway)
**Never cut:** the verifier + tampered-copy check, the full-grid Excel output, Rev B pinning, TQs, the scoreboard, Cabinet Floor, Mission Control.

---

## P0 · Setup + data recon (0:00–0:45) — both tracks together

**Model: Opus 5.5** · plan mode
```
Read CLAUDE.md completely. Then:
1. Scaffold the monorepo exactly as in CLAUDE.md §9:
   - backend/ managed with uv (FastAPI, pydantic v2, openpyxl, pandas, rapidfuzz, ortools, pytest, hypothesis)
     with app/, engine/, verify/, io/, store/ (sqlite3, WAL), tests/
   - frontend/ (Vite React TS, Tailwind, shadcn/ui init, the listed libs, @fontsource fonts — no CDN)
   - rulesets/, projects/, scripts/, data/, shots/
   - Makefile with `make dev`, `make demo`, `make test`
2. scripts/extract_catalog.py: read data/Sample_IO_Allocation_VIT_v2_1.xlsx and write backend/catalog.json
   with every CHARM type → description and TB part → description exactly as spelled there.
3. scripts/profile_data.py: print a data profile of the MDB — distinct IO types, signal types,
   instrument types per IO type, cable sizes, cables with mixed segregation families, rooms/areas,
   statuses, rows with missing cable/pair, duplicate cable+pair. Save it to docs/data_profile.md.
4. rulesets/default.json implementing every default rule in CLAUDE.md §3–5 (io_type_map, hardware_map,
   naming patterns, segregate A/B at CIOC, capacity, cable_contiguous, group_together,
   reserve_baseplate for cabinet alarms, wired_spare_pct 10, future_spare_pct 10).
5. FREEZE THE API CONTRACT before the tracks split (CLAUDE.md §9 "API contract"):
   - backend/app/schemas.py with pydantic models for Project, ProjectSettings, Slot, Cabinet,
     AllocationResult (cabinets, kpis incl. spares per cabinet, tqs, report, certificate), TQ,
     RuleSet, Rule, WhatIfRequest/Result, RevisionImpact, RunRecord
   - stub FastAPI routes that return realistic fixture data built from these models
   - `make types` generating frontend/src/api/types.ts via openapi-typescript
   - fixtures in frontend/src/mock/ (3 cabinets × 384 slots, realistic tags and TQs) + a test that
     they validate against the schemas
Commit.
Done when: `make test` runs (even with 0 tests), `make dev` serves a blank page, and
docs/data_profile.md + backend/catalog.json + rulesets/default.json exist and look right.
```

---

## TRACK E — Engine

### P1 · Core allocation engine (0:45–3:30)

**Model: Opus 5.5** · plan mode
```
Implement CLAUDE.md §3 and §4 in backend/engine as pure functions with typed pydantic models.
1. io/reader.py: read any xlsx; detect the header row; auto-map columns to canonical fields using rapidfuzz
   plus a synonyms table; return the mapping with a confidence per field. Ignore blank or junk rows.
2. engine/normalise.py: tag key, IO type map, cable size + pair parsing, room→loc and area→area codes,
   DSTName, segregation family. Use Project Settings (CLAUDE.md §3) defaults whenever a column is
   missing: ONE project-level TQ, never a TQ per row, and never block allocation.
3. engine/preflight.py: produce TQ objects (id like TQ-DATA-001, category, severity, tag, field,
   rows, rules_in_conflict, message, fix_options with machine-applicable patches, unchanged_note,
   confidence confirmed|candidate) — exactly the TQ object in CLAUDE.md §4. Every TQ case in §4.1.
   Bad rows are quarantined (kept and reported), never dropped silently.
   Unknown DO instrument type = allocate with the default + a TQ whose fix option patches the
   hardware_map to isolated+fused.
4. engine/allocate.py: partition by domain → reserve the cabinet-alarm BP and future-spare BPs → sort
   blocks (family → IO grouping → size desc → cable no) → first-fit placement with the boundary rules
   → wired spares per controller per IO type → Spare Slot for everything else → names from patterns →
   why[] trace per slot. NO defragmentation. Output the FULL grid: 384 rows per instantiated cabinet,
   in physical order.
5. All behaviour is driven by the ruleset JSON; no project constants in code.
6. tests/test_engine.py:
   - sample MDB → every live tag allocated or TQ'd
   - no slot used twice; A and B families never share a CIOC
   - the 24-pair cable occupies exactly 2 whole baseplates starting at channel 1
   - full-grid row count = 384 × cabinets
   - DELETED tag absent; 440-PI-20077-L handled (allocated, or a TQ explaining why)
   - print % address agreement vs the reference workbook (informative only)
   - Hypothesis property test: random mixes of 1/2/6/12/24-pair cables whose total fits the CIOC
     capacity rules always produce a valid layout (thousands of examples)
Run the tests and iterate until they pass. Commit.
Done when: all tests pass, and a CLI `python -m engine.run data/Sample_IO_MDB_VIT_v2_1.xlsx` prints
counts per Tag Status, cabinets/CIOCs used, TQs by category, and runtime.
```

### P2 · Verifier + Excel writer + reports (3:30–5:45)

**Model: Opus 5.5**
```
Implement CLAUDE.md §6 and §8.
1. verify/: an independent verifier. It must NOT import anything from engine/ except the shared pydantic
   row model. Inputs: output rows + normalised MDB + ruleset. Implement every check in §6. Each check
   has an id, a label, pass/fail counts and violating rows. Add verify_xlsx(path) that reads a written
   allocation workbook back in, so we can verify the actual exported file — or ANY uploaded file.
   Run certificate: sha256 of the input MDB(s), ruleset version hash, output file hash, engine version,
   timestamp. Same inputs → same hashes → same output (add a test for reproducibility).
2. io/writer.py: write the allocation into a COPY of data/Blank_IO_Allocation_Template.xlsx with
   openpyxl (never DataFrame.to_excel):
   - all 76 columns in template order; "-" for N/A, matching the reference row patterns for Field,
     Wired Spare, Spare Slot and Cabinet Alarm
   - copy row-2 style to every row beyond 237; autofilter A1:BX{last}; freeze pane D2
3. Reports: Rule_Check_Report.xlsx, TQ_Register.xlsx, Capacity_BOM.xlsx (cabinets, CIOCs, BPs,
   count per CHARM/TB part no., fill %, wired spares vs target per controller × IO type, headroom).
   Style them like the template (header fill #1F3864, white bold text, thin borders, autofilter).
4. Tests:
   - round-trip: allocate sample → write xlsx → verify_xlsx → 0 violations
   - verify_xlsx on the reference workbook runs and reports results
   - a deliberately broken allocation (swap an A cable onto a B CIOC, duplicate a slot, drop a tag)
     → the verifier catches all three
   - tampered-file test: open the exported xlsx with openpyxl, change one CHARM type, save it,
     run verify_xlsx → FAIL naming that exact row and check
Commit.
Done when: tests pass, and the exported workbook opens cleanly with formatting identical to the
template on every row (open it and check visually with a screenshot via LibreOffice headless).
```

### ✅ GATE A (6:00) — do not pass with any item failing
- [ ] The sample gives 0 violations, verified on the **exported file**
- [ ] Every live tag is allocated or has a TQ; the full grid is present
- [ ] The exported xlsx looks like the template on every row
- [ ] The verifier catches the 3 planted breakages AND the tampered file
- [ ] Running twice gives identical hashes

If Gate A fails, everyone moves to the engine until it passes.

---

## TRACK U — UI

### P3 · Design system + shell + Cabinet Floor (0:45–5:00)

**Model: Opus 5.5** · plan mode
```
Read CLAUDE.md §10 carefully; it is the spec, not a suggestion. Build the frontend foundation:
1. Design tokens as CSS variables (dark default + light), Tailwind theme mapped to them, IO colour
   constants shared by every component, Inter/JetBrains Mono via @fontsource.
2. App shell:
   - 64px→220px icon sidebar with all 9 routes
   - top bar: project name, revision switcher, verifier pill, Allocate button, Inject Rev B button,
     ⌘K palette (cmdk) with navigation + actions
   - resizable main area + right Inspector drawer
   - sonner toasts, skeleton loaders
3. Use ONLY the frozen contract: types from frontend/src/api/types.ts and the fixtures in
   frontend/src/mock/ (created in P0). Do not invent new shapes; if a field is missing, add it to
   backend/app/schemas.py, run `make types`, and update the fixture.
4. Cabinet Floor (hero screen):
   - cabinet tabs + F/R toggle; 4 CIOC columns × 8 baseplates × 12 slots
   - slots coloured by IO type; wired spares hatched; spare slots outlined; A = solid ring, B = dashed ring
   - cable blocks outlined with a small cable label; hover tooltip (tag, IO, cable/pair, CHARM, TB)
   - click → Inspector with all fields grouped + a "Why here?" timeline from why[]
   - filter chips (IO type, status, segregation family, group, cable search); legend; capacity bar per CIOC
   - arrow-key navigation; staggered fill animation on load
5. Add Playwright `npm run shots` (all routes, 1440×900 + 1920×1080, dark + light → /shots).
Run the visual QA loop at least 3 rounds: open every PNG, write a short critique (emptiness, alignment,
contrast, density, consistency, truncation), fix it, re-shoot. Commit.
Done when: Cabinet Floor looks like a premium industrial product in the screenshots, there are no
empty-looking areas, and other routes show proper placeholders (not blank).
```

### P3b · Mission Control (when P3 is done, before 6:00)

**Model: Sonnet 5.5**
```
Build the Mission Control screen per CLAUDE.md §10 screen 1, using the frozen contract types and the P0 fixtures:
- KPI strip; spare-compliance bars (controller × IO type) with a 10% target line
- a spares-per-cabinet table (wired spares, spare slots, empty baseplates, fill %) — the PS asks for it
- cabinet fill heat-strips; TQ-by-category donut; activity feed
- a "Proof" card with the verifier certificate
Every number links to a filtered view. Use the existing tokens and components only; no new colours.
Run the visual QA loop (2 rounds). Commit.
Done when: the screenshots look dense, aligned and complete at both resolutions.
```

---

## P4 · Integration + remaining screens (6:00–8:30)

**Model: Sonnet 5.5** — Track E
```
Implement the FastAPI routes in CLAUDE.md §9 for import, mapping, rules GET/PUT (versioned), allocate,
verify, verify-file, runs, slots/{id}/why, export/{kind}, export/all.zip. Storage: SQLite (stdlib
sqlite3, WAL mode) under projects/optislot.db for projects, runs (with certificate hashes), TQs,
decision log and revisions; ruleset versions as JSON.
On startup, auto-create and allocate a "Demo — VIT Sample" project from /data. Allocate must return
the frozen contract in backend/app/schemas.py (no shape changes without `make types`). Add API tests with FastAPI TestClient.
`make demo` builds the frontend and serves it from FastAPI. Commit.
Done when: API tests pass and `make demo` shows the real app at :8000 with the demo project loaded.
```

**Model: Sonnet 5.5** — Track U
```
Replace the mock data with TanStack Query calls to the real API, keeping the mock as an offline fallback.
Build these screens per CLAUDE.md §10:
- Import & Mapping: drop zone, mapping table with confidence chips + override dropdowns, 10-row preview,
  pre-flight summary
- Allocation Grid: virtualised, all 76 columns, column groups, frozen Tag, filters, column chooser
- TQ Center: tabs, severity, category, link to slot; the Apply button can be a stub for now
- Export: 5 file cards with counts + Download all
- Project Settings: location/area codes, domain key, capacity limits, with defaults and a
  "used defaults" warning chip when the MDB lacked a column
The verifier pill and Allocate button work for real (allocate → animate → pill updates).
Visual QA loop on every new screen. Commit.
Done when: the full flow works in the browser — upload the sample, map, allocate, see the cabinet,
open a slot's why, export the xlsx.
```

---

### P4b · CP-SAT optimiser (7:00–8:30) — Track E

**Model: Opus 5.5** · plan mode
```
Implement CLAUDE.md §4 step 5b with OR-Tools CP-SAT, as engine/optimise.py:
- Per controller domain, decide which CIOC each cable block goes to.
- Hard constraints: capacity in pair units (≥12-pair blocks take whole baseplates), reserved
  baseplates, A/B families never on one CIOC, pinned blocks fixed (needed for revisions).
- Lexicographic objective: fewest CIOCs/cabinets → IO groups together and in sequence → fewest
  moves vs the pinned baseline.
- Seed with the greedy solution; 2 s time limit per domain; deterministic (fixed seed, 1 worker
  for reproducibility of hashes).
- Then reuse the existing deterministic slot layout.
- Safety gate: adopt the CP-SAT result only if the verifier passes AND the score is better;
  otherwise keep greedy. Record which one won in the run record and in each slot's why[]
  ("CIOC chosen by CP-SAT: saves 1 CIOC").
- Settings toggle "Optimiser: Greedy | CP-SAT" (default CP-SAT) in Rules Studio.
- Tests: CP-SAT never produces a verifier failure (Hypothesis over random mixes); never worse than
  greedy; on the sample, report both scores.
- Benchmark on a 10k synthetic MDB (if the generator isn't built yet, write a quick one-off); the
  whole allocate stays < 3 s, else shrink the time limit.
Commit.
Done when: tests pass, the run record shows "greedy score vs CP-SAT score", and disabling CP-SAT still
gives a valid allocation.
```

## P5 · Revisions + Inject Rev B Gauntlet (8:30–11:00)

**Model: Opus 5.5** · plan mode
```
Implement CLAUDE.md §7.
1. engine/revise.py: load the Rev A allocation state, diff the Rev B MDB, then:
   - pin (freeze) unchanged signals — but freezing never blocks a new hard rule: a pinned signal that
     now violates a hard rule moves, with a reason
   - new signals use their cable's wired spares first; every move carries a `reason`
   - free deleted slots (Wired Spare vs Spare Slot logic)
   - modified hardware → swap CHARM/TB in place
   - new tag on a placed cable → its own pair slot
   - new cables → the normal engine, for unpinned items only
   Fill Revision No / Old Tag / Change Type / Remarks.
   Impact = added / deleted / modified / moved / cabinets touched + a computed stability %.
2. scripts/make_revb.py and POST /revisions/gauntlet: build the deterministic scenario from §7
   (1 delete, 1 DO→XYV hardware swap, 1 new tag on a spare pair, 1 new 12-pair cable, 1 corrupt DO
   'UZV' row, 1 row missing its pair) against the currently loaded project, then run the revision.
   Also support POST /revisions with an uploaded Rev B file.
3. Revision_Impact.xlsx export.
4. Tests: gauntlet → 0 violations; exactly the expected TQs; no unchanged signal moved; the swapped DO
   keeps its slot with SE4302T02/SE4502; the new pair lands on the right former spare.
5. UI:
   - Revision Diff screen (stability gauge, added/deleted/modified/moved cards, from→to list,
     cabinets-touched mini-map)
   - "Inject Rev B" top-bar button → runs the gauntlet → toast → navigates to Revision Diff; changed
     slots pulse on Cabinet Floor
   - revision switcher (Rev A / Rev B); diff highlighting in the Allocation Grid
Visual QA loop. Commit.
Done when: tests pass, and clicking Inject Rev B gives a clean story in under 3 seconds — what changed,
what didn't move, which TQs appeared, and still 0 violations.
```

---

## P6 · Sandbox + TQ Apply + Why-here + BOM + Rules Studio (11:00–13:30)

**Model: Opus 5.5** — sandbox + TQ apply (logic-heavy)
```
Implement the What-if Sandbox and TQ Apply per CLAUDE.md §5, §9 and §10 screens 5 and 7.
1. POST /whatif accepts {moves:[{from,to}] | rule_toggles | param_changes} and returns the proposed
   allocation diff, verifier result, moves count and capacity delta WITHOUT committing.
   POST /commit and /undo keep an undo/redo stack.
2. A move of a single slot must respect cable contiguity: offer "move whole cable block" when the
   slot belongs to a multi-pair cable. Moves that break hard rules are returned with the violation
   reasons, and the UI shows them in red.
3. Cabinet Floor "Sandbox" mode (amber banner):
   - click a slot/block → valid targets highlight green, invalid ones red with a reason tooltip
   - click a target → ghost preview + live verifier result + moves count
   - a side panel with rule toggles and wired-spare % / future-spare % sliders → instant impact
     preview (cabinets needed, fill %, violations, moves) → Commit / Discard
4. POST /tqs/{id}/apply: apply the TQ's rule patch to the ruleset → re-allocate (revision-style, pinned,
   so nothing else moves) → append to the decision log → close the TQ. In the UI the Apply button shows
   the patch preview first; after applying, the affected slot flashes and the pill stays at 0 violations.
Tests for whatif, commit/undo and tq apply. Visual QA loop. Commit.
Done when: you can demo — try moving a B cable into an A CIOC (blocked with the reason), slide
wired spare to 15% (see the impact, then discard), apply the UZV TQ (hardware updates, TQ closes, log entry).
```

**Model: Sonnet 5.5** — Rules Studio + BOM + Why-here polish
```
Build Rules Studio per CLAUDE.md §10 screen 3:
- rule cards with toggle / params / hard-soft / reorder
- editable hardware-map and naming-pattern tables with validation
- rule-set switcher (save as / duplicate / load); a live re-allocate counter
- decision-log panel
- "Describe a rule in English": schema-locked (AI drafts, never places). Provider chain:
  Claude API (if ANTHROPIC_API_KEY is set and reachable) → local Ollama (if running) → a deterministic
  phrase parser for ~10 templates ("never put X and Y on the same CIOC",
  "reserve baseplate N for …", "wired spare N%", "instrument type X uses isolated DO", …).
  Always show the generated JSON + a diff before adding. Show an "AI offline — templates" badge
  when there is no API. Show which provider answered. Reject any output that fails the rule's pydantic
  schema.
Also: Export & Proof page — the run certificate with hashes, a "Verify a file" drop zone (upload any
xlsx → certificate or a failure list with rows), and run history.
Also: a Capacity/BOM card on Mission Control + the BOM export; make the Inspector's "Why here?"
timeline readable (rule chip + one-line reason per step).
Visual QA loop. Commit.
Done when: a new rule added in the UI changes the allocation with zero code edits, and the screenshots are clean.
```

### ✅ GATE B (13:30) — FEATURE FREEZE
From here on: no new features, only robustness, polish and the demo.
- [ ] The full demo flow runs end to end without touching code
- [ ] Inject Rev B works; TQ Apply works; the sandbox works
- [ ] All 5 exports download and open
- [ ] Spares per cabinet shown (Mission Control + BOM)
- [ ] An MDB with the room/area columns deleted still allocates fully (defaults + one TQ)
- [ ] **Semifinal promises checklist** (the judges saw these on our deck):
  - [ ] CP-SAT picks the CIOC per cable block (greedy fallback)
  - [ ] Independent checker; a tampered copy fails
  - [ ] Rev B moves only what changed; every move has a reason; freezing never blocks a hard rule
  - [ ] Rules editable live + in plain English; effect shown before applying
  - [ ] Any IO MDB, zero code; bad rows quarantined; never crashes
  - [ ] TQs name rows, rules, fix options and what stays unchanged; candidate causes labelled
  - [ ] Every run hashed and reproducible; SQLite + versioned rules
  - [ ] Scoreboard: 100% allocated · 0 violations · open TQs · % untouched
  - [ ] 10k+ run time measured live

---

## P7 · Hidden-test drills + 10k stress (13:30–15:30)

**Model: Opus 5.5**
```
We will be judged on an unseen IO MDB plus a revision. Harden everything.
1. scripts/make_synthetic.py --n {N} --nasty --seed {S}:
   - renamed/reordered columns, extra junk columns, blank and comment rows
   - mixed-case IO types, unknown IO types, unknown DO instrument types
   - A+B on one cable; pair numbers above cable size; duplicate cable+pair; missing pairs
   - new rooms/areas; 2/6/12/24-pair and triad cables; files with the room/area columns removed
   Also generate a matching Rev B.
2. Drill: for seeds 1..5 and N in {190, 2000, 10000}, run import → allocate → verify the exported
   file → revise. Record crashes, violations, untracked tags and runtime in docs/drill_report.md.
3. Fix every crash and every violation at the root cause. Rule: bad data becomes a TQ, never an
   exception. Performance target: 10k signals allocate + verify in < 3 s.
4. Add a "Stress test 10k" action (⌘K + Mission Control) that generates, allocates and shows timing.
5. Re-run until the drill report is all green. Commit.
Done when: docs/drill_report.md shows 0 crashes, 0 violations, 0 untracked tags on every run, and
10k < 3 s.
```

## P8a · Design polish pass (13:30–15:30, parallel)

**Model: Opus 5.5**
```
Act as a senior product designer reviewing this app for a hackathon final, where judges decide in
30 seconds. Run `npm run shots`, open every screenshot, and write a ruthless critique in
docs/ui_review.md:
- hierarchy, density, empty-looking regions, alignment, inconsistent spacing or colours
- weak typography, truncated text, chart readability, dark/light parity, hover/focus states
Then fix the top 15 issues. Rules:
- keep CLAUDE.md tokens; make the Cabinet Floor the visual centrepiece
- the verifier pill and stability gauge must be instantly readable from 3 metres (projector)
Re-shoot and repeat once. Commit.
Done when: the second critique has no high-severity items.
```

## P8b · Offline cold-start drill (15:30–16:30)

**Model: Sonnet 5.5**
```
Simulate the venue. With network access disabled (or by checking for any external URL):
1. grep the frontend build and backend for http(s):// requests to external hosts; remove or inline them.
2. Fresh clone into a temp dir → follow the README from zero → `make demo` must work. Fix anything
   missing (lockfiles, pinned versions, vendored fonts).
3. Kill and restart the server mid-demo: the project state must reload from disk.
4. Verify the English-to-rule box falls back to templates with the "AI offline" badge.
Commit.
Done when: a cold start from a fresh clone reaches the loaded demo in one command, with no network calls.
```
Then do it for real: **turn Wi-Fi off and run the whole demo once.**
Then **record a 3-minute backup demo video** of the full demo flow (screen recording, 1080p, with voice-over). Keep it on two laptops and a USB stick, and play it if anything fails on stage.

## P9 · README, demo script, pitch (16:30–17:15)

**Model: Sonnet 5.5**
```
Write:
1. README.md: problem, solution, architecture diagram (mermaid), how to run (make demo), rule
   engine explanation, verifier explanation, the revision algorithm, tech stack + declared AI usage
   (Claude Code for development; optional Claude API for English-to-rule), drill results, screenshots
   from /shots.
2. docs/demo_script.md: the 5-minute demo in the order below, with exact clicks and talking points.
3. docs/pitch.md: a 5-slide outline that follows our semifinal OptiSlot deck (team Brownie;
   problem → solution → proof → revision → impact/scale/market) plus one slide titled "Promised in
   semis → delivered today" mapping each deck promise to the live feature. Include speaker notes and
   the numbers pulled from the real app (signals, runtime, CP-SAT savings, stability %, TQs found,
   run hash). Keep the deck's market/business slide, but mark any market figures as needing a source
   check.
4. docs/judge_qa.md: likely judge questions with crisp answers.
Commit and tag v1.0.
```

---

## 🎬 5-minute demo flow (rehearse twice)
1. **Problem (30 s):** "10,000 signals, hand-placed in Excel, redone every revision."
2. **Import (30 s):** drop the MDB → columns auto-mapped → **pre-flight finds TQs before we start** (including the missing-tag trap and the A/B cable conflict).
3. **Allocate + Dive (50 s):** one click → the camera dives from the plant into cabinet 1 while cables drop into their baseplates → glide ←/→ through every cabinet, flip front/rear → the scoreboard reads **100% allocated · 0 violations · N open TQs**. Mention "CP-SAT chose the CIOCs, saving X CIOCs vs greedy" (use the real number).
4. **Why here? (20 s):** click a slot → the rule trace.
5. **Sandbox (50 s):**
   - try moving a B cable onto an A CIOC → **blocked, with the reason**
   - slide wired spare to 15% → impact preview → discard
6. **TQ Apply (30 s):** unknown DO 'UZV' → Apply isolated+fused → hardware updates, nothing else moves, decision logged.
7. **Inject Rev B (50 s):** delete, hardware swap, new pair, new cable and corrupt rows → **stability ~9x%**, minimal moves, the new TQs, still 0 violations.
8. **Export + tamper (40 s):** open the xlsx — identical to their template, full physical grid. Change one CHARM in Excel, save it, drop it into "Verify a file" → **FAIL, row N**. "We don't ask you to trust us — the checker proves it." Show the run hash.
9. **Scale (20 s):** Stress test 10k → done in about 2 s.
10. **Close (10 s):** "OptiSlot — Allocate. Prove. Revise. Everything we promised in the semifinal, running live."

## 🧑‍⚖️ Judge Q&A cheat-sheet
- **"Is it hard-coded to the sample?"** → Run a synthetic MDB live, or switch a rule off and show the allocation change.
- **"How do you know it's correct?"** → The independent verifier re-reads the exported Excel, not the engine's memory.
- **"Why CP-SAT and not just greedy (or the reverse)?"** → Greedy guarantees a valid answer instantly. CP-SAT only chooses the CIOC per cable block (a small, fast problem) and is adopted only if the verifier passes and it scores better. The slot layout stays deterministic and explainable.
- **"Is the AI making placement decisions?"** → No. AI drafts rules and TQ wording, schema-locked. Placement is deterministic plus CP-SAT, and verified independently.
- **"Where's the AI?"** → Rules from plain English (when online). An AI-assisted TQ engine that catches data conflicts and proposes machine-applicable fixes. Built with Claude Code.
- **"What about IRC/MCC signals?"** → Out of scope per the guide. The architecture allows a new rule type without a rewrite.

---

## 🛟 Rescue prompts

**Model: Opus 5.5** — something is broken and you don't know why
```
Stop adding features. Reproduce the bug with a failing test first, find the root cause, fix it,
and show me the test passing. Bug: <describe what you clicked/ran and what happened>.
Don't change unrelated files.
```

**Model: Opus 5.5** — the verifier reports violations
```
Run the verifier on the latest export and list every violation grouped by check. For each group,
decide whether the engine or the verifier is wrong, citing CLAUDE.md. Fix the root cause, add a
regression test, and re-run until 0 violations.
```

**Model: Opus 5.5** — the UI looks empty or cheap
```
Run `npm run shots` and open the screenshots of <route>. List everything that looks empty, generic
or misaligned compared with CLAUDE.md §10. Fill the empty areas with real data-driven content
(not filler), tighten the spacing, strengthen the hierarchy. Re-shoot and compare before/after.
```

**Model: Sonnet 5.5** — merge conflict between tracks
```
Resolve the merge conflicts on this branch. The engine/API contract in backend/app/schemas.py is the
source of truth; adapt the frontend types to it. Run `make test` and `npm run build`, then fix until both pass.
```

**Model: Sonnet 5.5** — behind schedule
```
We are behind. Read docs/PROMPT_BOOK.md "Cut list". Tell me what to cut to finish by <time>,
hide the unfinished features cleanly behind a flag (no broken buttons on screen), and make sure the
demo flow still works end to end.
```

**Model: Opus 5.5** — performance too slow
```
Profile allocate + verify on the 10k synthetic MDB. Show the top hotspots, optimise them
(no algorithm change that alters results), and prove identical output before/after with a test.
Target < 3 s.
```
