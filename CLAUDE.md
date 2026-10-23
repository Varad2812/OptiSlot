# OptiSlot — IO Signal Sudoku (Project Brief · read before every task)

Hackathon finals · Emerson track · Problem Statement #02 · 18-hour build.
**OptiSlot** — *Allocate. Prove. Revise.* (same name and promises as our semifinal deck — team Brownie)
Prompts live in `docs/PROMPT_BOOK.md`. This file is the single source of truth for domain rules, architecture and UI.

## 0. Judging criteria (Definition of Done) — never break these
1. **100% allocated**: every live signal has a slot, OR a TQ explaining exactly why not.
2. **Zero violations** of the enabled rules, proven by an INDEPENDENT verifier.
3. **Right hardware**: correct CHARM, terminal block and names.
4. **Revision-friendly**: Rev B keeps unchanged signals in the same slot (fewest moves).
5. **Flexible**: a new rule or a new IO MDB needs NO code change (rules are data; columns are auto-mapped).
6. **No hand-editing**: the tool produces every output end-to-end.
7. **Hidden test**: an unseen IO MDB + a revision. Robustness beats features. Never crash on bad input — turn it into a TQ.
8. **Keep the semifinal promises** (judges saw our OptiSlot deck):
   - CP-SAT picks the CIOC per cable block, with greedy as the safe fallback
   - an independent checker that re-reads the exported Excel — **a tampered copy fails**
   - Rev B moves only what changed, and every move has a reason
   - rules are editable live or in plain English
   - any IO MDB with zero code; bad rows quarantined, never a crash
   - TQs that name the clash
   - every run hashed (reproducible)
   - 10k+ run time measured live on stage
9. **Offline venue**: no CDN fonts or scripts; all dependencies installed locally; AI features are optional and must degrade gracefully.

## 1. Data (`/data`)
- `Sample_IO_MDB_VIT_v2_1.xlsx`: INPUT. Sheet `MDB-1`, header row 1, 190 rows × 143 cols.
- `Blank_IO_Allocation_Template.xlsx`: OUTPUT FORMAT. Sheet `IO Assignment`, 76 columns A..BX.
  - Header row 1: fill `#1F3864`, bold, height 42.
  - Data rows: thin borders, height 15; only rows 2..237 are pre-formatted.
  - Autofilter `A1:BX237`.
- `Sample_IO_Allocation_VIT_v2_1.xlsx`: reference answer. 1152 rows = 3 cabinets × 4 CIOC × 8 BP × 12 ch. Freeze pane `D2`. Rows ordered cabinet → CIOC → baseplate → channel. Used as a regression oracle.
- `IO_Allocation_Fundamentals...docx`: domain guide.

## 2. Domain model
```
System cabinet ── Controller (software assignment of CIOCs)
Marshalling cabinet ─ max 4 CIOC ─ 8 baseplates/CIOC ─ 12 channels/BP = 32 BP, 384 slots
1 cable pair = 1 signal = 1 CHARM slot
CHARM_No = (baseplate-1)*12 + channel   (1..96 per CIOC)
CIOC 1,2 of a cabinet → side "F";  CIOC 3,4 → side "R"
```
Tag Status:
- `Field`: real signal.
- `Wired Spare`: an unused pair of a placed cable, wired, with the functional CHARM+TB for a defined IO type and a spare tag name.
- `Spare Slot`: no cable. Tag `-`, CHARM `SE6103` "CHARM PROTECTION COVER", TB `SE4501` "Standard CHARM Terminal Block", TB terminals `-`.
- `Cabinet Alarm`: internal signals (cable `Internal Wiring`, or equipment = a cabinet) go to **baseplate 1 of CIOC 1 of each marshalling cabinet** (configurable rule).

**Output = the FULL physical grid**: every slot (all 384) of every instantiated cabinet gets a row, in physical order. Spare Slots included. (The reference: 177 Field + 22 Wired Spare + 12 Cabinet Alarm + 941 Spare Slot = 1152.)

## 3. Input normalisation (learned from the reference; every map is editable config)
- Tag key = original tag with all whitespace removed. Output keeps the original spelling.
- Status `DELETED` → not allocated.
- IO type map: `AI→AIR, AO→AOR, DI→DIR, DO→DOR` (R forms pass through). An IO type that still doesn't map → excluded + TQ.
- Cable size parsed from the `Multi-cable / Cable` text: `24PX`→24, `12PX`→12, `06PX`→6, `2PX`→2, `1TX` (triad)→1. Pair parsed from `Pair N` / `Triad N`.
- Room → location prefix: `PIB-30`→`P30`. Design area → area: `RA 320-01`→`32001`, compressed `3201`.
- DSTName = tag key without dashes + `_`.
- The column mapper uses rapidfuzz + a synonyms table (e.g. `Tag Number`/`TagNo`/`Tag`, `I/O Type Name`/`IO Type`, `Multipair Cable No.`/`Cable No`, `Pair Number`/`Pair`, `IO Grouping`/`Segregation`/`Group`). Show a confidence score; the user can override the mapping.

### Project Settings (hidden-test safety net)
Editable in the UI and stored per project, with defaults so that missing data never blocks allocation:
- location prefix (default derived from the room, else `P01`) and area code (from the design area, else `10001`)
- controller-domain key: which columns split domains (default: room + area; fallback: one domain)
- max CIOCs per cabinet (4), baseplates per CIOC (8), channels per baseplate (12)
- max cabinets per controller (1 in the sample)
If a column is missing, use the default and raise **one** project-level TQ ("Area code not in MDB — using 10001, confirm"), never one TQ per row.

### Hardware map (default rule; editable table in the UI)
| IO | Condition | CHARM | TB |
|---|---|---|---|
| AIR | Signal Type = RTD | SE4303T03 RTD Input Charm | SE4501 Standard |
| AIR | else | SE4303T01 AI 4-20 mA HART | SE4501 |
| AOR | – | SE4304T01 AO 4-20 mA HART | SE4501 |
| DIR | – | SE4301T02 DI 24 VDC dry contact, low-side sense | SE4501 |
| DOR | Instrument Type ∈ high_current list (default `XYV, ZYV` + horn/beacon/sounder codes the user adds) | SE4302T02 DO 24 VDC Isolated | SE4502 Fused-Injected-Power |
| DOR | known normal list (`XA, ZLO, MHL, MXA, MXL, QAX`) | SE4302T01 DO 24 VDC High Side | SE4501 |
| DOR | **unknown instrument type** | default SE4302T01 + **TQ** ("confirm load/inrush") — still allocated | SE4501 |
Exact description strings come from `backend/catalog.json`, which is extracted from the reference workbook.
Known conflict to surface as a TQ: the PS says horns/beacons/sounders need isolated+fused DO; the sample uses standard DO for some alarm-type outputs.
Known trap: `440-PI-20077-L` (New, AO) is in the MDB but absent from the reference answer. The verifier must catch any missing tag.

### Naming patterns (user-editable token strings)
| Item | Pattern | Example |
|---|---|---|
| System cabinet | `{loc}-DCS-{area}-{seq2}` | P30-DCS-32001-01 |
| Controller | `{loc}DPK{area4}{seq2}` | P30DPK320101 |
| Marshalling cabinet | `{loc}-DCM-{area}-{seq2}` | P30-DCM-32001-01 |
| CIOC (seq global per area) | `{loc}DCIOC{area4}{seq3}` | P30DCIOC3201013 |
| Baseplate | `{cioc3}-CBP-{bp}` | 013-CBP-6 |
| Wired spare tag | `{area4}DSP{ctrl2}{cioc3}{bp}{ch}` | 3201DSP0201369 |
| Visualization | `{dcm}({side})` | P30-DCM-32001-04(F) |

## 4. Allocation engine (`backend/engine`) — pure, deterministic, explainable
1. **Pre-flight** → TQs:
   - missing cable/pair, duplicate cable+pair, pair > cable size;
   - unknown IO type (excluded); unknown DO type (allocated + TQ);
   - **A-family and B-family on the same cable**: unsatisfiable. Raise a TQ that names the clash ("rule A/B vs rule cable-together, rows 45–68; fix: re-tag or split the cable; everything else unchanged"). Place the cable on an A CIOC and flag it as a known, TQ-covered exception; the verifier reports it as "excepted by TQ", not as a silent pass;
   - unmapped room/area; and more.
2. **Partition** by controller domain (room + area). Overflow → open the next cabinet/controller via the naming sequence; if capped by config → capacity TQ.
3. **Reserve**: cabinet-alarm baseplate; future-spare baseplates at the END of each cabinet (`future_spare_pct`, default 10% ≈ 3–4 of 32 BPs).
4. **Sort cable blocks**:
   - by segregation family (A = A, A-CONTROL; B = B, B-ALARM; neutral = rest);
   - then IO Grouping (keep the group sequence);
   - then cable size descending within the group;
   - then cable number.
   Never sort purely by size (that breaks "groups together, in sequence").
5. **Place** first-fit:
   - Cables ≥12 pairs start at channel 1 and take ceil(n/12) consecutive baseplates (a 24-pair takes 2 BPs).
   - Cables <12 pairs pack inside one baseplate and never cross a boundary.
   - A CIOC never holds both A- and B-family signals.
   - The same IO Grouping stays in the same cabinet, consecutively.
   - **No defragmentation / no moving already-placed cables** (moves = rewiring). If nothing fits → next CIOC/cabinet, or a TQ.
5b. **Optimise (CP-SAT, OR-Tools)**:
   - Decision: which CIOC each cable block goes to (small, decomposed per controller domain).
   - Hard constraints: capacity in pair units, A/B never on one CIOC, reserved BPs, pinned blocks (revisions).
   - Objective (lexicographic): fewest CIOCs/cabinets → groups kept together and in sequence → fewest moves vs the pinned baseline.
   - Time limit 2 s per domain, seeded with the greedy solution. The exact slot layout is then deterministic.
   - **Safety**: adopt the CP-SAT result only if the verifier passes AND it scores better; otherwise keep greedy. Greedy alone must always produce a valid answer.
   - Capacity property: block sizes 1/2/6/12/24 each divide the next, so if a CIOC's free pair capacity ≥ the sum of its blocks' sizes (with ≥12-pair blocks taking whole BPs), the exact layout always fits. Prove it with a Hypothesis property test over random cable mixes.
6. **Fill slots**: a used pair → Field; an unused pair in a placed cable → candidate; a slot with no cable → Spare Slot.
7. **Wired spares**: per controller, per IO type, target = ceil(`wired_spare_pct` × field count), default 10%. Convert candidates using the cable's dominant IO type and its CHARM/TB; the remaining candidates become Spare Slot. Shortfall → TQ.
8. **Names** from the patterns. **Trace**: each slot stores `why[]` (the rules and decisions that put it there).
9. Performance target: 10,000 signals in < 3 s.

### TQ object (every TQ, same shape)
`{id, category, severity, status: open|applied|closed, confidence: confirmed|candidate, rows[], tags[], rules_in_conflict[], message, fix_options[{label, rule_patch|data_patch}], unchanged_note}`
A cause that isn't proven is labelled **candidate**. Bad rows are **quarantined** (kept in a Quarantine list, shown in the UI and the TQ register), never silently dropped.

## 5. Rules are DATA (`rulesets/*.json`)
```json
{"id":"r-ab","type":"segregate","enabled":true,"severity":"hard",
 "params":{"level":"cioc","families":{"A":["A","A-CONTROL"],"B":["B","B-ALARM"]}},
 "label":"Never put A and B on the same CIOC"}
```
Types (each one has a placement hook AND a verifier check):
`capacity, cable_contiguous, group_together, segregate, reserve_baseplate, wired_spare_pct, future_spare_pct, hardware_map, io_type_map, naming_pattern, custom_expr`.
`custom_expr` is a safe mini-language (no `eval`) over row fields, e.g. `io_type=="DOR" and instrument_type in ["UZV"] -> charm="SE4302T02", tb="SE4502"`.
Rule sets can be saved, loaded and duplicated per project. Every change re-runs allocate + verify.
**Decision log**: every rule change (manual or via a TQ Apply) is appended with time, who/why and the TQ id.

## 6. Verifier (`backend/verify`) — knows NOTHING about the engine
Inputs: **output rows + normalised MDB + rule set**. Checks:
- every live MDB tag appears exactly once (catches missing/duplicated tags);
- no duplicate (CIOC, BP, ch); no duplicate (cable, pair);
- the CHARM_No formula; the BP prefix = CIOC seq; capacity;
- cable pairs contiguous and in order;
- A/B never on one CIOC; group-together;
- hardware matches the map; names match the patterns;
- wired spare % per IO type per controller; future spare BPs present;
- full grid present (384 rows per cabinet); Tag Status discipline.
**Verify any file**: `POST /verify-file` accepts any allocation xlsx (ours, or a hand-edited copy). Demo: edit one CHARM in the exported file in Excel, upload it → FAIL, with the exact row and check.
**Run certificate**: sha256 of the input MDB(s) + ruleset version hash + output file hash + engine version + timestamp, shown on the certificate and stored in run history. The same inputs give the same hash and the same output (reproducible).
Output: `RuleCheckReport` (per-check pass/fail counts + violating rows). UI certificate: **"0 violations · N/N checks"**. Also run it on the reference workbook as a sanity check.

## 7. Revisions
- Load Rev A (our previous output or allocation state) → map tag → slot. Diff Rev B against the MDB.
- **Unchanged** → pinned (frozen) to the same slot. **Freezing never blocks a new hard rule**: if a pinned signal now violates a hard rule, it moves, with a reason.
- New signals use the cable's **wired spares first**. Every move in the impact report carries a `reason`.
- **Deleted** → slot freed: Wired Spare if its cable remains and the spare target needs it, else Spare Slot. `Change Type`=Deleted.
- **Modified hardware** (e.g. DO → solenoid) → same slot, CHARM/TB swapped (SE4302T01→T02, SE4501→SE4502). Cable/pair changed → move + TQ.
- **New on a placed cable** → lands on its own pair position (a former spare). **New cable** → a free block via the normal engine (only for unpinned items).
- Fill `Revision No`, `Old Tag`, `Change Type`, `Remarks`.
- Impact: added / deleted / modified / moved / cabinets touched; **stability = unchanged-in-place ÷ previous live signals** (computed, never hard-coded).
- **Revision Gauntlet** (`scripts/make_revb.py` + the UI's "Inject Revision B" button) is a deterministic scenario on the loaded project:
  1. delete 1 tag;
  2. change 1 standard DO to instrument type XYV (hardware swap in place);
  3. add 1 tag on a spare pair of an existing cable;
  4. add 1 new 12-pair cable;
  5. add 1 corrupt row (DO with instrument type `UZV`);
  6. add 1 row missing its pair.
  Expected: 0 violations, the correct TQs, only the minimal moves. There is also an "Upload your own Rev B" path.

## 8. Outputs (Export page — real files)
1. `IO_Allocation_<proj>_<rev>.xlsx`:
   - write with **openpyxl into a copy of the blank template** (never `DataFrame.to_excel`); all 76 columns, `-` for N/A, exactly like the reference;
   - for rows beyond 237, copy the style of row 2 (borders, font, height 15);
   - set the autofilter to `A1:BX{last}` and the freeze pane to `D2`.
2. `Rule_Check_Report.xlsx`
3. `TQ_Register.xlsx` (TQ no, severity, category, tag, field, issue, suggested resolution, status, decision)
4. `Revision_Impact.xlsx`
5. `Capacity_BOM.xlsx`:
   - cabinets, CIOCs, BPs, count per CHARM/TB part no., fill %, headroom
   - spares per IO type per controller
   - **spares per cabinet** (free slots, wired spares, spare slots, empty baseplates) — the PS asks for this explicitly
Plus "Download all (.zip)".

## 9. Stack (final)
**Backend**:
- Python 3.11 managed with **uv** (lockfile; `uv run`)
- FastAPI, Pydantic v2, openpyxl, pandas (read only), rapidfuzz, **OR-Tools (CP-SAT)**, uvicorn
- pytest + **Hypothesis** (property and fuzz tests)
**Storage**:
- **SQLite (WAL, stdlib sqlite3)** for projects, runs (with hashes), TQs, decision log and revisions
- rulesets as **versioned JSON** (each save = a new version id)
**Frontend**:
- React 18 + Vite + TypeScript, Tailwind, shadcn/ui (Radix), lucide-react
- TanStack Query (server state), zustand (UI state)
- TanStack Table + @tanstack/react-virtual (grid), Recharts
- framer-motion, sonner, cmdk, react-resizable-panels
- @fontsource/inter + @fontsource/jetbrains-mono
**QA**: Playwright screenshot script `npm run shots`.
**Run**:
- `make dev` = backend :8000 + Vite :5173 (proxy `/api`).
- `make demo` = build the frontend; FastAPI serves `dist/` at :8000 (one process, offline-safe).
- The demo project auto-loads on first start.
**AI (optional, schema-locked — AI drafts, never places)**:
- "Describe a rule in English" uses a provider chain: Claude API (if `ANTHROPIC_API_KEY` is set and online) → local **Ollama** (if running with a pre-pulled model) → a deterministic phrase parser (~10 templates).
- Output must validate against the rule's pydantic schema, or it is rejected.
- The UI shows which provider answered, e.g. "AI offline — using rule templates".
- AI may also draft TQ wording. It never decides a slot.
**Stretch only**: dnd-kit drag-and-drop in the sandbox; Docker Compose.

**API contract** (frozen in P0, before the tracks split):
- `backend/app/schemas.py` (pydantic) is the source of truth.
- TypeScript types are generated from FastAPI's OpenAPI with `openapi-typescript` into `frontend/src/api/types.ts`; re-run `make types` after any schema change.
- `frontend/src/mock/*.json` fixtures must validate against the schemas (a test checks this).

API:
- `POST /api/verify-file` (any xlsx → certificate or failures); `GET .../runs` (history with hashes)
- `POST /api/projects/{id}/import`, `POST .../mapping`
- `GET|PUT .../rules`
- `POST .../allocate`, `POST .../verify`
- `POST .../whatif` (moves, rule toggles, param changes → diff + violations, no commit), `POST .../commit`, `POST .../undo`
- `POST .../tqs/{tq}/apply`
- `POST .../revisions` (upload Rev B), `POST .../revisions/gauntlet`
- `GET .../slots/{slotId}/why`, `GET .../export/{kind}`, `GET .../export/all.zip`
- `POST .../stress?n=10000`

## 10. UI/UX — "OptiSlot Control Room" (NON-NEGOTIABLE)
The concept: a classy industrial control room. Calm, precise, full of real data, with cinematic motion that *explains* something (where signals went, what changed, what was checked). Nothing moves without a reason. **Never empty**: the demo project is preloaded, and every panel shows real data from the API (fixtures as the offline fallback).

### 10.1 Colour and type (classy: ink graphite + violet, warm-neutral text)
**Tokens** (CSS vars; dark default, light theme via one key `T`):
- **Dark surfaces**: bg `#0A0D13`, bg-grad `radial-gradient(1200px 600px at 70% -10%, #1B1640 0%, transparent 60%)`, surface `#10141C`, raised `#151A24`, glass `rgba(21,26,36,.72)` + `backdrop-blur(12px)`, border `#222A38`, hairline `rgba(255,255,255,.06)`
- **Dark text**: text `#ECEEF3`, muted `#8C95A8`
- **Dark brand**: brand `#7C5CFF` (the deck's violet), brand-2 `#22D3EE` (a cyan used ONLY for live/motion highlights: scan beams, focus rings, live dots), ok `#34D399`, warn `#FBBF24`, err `#F87171`
- **Light**: bg `#F6F7FB`, surface `#FFFFFF`, raised `#F1F3F8`, border `#E3E7EF`, text `#0F1422`, muted `#5B6478`, same brand colours
**IO colours** (harmonised; used identically in the cabinet, charts, chips and legend):
- AI `#4F8CFF` · AO `#A78BFA` · DI `#34D399` · DO-std `#FBBF24` · DO-iso+fuse `#F87171` · Cabinet Alarm `#F472B6`
- Wired Spare = the IO colour at 30% + a 45° hatch; Spare Slot = outline `#2A3242` only; empty/reserved baseplate = a dashed outline
- Segregation: A = solid 2px ring, B = dashed 2px ring
**Type**: Inter (UI 13px; numbers tabular-nums), Inter 600 for titles (page 22px, card 14px uppercase-tracked labels 11px/0.08em), JetBrains Mono for tags and addresses. 8px grid, radius 10 (cards) / 6 (chips). Depth via hairline borders, inner highlights and a soft glow on the active element — not heavy shadows.

### 10.2 Shell (same on every screen)
- **Top bar**:
  - left: OptiSlot logo + project + revision switcher;
  - centre: the **Flow Rail** ① Upload → ② Rules → ③ Allocate → ④ Verify → ⑤ Revise → ⑥ Export. Steps light green when done, the current step glows, and clicking a step navigates;
  - right: ⌘K, theme toggle, a "Motion: Cinematic / Calm" toggle.
- **Scoreboard strip** under the top bar: **100% allocated · 0 violations · N open TQs · X% untouched · cabinets · CIOCs · fill %**. Numbers tick (count-up) on change; a violation turns its tile red with a single pulse.
- **Left sidebar**: 64px icons → 220px on hover. Screens: Mission Control, Cabinet Explorer, Try-out Lab, Proof Center, Revision Center | Import, Rules Studio, TQ Center, Allocation Grid, Export.
- **Right Inspector** drawer: full row + the "Why here?" timeline. Opens from any slot or row, anywhere.
- **Keys**: ⌘K, `A` allocate, `V` verify, `/` find tag, ←/→ previous/next cabinet, `F` flip front/rear, `Esc` back out one zoom level.

### 10.3 The "World" — one cabinet engine, used everywhere
A single `<CabinetWorld>` component renders the plant in **2.5D SVG** with a **camera** (`{x, y, scale}` animated by framer-motion springs; transform-only, so it runs at 60 fps). Semantic zoom levels:
1. **Plant**: all cabinets in a row on a subtle floor grid (like walking down the marshalling room). Each shows a low-detail fill heat-map (canvas or simplified rects).
2. **Cabinet**: front or rear elevation. 2 CIOC columns per side × 8 baseplates × 12 slots, CIOC headers with a capacity bar, cable blocks outlined and labelled.
3. **CIOC/Baseplate**: slots large enough to show the tag in mono text, CHARM and TB.
4. **Slot**: opens the Inspector.
Level of detail: render full detail only for the visible cabinet ± 1. Memoised slot rects. Must stay smooth at 10k signals (~27 cabinets).

### 10.4 Signature motion moments (framer-motion; skippable; "Calm" mode shortens to fades)
1. **Upload Dive** (the hero moment):
   - the drop zone accepts the MDB → the file card shrinks into a glowing dot;
   - the column-mapping chips fly into place (stagger 30 ms) → pre-flight results tick in;
   - on Allocate (or straight away with the demo file), the screen **cross-fades into the World at Plant level**, empty cabinets fade up left→right;
   - the camera **dives into cabinet 1** (spring zoom, ~1.2 s), and cables **drop into their baseplates like falling blocks**, staggered by cable, with a soft settle and the counters rolling up;
   - total ≤ 4 s; any key skips to the end state.
2. **Cabinet-to-cabinet glide**:
   - ←/→, minimap click or swipe → the camera **pans along the row** to the next cabinet with slight parallax (floor grid moves slower than the cabinets) and a zoom-out-pan-zoom-in arc (~700 ms);
   - the cabinet name and stats cross-fade in a header plate; `F` flips front/rear with a 3D `rotateY` card-flip (~500 ms).
3. **Verify scan**:
   - a cyan scan beam sweeps across the visible cabinet while the 20 checks tick one by one in the Proof panel (40 ms stagger);
   - the certificate **stamps** in (scale 1.15→1 with a short glow), showing the hashes.
4. **Tamper caught**: drop an edited Excel → the scan runs → the failing slot and row **pulse red** three times, and the camera flies to that slot.
5. **Rev B diff**:
   - unchanged slots stay perfectly still (that's the point);
   - deleted = fade + shrink; added = drop in; modified = flip to its new CHARM colour; moved = a curved flight path from old to new;
   - the stability gauge sweeps to its value.
6. **Try-out**:
   - the selected slot lifts (scale 1.06, glow); valid targets breathe green, invalid ones are dimmed red with a reason tooltip;
   - on click, a ghost flies along the path; a violation makes a short horizontal shake and the move is refused; a valid move settles with a spring.
7. **Micro**: hover lift on cards (y −2px), number count-ups, page transitions (fade + 8px slide, 200 ms), skeleton shimmer, toast slide-ins.
Rules: durations 150–400 ms for UI and ≤ 4 s for the hero sequences; ease `[0.22, 1, 0.36, 1]` or springs (stiffness 260, damping 30); respect `prefers-reduced-motion` and the Calm toggle; never block input.

### 10.5 Screens
1. **Mission Control** (home; looks full immediately):
   - the scoreboard;
   - a **live Plant strip** (mini World at Plant level — click a cabinet and the camera dives into the Explorer);
   - spares per cabinet table; spare compliance bars (controller × IO type with the 10% line);
   - CIOC fill heat-map; TQ preview (top 5); the proof certificate card;
   - the revision stability gauge; the activity timeline (decision log).
   Every tile is clickable.
2. **Cabinet Explorer**:
   - the full World with the minimap, cabinet tabs, front/rear flip and filter chips (IO, status, family, group, cable search);
   - a legend; a hover tooltip; click → Inspector with "Why here?";
   - a "Strategy: Balanced | Compact" chip showing the current mode.
3. **Try-out Lab**:
   - split view **Current | Proposed** (two synced Worlds) + an Impact panel (violations, moves, CIOCs, cabinets, fill %, BOM delta);
   - tools: click-to-move a slot or whole cable block; rule toggles; wired-spare % and future-spare % sliders; the balanced/compact switch;
   - **Commit / Discard**; undo/redo; an amber "Sandbox" banner.
4. **Proof Center** (the re-verify USP):
   - the certificate (input/ruleset/output hashes, engine version, time) and the 20 checks with pass counts;
   - a "Re-verify now" button; a **"Verify any Excel"** drop zone (the tampered-copy demo) with the failing rows listed and "fly to slot";
   - run history (hashes), showing that the same inputs give the same hash.
5. **Revision Center**:
   - **Inject Rev B** + "Upload your own Rev B";
   - the diff World with the animation from §10.4.5; stability gauge; added/deleted/modified/moved cards; a from→to list with reasons;
   - automatic re-verify after the revision.
6. **Import & Mapping** (where the Upload Dive starts): drop zone; mapping table with confidence chips + override; preview; pre-flight; Project Settings with a "used defaults" chip.
7. **Rules Studio**:
   - rule cards (toggle, params, hard/soft); editable hardware-map and naming tables; rule-set versions;
   - an "English → rule" box with the provider badge;
   - an "Optimiser: CP-SAT | Greedy" and "Strategy" setting; the decision log.
8. **TQ Center**: Open / Applied / Closed; each card has the rows, the conflicting rules, fix options with **Apply** (patch preview first) and "what stays unchanged"; candidate vs confirmed.
9. **Allocation Grid**: the virtualised 76-column Excel-like table, column groups, frozen Tag, filters, revision diff highlights; click a row → camera flies to its slot.
10. **Export**: 5 file cards + Download all; certificate summary.

### 10.6 Visual QA loop (MANDATORY after any UI change)
1. Run `npm run shots` (all routes, 1440×900 and 1920×1080, dark + light).
2. For the motion sequences, also capture **frames** at 0/25/50/75/100% of the Upload Dive, the cabinet glide and the Rev B diff (the Playwright script triggers them with `?demo=1`).
3. **Open and look at the PNGs.** Critique them for emptiness, alignment, contrast, density, consistency, truncation and mid-animation glitches, then fix.
4. Repeat until clean. Also check performance: the dev-tools FPS stays ~60 during the glide on the sample and stays usable at 10k signals.

## 11. Engineering rules
- Engine and verifier = pure functions with pytest. Regression test: sample MDB → 0 violations, every live tag allocated or TQ'd, full grid. Also report % address agreement with the reference (informative only).
- Hypothesis tests: the capacity property; random cable mixes → allocator + verifier never disagree; random junk rows → never an exception.
- `scripts/make_synthetic.py --n 10000 --nasty` generates a large or messy MDB (renamed/reordered columns, blank rows, unknown types, A+B on one cable, oversize pairs, duplicates).
- No project values hard-coded in engine code — everything comes from the rule set and config.
- Small commits after every working milestone. Never leave `main` broken.
