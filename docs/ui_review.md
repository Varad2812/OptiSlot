# UI review log — U1 Control Room foundation + World (CLAUDE.md §10.6)

Captured with `npm run shots` (10 routes × 1440×900 / 1920×1080 × dark / light, plus motion frames in `shots/motion/`
and the 10k stress project in `shots/stress/`). Every PNG and frame was opened and looked at before writing this.

## Round 0 (pre-QA smoke, 23:15)
| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| 0.1 | Explorer | Cabinets were sorted by `seq`, so P24 came before P30 (not the export's physical order) | Keep the engine's cabinet order (`a.cabinets`) | fixed |
| 0.2 | Explorer | BP labels (`001-CBP-1`) ran under the first slot | `BP_LABEL` 52 → 64 | fixed |
| 0.3 | Explorer | The toolbar wrapped onto 3 ragged rows at 1440 | Two fixed rows: navigation (crumbs, tabs, strategy, replay) + filters | fixed |
| 0.4 | Dive 25–50 % | The header plate showed through the overlay; the neighbour cabinet was already full while cabinet 1 was still empty | Plate hidden while diving; the drop applies to every detailed cabinet | fixed |
| 0.5 | Dive 50 % | Slots for blocks not yet dropped were blank holes in the grid | Static "socket" outlines under each block; the block falls into them | fixed |
| 0.6 | Plant | With 3 cabinets the plant fit sat right at the tier threshold → a mix of detail and heat-map cabinets | Plant tier below 0.85× cabinet scale; floor labels (name + fill) at Plant level | fixed |

## Round 1 (23:33) — full pass, 78 captures, 0 browser errors
FPS (headless Chromium, rAF deltas during the glide): demo **avg 58–60 fps**, p95 17 ms; stress10k (10,009 signals,
46 cabinets) **avg 59 fps**, p95 17 ms. Grid navigation on stress10k: 1.35 s (includes the 10k fetch).

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| 1.1 | stress / Plant | 46 cabinets fitted in one row → a 20 px strip in an empty viewport | The Plant view walks a window of ≤ 8 cabinets around the active one; the minimap still shows the whole row | fixed |
| 1.2 | Explorer detail | The CIOC detail fit ran under the header plate (top) and the legend (bottom) | Detail insets top 140 / bottom 84 / right 64 | fixed |
| 1.3 | Explorer + Inspector | The 400 px Inspector covered the slot that was just clicked | After the drawer opens, the camera pans so the inspected slot stays left of it | fixed |
| 1.4 | Grid / Lab | "Wired spares vs target" bars had zero width (flex child without a basis) | `Bar` is `flex-1 min-w-[64px]` | fixed |
| 1.5 | Import @1920 | Lower half of the page empty | MDB preview panel (first 12 rows of the import summary) | fixed |
| 1.6 | Mission / Lab strip @1920 | The Plant strip was short and the cabinets small | Strip height `clamp(230px, 30vh, 345px)` | fixed |
| 1.7 | Flip mid-frame | The header plate says FRONT while the crumb already says (R) | Accepted: the plate swaps at the flip's midpoint (edge-on), which reads correctly in motion | accepted |
| 1.8 | Palette | Clean; tag search finds `320-CE` cables and tags with their slot address | — | ok |

## Round 2 (23:39) — 78 captures, 0 browser errors
FPS: demo **avg 61–62 fps** (p95 17 ms, worst 17 ms); stress10k **avg 59–60 fps** (p95 17 ms).
Offline drill: built app served by `vite preview` with no backend → the World renders from `src/mock` fixtures,
"Offline" chip in the top bar, 0 page errors.

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| 2.1 | stress / Plant | — now 8 cabinets fill the width; the minimap's viewport box walks the 46-cabinet row | — | ok |
| 2.2 | Dive 100 % | Scoreboard ends on the real numbers (100 % · 0 violations · 1 open TQ · 3 cabinets · 12 CIOCs · 18.5 %) | — | ok |
| 2.3 | Dive (Calm) 50 % | Calm mode still flew the mapping chips and shrank the file card (motion, not fades) | In Calm the card, dot and chips only fade in place | fixed |
| 2.4 | Explorer detail | The header plate covered the cabinet nameplate at CIOC zoom | Plate hidden at detail zoom (the breadcrumb names the CIOC) | fixed |
| 2.5 | Rules / Export @1440 | Lower half of the page empty | Rules + Optimiser + rule activity; Export + certificate + hardware BOM + spares per cabinet; export cards are real download links | fixed |
| 2.6 | Top bar (offline) | "Offline fixtures" chip and the Rev pill wrapped onto two lines at 1440 | Short "Offline" chip with a tooltip; `shrink-0 whitespace-nowrap` on both | fixed |
| 2.7 | Inspector | Selected slot stays visible left of the drawer; Why-here timeline shows rule chips | — | ok |

## Round 3 (23:45) — 78 captures + motion re-shoot (36), 0 browser errors
FPS: demo **avg 57–62 fps** (p95 17–33 ms); stress10k **avg 55–59 fps** (p95 17–33 ms, worst 50 ms on one glide).
Numbers are from headless Chromium; a real GPU window on the stage laptop is expected to be equal or better.

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| 3.1 | Glide 25–50 % | The zoom-out dip (0.3) crossed the Plant threshold → mid-glide the cabinets popped to heat-maps + floor labels, then back | `GLIDE_DIP` 0.12, kept above the 0.85 Plant threshold: the level of detail is now stable across the whole glide | fixed |
| 3.2 | Dive (Calm) 50 % | Full-size file card overlapped the first chip row; its radius still morphed | Calm: no lift, chips below the card, fixed radius | fixed |
| 3.3 | Export / Rules @1920 | Full and balanced; download links work | — | ok |
| 3.4 | Detail (dark + light) | Tag / CHARM / TB legible inside each slot; family ring and the reserved alarm BP dashed outline read clearly | — | ok |

## U3 — Try-out Lab + Revision Center (2 rounds, 0 browser errors)
Captures: `/lab` and `/revisions` × 1440/1920 × dark/light, plus the Rev B diff frozen at 0/50/100 % (`motion/revb__p*`).
Behaviour checked against the real API (scratch Playwright runs, temp DB):
- B cable (320-CE-0004) dropped on an A CIOC → **refused**: the pane shakes (x oscillates ±10 px), the target row flashes red three
  times, and the server's reason is shown ("… cannot join CIOC P30DCIOC3201001 which holds A-family signals — rule r-ab …").
- Compact switch → Impact **CIOCs 12 → 5 (−7)**, 0 violations; Discard restores Balanced (12).
- Valid move (12-pair cable, BP 3 → BP 6) → ghost flies on an arc, Impact "9 signals moved", Undo/Redo/Commit and a server-side Undo all work.
- Inject Rev B → added 10 / deleted 1 / modified 1 / moved 0, stability 98.9 %, auto re-verify "0 violations · 22/22 checks",
  scoreboard stays at 0 violations; only the 12 changed slots get an element in the diff overlay.

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| U3.1 | Revisions header | Page title invisible (`text-card` is the surface colour, not a font size) | Explicit size/weight classes | fixed |
| U3.2 | Top bar @1440 | New "Inject Rev B" button + Rev B pill pushed the Flow Rail over the Rev pills | Motion toggle is icon-only below 1680 px (tooltips keep the names); project select 165 px | fixed |
| U3.3 | Revisions | Camera opened on the first change (a lone modified slot on another cabinet) | Opens on the busiest cabinet and the side holding most of its changes | fixed |
| U3.4 | Lab | Lifted-block ring was drawn at the wrong CIOC when the selected cable lives on the other side (front/rear share row positions) | Overlays only draw when cabinet AND side are in view | fixed |
| U3.5 | Lab panes | Plinth clipped at the bottom; the hint chip covered the last baseplate row | Bottom inset 40; hint chip moved to the top-right | fixed |
| U3.6 | Revisions | Legend overlapped the cabinet's lower-left corner | Bottom inset 56 | fixed |

Design notes worth knowing:
- The what-if endpoint has no field for the CIOC strategy, so the Lab applies a strategy change to the rule set *provisionally*
  (decision log: "Sandbox preview: CIOC strategy → compact") and restores it on Discard / when leaving the Lab. A server-side
  preview of settings would remove those two log lines.
- A what-if returns only changed slots, so toggles/sliders that alter wired-spare counts update the Impact numbers but not the
  proposed World's hatched slots (moves and strategy do show on the World).

## U2 — Mission Control + Proof Center (2 rounds, 0 browser errors)
Captures: `/` and `/proof` × 1440/1920 × dark/light, the verify scan frozen at 0/50/100 % (`motion/verify__p*`), the tampered-export demo
(`motion/tamper__{mid,end}__*`), the Mission Control strip dive (`motion/mission-dive__*`), and both screens on the 10k project (`stress/`).
`npm run shots` now *asserts* the demo: an untouched export PASSes and is byte-identical to the certified output; the tampered copy
(`scripts/make_tampered.py`: one CHARM Type changed) shows a red marker on the slot, a failing check, and the camera at detail zoom.
Behaviour checked against the real API (scratch Playwright, temp DB):
- Tampered export → `FAIL · 1 violation · 21/22`, check "CHARM / terminal block match the hardware map", **row 196**, slot
  `P30-DCM-32001-01/003/1/3`; the camera glides to the rear side of cabinet 1, flies in, and the slot + its list row pulse red three times.
- The MDB, a text file renamed .xlsx and the blank template all come back as a failed report (never a crash); the UI shows it.
- `V` replays the scan (ticks 40 ms apart, stamp lands last); Calm mode drops the beam and sets the camera directly; ←/→ move between
  cabinets; "Fly to slot" works from the list; verifier unreachable → toast, page stays alive, Re-verify replays the cached report.
- Two engine runs with identical inputs carry identical hashes → the second is tagged "reproduced" in the run history.
- 10k project: Mission Control 2.1 s and Proof 2.2 s including a 1.2 s settle; glide still 59–60 fps.

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| U2.1 | Mission Control | Certificate card left a blank half-column next to the strip | Certificate + stability stack beside the strip; activity timeline spans the bottom in two columns | fixed |
| U2.2 | Mission Control | Stack content overflowed its card (flex children allowed to shrink) | Natural height, no `min-h-0` | fixed |
| U2.3 | Mission Control | "Inject Rev B" button ran into the caption text | Button on its own line | fixed |
| U2.4 | Proof | Stamp card collapsed to its header while the checks list scrolled | Stamp pinned above a scrolling region (`shrink-0`) | fixed |
| U2.5 | Proof | Beam parked at the far edge by 50 % (ease-out) | Smoothstep sweep | fixed |
| U2.6 | Proof | Result toast covered the ticking rows | No toast on a file verdict — stamp, chip and banner say it | fixed |
| U2.7 | Proof | New verdict was on screen while the camera glided to the failing cabinet, then the scan restarted | Sequence reset to 0 before the glide | fixed |
| U2.8 | Proof | Stale scroll position after a result with nothing to fly to | Checks list scrolls to the top on every new report | fixed |
| U2.9 | Proof | A Re-verify landing after a file drop replaced the file result | Drops are refused (toast) while a Re-verify is in flight | fixed |
| U2.10 | Proof | Seal crowded the verdict line; header "22/22" gave the result away before the ticks | Smaller seal, 23 px verdict line; the header count climbs with the ticks | fixed |
| U2.11 | Proof / shots | `/proof` route still shot mid-scan (it autoplays once per session) | `optislot-scan-seen` set in the shots context | fixed |
| U2.12 | Run history | "reproduced" appeared on repeated uploads of the same file (trivially true) | Only engine runs (allocate / revision) are tagged | fixed |

Notes:
- The Scoreboard strip in the shell is Mission Control's first tile (it is on every screen); the page itself starts below it.
- A click on a Mission Control cabinet zooms the strip's camera into it (420 ms), then the Explorer opens with a Plant → cabinet dive
  (`store.arriveFrom`, one-shot, Calm = no dive). A deliberate dive counts as the session's Upload Dive.
- The scan autoplays once per session on the first Proof visit (not in `?demo=1`); any key finishes it.
- Before a revision exists the stability tile shows the baseline and an "Inject Rev B" button — never an invented percentage.

### Still open (for U2–U5)
- Import, Rules, TQ, Grid and Export are real-data previews built from shared panels (`src/components/panels.tsx`);
  the full screens arrive in U4 (dev-only "Arrives in" chip).
- Flip is a whole-World `rotateY`; at Plant level all cabinets flip together (fine for now; U5 may flip only the active one).
- 10k: switching to the stress project downloads ~13 MB of allocation JSON (gzipped on the wire); first paint ~1.4 s.

## U5 — launch readiness: 10k, fresh DB, palette, Calm, final sweep (1440×900, dark + light)
10k (stress10k, 10,009 signals, 46 cabinets):
- Tables: the Workbench and the Grid are virtualised (scroll 61 / 56 fps headless, 320k / 459k px of rows); every other table is per
  cabinet or capped (≤ 46 rows).
- 3D on the real GPU (Apple M2, headed Chromium): /room idle + orbit, /mission, /, /proof and /explorer all **60 fps (vsync), p95 17 ms**
  on the sample and on 10k. Headless SwiftShader numbers (1–5 fps) are software GL and only indicative.
- Bundle: main 1.02 MB (314 kB gzip); three.js engine lazy 620 kB (163 kB gzip); the offline fixtures are lazy chunks that never load
  while the API is up (asserted by `npm run shots`). Left as is: served from localhost, one-time load.

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| U5.1 | Fresh DB | A remembered project id the new database doesn't have (e.g. yesterday's stress10k) left the launch page empty on 404s | Once per session the first project list falls back to the demo project | fixed |
| U5.2 | Launch page | ⌘K did nothing and the tab title kept the last page's name (the page sits outside the shell) | Palette + ⌘K and the route title on `/` too ("OptiSlot — Allocate. Prove. Revise.") | fixed |
| U5.3 | Calm mode | Only the screens that read `useCalm` calmed down; other framer-motion parts still slid and scaled, CSS pulses kept looping | `MotionConfig reducedMotion="always"` app-wide in Calm; `data-motion="calm"` holds pulse/breathe/halo loops still | fixed |
| U5.4 | Reduced motion | The 1 ms animation override made infinite loops flicker | Also forces a single iteration | fixed |
| U5.5 | Launch page (light) | Light tokens over the always-dark room → a grey wash; the theme button did nothing visible there | The launch page is dark in both themes (as the approved reference); its theme button removed (top bar + ⌘K keep it) | fixed |
| U5.6 | Explorer / 2D Room @1440 | Filter row overflowed: the tag search was clipped at the right edge | "Filter" label from 1600 px; narrower search | fixed |
| U5.7 | Export certificate | 22 check ticks wrapped onto a second row | Ticks flex on one row | fixed |
| U5.8 | Shots | The `/` route capture caught SwiftShader's flat-floor fallback | Route pass waits for the mini room's first frame (`?demo=1`) on `/` and `/mission` | fixed |
| U5.9 | Workbench | Frozen Tag column surface differs slightly from the row background | — | accepted (reads as the frozen column) |
| U5.10 | Room (route pass) | Captured in 2D: the route pass pins the 2.5D World; the 3D pass (`shots/3d`) covers the room | — | by design |
