# OptiSlot — 8-minute demo script

**Before you start:** run `make demo`, then **wait ~20 s** for the solver warm-up (the first Allocate after a cold start waits ~15 s otherwise). Keep three windows visible: the app, the server log, and `python3 scripts/dbwatch.py`. Everything is local; Wi-Fi is not needed.

| # | Time | Step | Say | If X fails, say Y |
|---|---|---|---|---|
| 0 | 0:00 | Hero page | "Allocate. Prove. Revise. Everything you will see runs offline on this laptop." | **X:** 3D room is black / slow. **Y:** "WebGL fell back to the 2D view; the data is the same." Press `2D` toggle and continue. |
| 1 | 0:30 | **Import** the sample MDB; show mapping chips with confidence, the pre-flight card | "Any MDB: columns are auto-mapped, bad rows become TQs, nothing crashes." | **X:** file dialog fails. **Y:** "The demo project is preloaded." Go to Allocate. |
| 2 | 1:30 | **Allocate**; watch the solver phases | "CP-SAT picks the CIOC per cable block; greedy is the fallback. The sample takes about 1.2–1.4 s end to end." | **X:** it waits several seconds. **Y:** "That is the one-time solver warm-up, ~15 s after a cold start; it is a one-off." |
| 3 | 2:15 | **3D Room**: Dive, open a cabinet, a CIOC, a baseplate, hover a CHARM, "Why here?" | "Every slot carries the rules and decisions that put it there." | **X:** the dive stutters. **Y:** "Esc skips it; calm mode shortens it." |
| 4 | 3:30 | **Workbench**: pick a signal, "Move to…", read ALLOWED or REFUSED, Apply, show Before / Now | "Allowed means the independent verifier found no new violation." | **X:** the move is refused. **Y:** "That is the product working: it names the rule and the signals involved." Pick an allowed target. |
| 5 | 4:30 | **Rules**: type a rule in the English box; then show it still works offline | "The AI only drafts a rule; it must validate against the rule schema and it never places a signal." Switch the network off: "built-in rule templates answer, the badge says so." | **X:** the provider times out. **Y:** "That is the fallback by design: offline parser, same schema check." |
| 6 | 5:30 | **Proof**: Re-verify (checks tick), then **Tamper test** | "22 checks per run; the exported workbook shows 23 rows (adds C00). Edit one CHARM and the verifier names the row and the check." | **X:** tamper test passes. **Y:** "Revision No, Remarks and Change Type are free text and not verified; we say so. Try a CHARM edit." |
| 7 | 6:30 | **Revisions**: Inject Rev B; show moved, unchanged, stability | "Unchanged signals stay in place; every move has a reason. Drill F: 0 unchanged signals moved, stability 97.9%. Rev B runs greedy by design." | **X:** stability differs from 97.9%. **Y:** "Stability is computed from this Rev B; 97.9% is the drill F figure." |
| 8 | 7:15 | **Export**: show the 5 files and Download all | "Every output is produced by the tool, none hand-edited." | **X:** a download fails. **Y:** "Same files are under Proof and in the run history; I can regenerate." |
| 9 | 7:45 | Close | "Reproducible: the same inputs give the same output sha256." Show two runs in run history. | **X:** hashes differ. **Y:** stop and check that the input file or ruleset version changed. |

## Numbers you may quote
189 live signals · 664 tests passing · 22 checks per run (23 in the exported report) · 13 rules · sample 1.2–1.4 s · 950 rows 6.3–6.4 s · 10,000 rows ~19 s end to end (~3 s allocate + verify in memory) · tamper matrix 335 cases, three free-text columns undetected.
Do not quote an optimality gap or lower bound; none is reported.
