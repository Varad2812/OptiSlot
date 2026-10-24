# OptiSlot — how the frontend and backend work together

*Allocate. Prove. Revise.* This page explains the tech stack, how one click travels through the system, every file that runs and what it does, and how to **show** the backend working to a judge.

---

## 1. Tech stack (and why)

| Layer | Tech | Why it's here |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript | Fast dev/build, typed UI |
| UI kit | Tailwind CSS + shadcn/Radix primitives | Consistent dark control-room look |
| Data fetching | TanStack Query (cache, refetch), TanStack Table + Virtual (huge tables) | Every screen reads the API, large lists stay fast |
| State | zustand (`frontend/src/store/ui.ts`) | Small UI state: theme, motion mode, offline flag |
| Motion | framer-motion, CSS, custom sequencer | Page transitions, count-ups, the Upload Dive |
| 3D | three.js 0.160.1 + camera-controls 2.8.5 (bundled via npm, no CDN) | The Marshalling Room: Room → Cabinet → CIOC → Baseplate → CHARM |
| Backend | Python 3.11 + FastAPI + Pydantic v2 + uvicorn | Typed API, auto docs at `/docs` |
| Allocator | pure Python engine + OR-Tools CP-SAT (greedy is the safe fallback) | Deterministic placement; CP-SAT picks the CIOC for each cable block |
| Verifier | separate package `backend/verify/` (imports nothing from the engine) | "Prove": re-reads any exported Excel and checks every rule |
| Excel | openpyxl (write into a copy of the blank template), pandas (read) | 76-column IO Assignment output |
| Matching | rapidfuzz | Auto-map unseen column names with a confidence score |
| Storage | SQLite (WAL) at `projects/optislot.db` | Projects, the uploaded input files, ruleset versions, runs, decisions, activity |
| Optional AI | Gemini REST (or Anthropic) → deterministic fallback parser | English → rule *draft*; never places a signal |
| Tests | pytest + Hypothesis; Playwright screenshots | 664 backend tests; every route captured dark/light |

**The one contract:** `backend/app/schemas.py` (Pydantic) is the single source of truth. `make types` turns it into `frontend/src/api/types.ts`, so the two sides cannot drift apart.

---

## 2. The big picture

```
Browser (React, frontend/src/…, :8000 in demo / :5173 in dev)
   │  fetch("/api/...")  JSON over HTTP         (frontend/src/api/client.ts)
   ▼
FastAPI  backend/app/main.py  — routes, validation (schemas.py)
   │
   ▼
Service  backend/app/service.py — loads inputs from SQLite, runs the pipeline, caches results
   │            │                         │
   │            ▼                         ▼
   │      Engine  backend/engine/    Verifier  backend/verify/
   │      (reader → normalise →      (re-reads the OUTPUT rows,
   │       pre-flight → allocate →    checks every rule, builds the
   │       CP-SAT/greedy → rows)      run certificate hashes)
   ▼
SQLite  projects/optislot.db   (inputs, rulesets, runs, decisions, activity)
```

Key idea: **inputs are stored, outputs are recomputed.** Same inputs + same ruleset → same hashes, so a restart reloads the exact same state.

In demo mode (`make demo`) FastAPI serves the built frontend and the API from one process on port 8000. In dev mode (`make dev`) Vite on :5173 proxies `/api` to the backend on :8000.

**Solver warm-up.** The first import of OR-Tools on a freshly synced venv compiles its bytecode and loads the native libraries (about 15 s measured on an emulated cold venv, 0.3 s afterwards). `app/warmup.py` does this on a background thread at app start (the server accepts requests in under a second; a request for the demo project waits on the project lock until its allocation is ready). `make demo` and `scripts/start_demo.sh` also run `python -m app.warmup` while the frontend builds; `OPTISLOT_WARMUP=0` switches the background thread off (the tests do).

---

## 3. One click, end to end

### 3a. Import → Allocate (the opener)

1. **Import screen** (`frontend/src/routes/Import.tsx`) sends the dropped file(s) as multipart to `POST /api/projects/{id}/import`.
2. **Backend** (`backend/app/main.py` → `backend/app/service.py`) stores the file bytes + sha256 in SQLite (`files` table), then `backend/xio/reader.py` finds the header row, picks the best sheet and auto-maps columns (rapidfuzz + synonyms). The response lists mapping + confidence, raw headers, quarantined rows and `needs_confirmation` flags.
3. The user fixes any mapping (`POST /mapping`) and presses **Allocate** → `POST /allocate`.
4. **Engine** (`backend/engine/pipeline.py`): normalise → pre-flight (every bad row becomes a TQ) → partition by controller domain → sort cable blocks → **CP-SAT** chooses the CIOC per block (greedy fallback) → exact slot, CHARM, terminal block and names → one row per physical slot (384 per cabinet).
5. **Verifier** (`backend/verify/checks.py`) re-reads the produced rows and certifies them. A failing CP-SAT result is never adopted.
6. `AllocationResult` (slots, KPIs, TQs, certificate) returns to the browser; TanStack Query caches it; the Dive plays and the app lands in the 3D Room.

### 3b. Workbench move (Try changes → Apply → 3D)

1. Pick a slot in `frontend/src/workbench/MovePicker.tsx` → `POST /placement/check`.
2. `backend/app/placement.py` re-runs the engine with that cable pinned there; "allowed" only if the **independent verifier** finds no new violation. Response = verdict + plain-English reasons + what changes + alternatives.
3. **Apply** → `POST /placement/apply` (a draft in the sandbox, undoable). **Commit** lands it in the allocation and writes a decision-log entry.
4. The browser's motion bus (`frontend/src/motion/bus.ts`) remembers the move; opening the 3D Room plays it (`frontend/src/world3d/engine.ts` `animateMove`). **Before | Now** reads `GET /placement/changes`.

### 3c. Rules are data

`rulesets/default.json` (13 rules, each: `id`, `type`, `enabled`, `severity`, `params`) → loaded by `backend/app/ruleslang.py` (shared by engine **and** verifier) → editing in Rules Studio calls `POST /rules/preview` (impact first), then `PUT/POST /rules` creates a **new ruleset version** + decision-log entry, re-runs allocate and verify. The ruleset version/hash is part of the run certificate.

---

## 4. Files that run (backend)

| File | Use |
|---|---|
| `backend/app/main.py` | FastAPI app: all ~60 routes, serves `frontend/dist` in demo mode |
| `backend/app/schemas.py` | Pydantic contract for every request/response (source of `types.ts`) |
| `backend/app/service.py` | Project service: store inputs, run pipeline, cache, exports |
| `backend/app/sandbox.py` | What-if sandbox, commit/undo/redo, TQ apply/close |
| `backend/app/placement.py` | Workbench: check / apply / undo / redo / reset / changes / commit |
| `backend/app/signals.py` | Lists EVERY signal with where it is, why, and what would fix it |
| `backend/app/signalfix.py` | `POST /signals/{tag}/patch`: fix a signal's data and place it |
| `backend/app/revisions.py` | Revision chain A→B→C, each pinned to the previous one |
| `backend/app/rulesapi.py` | Rules Studio API: catalogue, listing, custom-rule CRUD, previews |
| `backend/app/ruleslang.py` | The rule language shared by engine and verifier |
| `backend/app/customrules.py` | Safe declarative custom rules (no `eval`) |
| `backend/app/drafting.py` | English → schema-validated rule draft |
| `backend/app/assist.py` | Rule assistant glue and the grounded help chat |
| `backend/app/export_openapi.py` | Dumps `backend/openapi.json` for `make types` |
| `backend/engine/pipeline.py` | End to end: MDB → mapping → normalise → pre-flight → allocate → rows → KPIs |
| `backend/engine/normalise.py` | MDB rows → normalised signals; missing columns → defaults + ONE TQ |
| `backend/engine/preflight.py` | Finds every data problem before allocation and turns it into a TQ |
| `backend/engine/allocate.py` | The deterministic, explainable allocator (blocks, first-fit, layout) |
| `backend/engine/optimise.py` | CP-SAT: which CIOC each cable block goes to, per controller domain |
| `backend/engine/custom.py` | Placement hooks + final check for custom rules |
| `backend/engine/hardware.py` | CHARM + terminal block + terminals from the rules' hardware map |
| `backend/engine/revise.py` | Rev B: unchanged signals stay put, every move has a reason |
| `backend/engine/kpis.py` | Scoreboard numbers and spare compliance, all computed |
| `backend/engine/failsafe.py` | A stage error becomes a SYS-<stage> TQ; the run goes on |
| `backend/engine/tqs.py` | Builds the TQ object (same shape everywhere) |
| `backend/engine/rules.py` | Rule-set access for the engine |
| `backend/engine/run.py` | CLI: run the engine on a file from the terminal |
| `backend/verify/checks.py` | THE independent verifier (knows nothing about the engine) |
| `backend/verify/custom.py` | Verifier checks for custom rules (C23+) |
| `backend/verify/xlsx.py` | Reads any allocation workbook back in and verifies it |
| `backend/verify/certificate.py` | sha256 run certificate: input, ruleset, output, engine version |
| `backend/store/db.py` | SQLite (WAL) persistence layer |
| `backend/xio/reader.py` | Reads any IO MDB workbook, finds the header, auto-maps columns |
| `backend/xio/render.py` | Slots → the 76 template columns |
| `backend/xio/writer.py` | Writes the Excel outputs into a copy of the blank template |
| `backend/xio/reports.py` | Rule-check, TQ register, Revision impact, Capacity & BOM workbooks |
| `backend/xio/gauntlet.py` | Builds a deterministic Rev B from any project's Rev A |
| `backend/xio/patches.py` | Stores an engineer's data corrections per project |
| `backend/xio/drills.py` | Headless drill runner for the messy test files |
| `backend/xio/synthetic.py` | Synthetic big/messy MDBs (10k stress) |
| `backend/xio/assist/provider.py` | Gemini/Anthropic REST providers, fail-safe, optional |
| `backend/xio/assist/fallback.py` | Offline English → rule parser |
| `backend/catalog.json` | Hardware strings extracted from the reference |
| `rulesets/default.json` | The 13 rules: THE rules, as data |

### Data and configuration files (what each `.json` is)

| Full path (from `~/Desktop/ApexFinals`) | What it is |
|---|---|
| `rulesets/default.json` | The 13 default rules (A/B, IS, capacity, spares, hardware map, naming), copied into each project's ruleset in the database |
| `backend/catalog.json` | Hardware reference tables (CHARM, terminal blocks, IO types) extracted from the company's reference file |
| `backend/openapi.json` | Machine-readable list of every API route, auto-generated; `make types` reads it |
| `frontend/src/api/types.ts` | TypeScript types generated from `backend/openapi.json` |
| `frontend/package.json`, `frontend/package-lock.json`, `frontend/tsconfig.json`, `frontend/components.json` | Frontend libraries and build settings |
| `projects/optislot.db` | SQLite database: uploaded files, ruleset versions, runs, decisions, activity |

**GET / POST are not files.** They are HTTP calls from the browser to the routes defined in `backend/app/main.py` (about 60 `@app.get` / `@app.post` / `@app.put` / `@app.delete` functions). GET reads, POST does something, PUT replaces, DELETE removes. The list is live at `http://localhost:8000/docs`.

Run once in setup or testing, not in the live flow: `scripts/make_fixtures.py` (offline fixtures), `scripts/fidelity.py` (match vs the reference allocation), `scripts/make_synthetic.py`, `scripts/make_revb.py`, `scripts/make_tampered.py`, `scripts/seed_stress.py`, `scripts/profile_data.py`, `scripts/extract_catalog.py`. Data: `data/` (sample MDB, blank template, reference allocation, `drills/`).

## 5. Files that run (frontend)

All paths start from the repo root (`~/Desktop/ApexFinals`).

| Files | Use |
|---|---|
| `frontend/src/main.tsx`, `frontend/src/routes/index.tsx`, `frontend/src/shell/routes.ts` | Starts React, defines every route and its title |
| `frontend/src/shell/AppShell.tsx`, `frontend/src/shell/Sidebar.tsx`, `frontend/src/shell/TopBar.tsx`, `frontend/src/shell/FlowRail.tsx`, `frontend/src/shell/Scoreboard.tsx` | The frame: numbered rail, top bar, Rev A/B switch, live scoreboard |
| `frontend/src/shell/CommandPalette.tsx`, `frontend/src/shell/useHotkeys.ts` | ⌘K palette and keyboard shortcuts |
| `frontend/src/shell/Inspector.tsx`, `frontend/src/shell/states.tsx` | "Why here?" inspector; loading/empty/error states |
| `frontend/src/api/client.ts` | `fetch("/api/…")` wrappers; falls back to fixtures only if the backend is unreachable |
| `frontend/src/api/hooks.ts`, `frontend/src/api/derive.ts`, `frontend/src/api/sandbox.ts` | TanStack Query hooks per endpoint; derived geometry (cabinet dimensions) |
| `frontend/src/api/types.ts` | Generated from the backend schema (never edited by hand) |
| `frontend/src/store/ui.ts` | zustand: theme, motion mode (Cinematic/Calm), offline flag |
| `frontend/src/routes/Hero.tsx` | Launch page: orbiting 3D room, real-number hooks, Import MDB |
| `frontend/src/routes/Import.tsx` | Drop zone, mapping table, pre-flight, Allocate |
| `frontend/src/routes/Allocate.tsx` | Solver phases, progress, per-cabinet fill |
| `frontend/src/routes/Room.tsx`, `frontend/src/world3d/` | The 3D Marshalling Room page and its engine |
| `frontend/src/routes/Workbench.tsx`, `frontend/src/workbench/` | Every signal, Move-to picker, allowed/refused reasons, Apply/Undo/Commit |
| `frontend/src/routes/Rules.tsx`, `frontend/src/rules/` | Rules Studio: rule cards, previews, custom-rule builder, English box |
| `frontend/src/routes/Proof.tsx`, `frontend/src/proof/` | Verifier checks, certificate, Re-verify scan, Tamper test, verify-any-file |
| `frontend/src/routes/Revisions.tsx`, `frontend/src/revisions/` | Rev A→B stats, diff table, 3D diff |
| `frontend/src/routes/MissionControl.tsx`, `frontend/src/mission/` | Dashboard: mini 3D room, gauges, heat-map, TQs |
| `frontend/src/routes/TqCenter.tsx`, `frontend/src/routes/Grid.tsx`, `frontend/src/routes/Export.tsx`, `frontend/src/routes/Explorer.tsx` | TQs with Apply, 76-column grid, downloads, 2.5D cabinet explorer |
| `frontend/src/world3d/engine.ts` | The three.js engine (levels, doors, explode, moves, scan, dive) |
| `frontend/src/world3d/dive.ts`, `frontend/src/world3d/trails.ts`, `frontend/src/world3d/fx.ts` | Location Rain Dive, light trails, scan beam / ripples |
| `frontend/src/world3d/layout.ts`, `frontend/src/world3d/data.ts` | Settings-driven geometry; allocation → typed arrays |
| `frontend/src/world/` | The 2.5D SVG cabinet world used as the fallback |
| `frontend/src/motion/` | Upload Dive curtain, sequencer, move/refusal bus (`frontend/src/motion/bus.ts`), demo hooks |
| `frontend/src/components/ui/`, `frontend/src/components/panels.tsx`, `frontend/src/lib/` | UI primitives, shared panels, IO colours, utils |
| `frontend/src/mock/*.json` | Early sample data used before the backend existed (12 files); the real app does not read them |

---

## 6. How to SHOW a judge the backend and frontend talking

Set up **three windows** before you present and keep them visible: the app, a terminal with the server log, and a second terminal for the database.

### A. The server log (live, the simplest proof)
`make demo` prints one line per request as it happens, for example `POST /api/projects/demo/placement/apply 200`. Put that terminal beside the app. Click Allocate, make a move, press Re-verify: a line appears each time.

### B. The browser Network tab
Open DevTools → Network → filter "Fetch/XHR". Click in the app; each call appears with status, time and JSON. Open one and show the Response. This proves the UI is calling a real API (not a mock).

### C. Swagger — the contract and a live "Try it out"
Open `http://localhost:8000/docs`. It lists every endpoint, grouped. Press "Try it out" on `GET /api/projects/{pid}/placement/changes`: after you commit a move in the app, the same state comes back. (Swagger lists endpoints; it doesn't stream live updates.)

### D. The database changing (the strongest visual)
Easiest: `bash scripts/start_demo.sh` starts the app and opens `scripts/dbwatch.py` (live viewer, new rows turn green) in a second window. By hand, in a second terminal: `cd ~/Desktop/ApexFinals && python3 scripts/dbwatch.py`. Or raw queries:
```
cd ~/Desktop/ApexFinals
sqlite3 projects/optislot.db ".tables"
sqlite3 projects/optislot.db "select run_id, ts from runs order by ts desc limit 5;"
sqlite3 projects/optislot.db "select name, kind, substr(sha256,1,12), length(data) from files;"
sqlite3 projects/optislot.db "select version, ts, note from rulesets order by version desc limit 5;"
```
Live view that refreshes every second:
```
while true; do clear; sqlite3 projects/optislot.db \
 "select 'runs', count(*) from runs union all select 'decisions', count(*) from decisions union all select 'rulesets', count(*) from rulesets union all select 'activity', count(*) from activity;"; sleep 1; done
```
Do an action (commit a move, save a rule change, import a file) and watch the counts go up. SQLite is in WAL mode, so reading while the app writes is safe.

### E. A 90-second story that uses all of it
1. Show the three windows. "The browser calls an API; this log is the server; this is the database."
2. In Import, drop a file → point at `POST …/import` in the log and a new row in `files` (with the sha256).
3. Press Allocate → `POST …/allocate`, a new row in `runs`.
4. In the Workbench make a move and Commit → `POST …/placement/commit`, a new row in `decisions`; the 3D room plays the move.
5. Edit a rule in Rules Studio and save → `POST/PUT …/rules`, a new ruleset version; allocation and proof re-run.
6. Open `rulesets/default.json` and `docs/rule_coverage.md`: "this rule, this engine step, this verifier check."
7. Press Re-verify, then Tamper test: the independent verifier fails the modified copy and names the row.

### F. If something is slow or the network is down
Everything runs on localhost, so Wi-Fi isn't needed. Only the optional AI rule assistant calls out; without a key or network it falls back to the built-in parser.
