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

## Round 1 (23:40) — full pass, 78 captures, 0 browser errors
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

## Round 2 (00:05) — 78 captures, 0 browser errors
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

## Round 3 (00:20) — 78 captures + motion re-shoot (36), 0 browser errors
FPS: demo **avg 57–62 fps** (p95 17–33 ms); stress10k **avg 55–59 fps** (p95 17–33 ms, worst 50 ms on one glide).
Numbers are from headless Chromium; a real GPU window on the stage laptop is expected to be equal or better.

| # | Where | Issue | Fix | Status |
|---|---|---|---|---|
| 3.1 | Glide 25–50 % | The zoom-out dip (0.3) crossed the Plant threshold → mid-glide the cabinets popped to heat-maps + floor labels, then back | `GLIDE_DIP` 0.12, kept above the 0.85 Plant threshold: the level of detail is now stable across the whole glide | fixed |
| 3.2 | Dive (Calm) 50 % | Full-size file card overlapped the first chip row; its radius still morphed | Calm: no lift, chips below the card, fixed radius | fixed |
| 3.3 | Export / Rules @1920 | Full and balanced; download links work | — | ok |
| 3.4 | Detail (dark + light) | Tag / CHARM / TB legible inside each slot; family ring and the reserved alarm BP dashed outline read clearly | — | ok |

### Still open (for U2–U5)
- Mission Control, Proof, Lab, Revisions, Import, Rules, TQ, Grid and Export are real-data previews built from shared
  panels (`src/components/panels.tsx`); the full screens arrive in U2–U4 (dev-only "Arrives in" chip).
- Flip is a whole-World `rotateY`; at Plant level all cabinets flip together (fine for now; U5 may flip only the active one).
- 10k: switching to the stress project downloads ~13 MB of allocation JSON (gzipped on the wire); first paint ~1.4 s.
