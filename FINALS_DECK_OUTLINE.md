# OptiSlot — finals deck outline

Numbers are verified at HEAD `05f6399` unless marked [VERIFY].

1. **Title** — OptiSlot: Allocate. Prove. Revise. (team Brownie, Emerson track, PS #02)
2. **The problem** — IO signal sudoku: one pair = one signal = one CHARM slot; A/B and IS segregation, contiguous cables, spares, hardware per IO type.
3. **Semifinal promises → delivered**
   - CP-SAT picks the CIOC per cable block, greedy fallback — delivered
   - Independent checker re-reads the exported Excel; a tampered copy fails — delivered (335-case tamper matrix; only Revision No, Remarks and Change Type undetected)
   - Rev B moves only what changed, every move has a reason — delivered (drill F: 0 unchanged signals moved, 97.9% stability)
   - Rules editable live or in plain English — delivered
   - Any IO MDB with zero code; bad rows quarantined — delivered (drills A–F, 0 violations)
   - TQs that name the clash — delivered
   - Every run hashed — delivered (identical output sha256 across runs)
   - 10k+ run time measured — delivered (see slide 8)
4. **How it decides** — read/map → normalise → pre-flight → cable blocks → CP-SAT/greedy CIOC choice → deterministic layout → `CHARM_No = (bp − 1) × 12 + ch`.
5. **Live demo** — Import → Allocate → 3D room → Workbench → Rules → Proof + tamper → Revisions → Export (see `DEMO_SCRIPT.md`).
6. **Proof** — 22 checks per run, 23 rows in the exported report (adds C00); no C21/C22; 664 backend tests passing, 0 failed.
7. **Rules are data** — 13 rules in `rulesets/default.json`; a new rule or a new MDB needs no code change.
8. **Performance** — sample 1.2–1.4 s · 950 rows 6.3–6.4 s · 10,000 rows ~19 s end to end (~3 s allocate + verify in memory). First Allocate after a cold start waits ~15 s for solver warm-up.
9. **Honesty slide** — solver status OPTIMAL for the CIOC assignment, but no lower bound is reported; Rev B uses greedy by design; the reference differs on `440-PI-20076-L` / `440-PI-20077-L` (we allocate what the MDB says); AI is optional and only drafts rules.
10. **Close** — Allocate. Prove. Revise.
