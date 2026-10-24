# OptiSlot — fact-check (read-only QA)

**Tested commit:** `a15e1088d53b4a324c019e29a54b87e76c33b331` (`a15e108`, branch `master`) for everything below.
**HEAD moved during this QA:** the other session committed `2e7ebc4` ("one cable-home function ...", suite 299 passed) while I worked.
I re-checked only the adversarial-fixture finding against `2e7ebc4` (see §3b, "Update"); every other number is from `a15e108`.

**How the tests were isolated.** While this QA ran, another session edited the working tree
(`backend/engine/normalise.py`, `backend/engine/preflight.py`, `backend/verify/checks.py` showed as modified, and
`backend/app/cabledomain.py` appeared). To get numbers that belong to one commit, every measurement below was taken
from a clean copy of **HEAD** made with `git archive HEAD | tar -x` into the scratchpad
(`/private/tmp/claude-501/-Users-varadrathor-Desktop-ApexFinals/ced741ab-12e6-4b62-bd02-7841404cd1ef/scratchpad/snap`).
The only file copied from outside HEAD is the untracked fixture `backend/tests/fixtures/OptiSlot_Adversarial_MDB.xlsx`.
No source, test or config file in the repo was edited; this file is the only thing written to the repo.
Helper scripts live in the scratchpad, replicas in `/tmp/optislot_replicas/`.
Machine: macOS (Darwin 24.6.0), Python 3.11 via `uv`. All commands run from `<snap>/backend` with `uv run python <script>`.

> **Later changes (not re-tested in this document).** The tamper gaps in §4 were closed by the C17 / C17.2 split (`tests/test_tamper_matrix.py`), the cold-start cost in §3b by `app/warmup.py`, and the check count in §6 is now 22 in memory / 23 on an exported workbook (C07.2 and C17.2 both exist; see CLAUDE.md §6 and docs/rule_coverage.md).

> **Headline findings (read these first)**
> 1. At a15e108 the **adversarial MDB fails the verifier** (1 violation, check C10) on the greedy path, and the CP-SAT result
>    is **rejected by the verifier gate**. Commit `2e7ebc4` fixes it (re-verified: PASS, CP-SAT OPTIMAL and adopted). See §3.
> 2. **No lower bound is reported anywhere** (backend, API, UI). Only `status` (OPTIMAL / FEASIBLE / ...) is shown. See §3.
> 3. Drill F **does use greedy**, by design (`cpsat_enabled=False` for every revision). See §2.
> 4. **There is no dedicated mutation-test suite.** The verifier catches 34/44 of my ad-hoc single-cell mutations as a hard
>    FAIL (39/44 if soft C17 warnings count). Five go uncaught, including a changed `Field Cable No`. See §4.
> 5. **10,000 signals end-to-end is ~7 s from an xlsx, not < 3 s.** The < 3 s figure only holds for the allocate stage, or
>    for the `/stress` endpoint (allocate + verify = 3.0–3.2 s). See §5.
> 6. A normal run shows **21 checks, not 20**, because C07 expands to C07 + C07.2 (two `segregate` rules). See §6.
> 7. The capacity property test **exists** (`test_capacity_property`, 3000 examples). See §7.

---

## 1. `440-PI-20076-L` vs `440-PI-20077-L` — why do they differ?

**Answer (verified):** the two tags are **not the same row in two places**. The input MDB contains only `440-PI-20077-L`
(MDB row 157). `440-PI-20076-L` does not appear anywhere in the MDB. The reference allocation workbook places
`440-PI-20076-L` on the *same cable and pair* (`500-CE-LP-0003-A`, Pair 14) that the MDB gives to `...20077-L`.
So the reference differs from the MDB on this one tag (a rename/typo in the reference, cause not provable from the data: **UNVERIFIED** as to which side is "right"). We allocate what the MDB says.

Command (`$S` = scratchpad; script prints our row, the reference row and the MDB rows of the cable):

```
cd <snap>/backend && uv run python $S/q1.py
```

Real output (trimmed to the relevant columns):

```
OURS {'Tag Name': '440-PI   -20077-L', 'IO Type': 'AOR', 'Field Cable No': '500-CE-LP-0003-A', 'Field Cable Pair': 'Pair 14',
      'Electronic/ Marshalling Cabinet': 'P24-DCM-50002-01', 'CIOC/CSLS Name': 'P24DCIOC5002002', 'Baseplate': '002-CBP-2',
      'Channel_No': '2', 'CHARM Type': 'SE4304T01', 'Tag Status': 'Field', 'Change Type': '-'}
TQs mentioning: []
REF  {'Tag Name': '440-PI   -20076-L', 'IO Type': 'AOR', 'Field Cable No': '500-CE-LP-0003-A', 'Field Cable Pair': 'Pair 14',
      'Electronic/ Marshalling Cabinet': 'P24-DCM-50002-01', 'CIOC/CSLS Name': 'P24DCIOC5002003', 'Baseplate': '003-CBP-2',
      'Channel_No': 2, 'CHARM Type': 'SE4304T01', 'Tag Status': 'Field', 'Change Type': '-'}
MDB 157 440-PI   -20077-L Pair 14 AO New
MDB has 20076? False
```

Other facts from the same output:
- Same cabinet (`P24-DCM-50002-01`), same CHARM part (`SE4304T01`), same pair. **The CIOC differs**: ours is `...002` / `002-CBP-2`,
  the reference is `...003` / `003-CBP-2` (address agreement with the reference is informative only, per CLAUDE.md §11).
- No TQ mentions either tag (`TQs mentioning: []`): the engine treats `...20077-L` as an ordinary live signal.
- The verifier's check C01 flags the pair when it is run **on the reference workbook**: test `test_reference_workbook_runs_and_catches_the_trap`
  (`backend/tests/test_verify.py:61`) asserts both tag names appear in C01's violations.
- `docs/fidelity_report.md:4` says the same: "Only in ours: `440-PI-20077-L` · only in the reference: `440-PI-20076-L`".

---

## 2. Drill F — is the greedy fallback used, and why?

**Answer (verified):** yes — **greedy is used, but by design, not because CP-SAT failed.** Every revision run disables CP-SAT.

Evidence in code (`backend/engine/revise.py`, in both `revise()` and `rerun_pinned()`):

```python
settings = (settings or prev.settings).model_copy(update={"cpsat_enabled": False})
```

Rationale visible in the module docstring: Rev B pins unchanged signals to their slots, and a re-optimisation would move them
(moves = rewiring). The default setting is `cpsat_enabled=True` (printed by `q23.py`: `default cpsat_enabled: True limit 2.0`).

Command:

```
uv run python $S/q23.py        # revise(drill_F_revB_manual.xlsx bytes, previous run = sample)
```

Real output (drill F section, HEAD, 3 repeated runs gave the same lines apart from `time_ms`):

```
drill F revise settings.cpsat_enabled= False
  {'method': 'greedy', 'greedy_ciocs': 12, 'cpsat_ciocs': None, 'adopted': False, 'status': 'greedy only', 'time_ms': 48.6,
   'note': 'Optimiser off — greedy balanced spread'}
 moved 0 stability 97.9
```

So for drill F the UI/API shows `status: "greedy only"`, `cpsat_ciocs: None`, and 0 unchanged signals moved, stability 97.9%.
Note: "greedy" here is the *pinned* greedy with the baseline; "greedy fallback" in the sense of "CP-SAT tried and was rejected" does **not** apply to drill F.
(The separate drill harness `backend/xio/drills.py::run_drill_f` also runs through `apply_revision` and asserts the same.)

---

## 3. Solver status and lower bound — sample MDB and adversarial fixture

### 3a. Sample MDB (`data/Sample_IO_MDB_VIT_v2_1.xlsx`, HEAD) — 3 runs, identical apart from time

```
{'method': 'cpsat', 'greedy_ciocs': 12, 'cpsat_ciocs': 12, 'adopted': True, 'status': 'OPTIMAL', 'time_ms': 457.6,
 'note': 'CP-SAT adopted (balanced) — IO groups tighter (spread 1 → 0)'}
```

(The first run of three measured `time_ms` 28901.5 because the machine was contended by a parallel process; the next two were 457.6 and 493.8 ms.)
Solver status = **OPTIMAL**. CP-SAT is adopted because the *IO-group spread* improved 1 → 0, **not** because it saved CIOCs (12 vs 12).

### 3b. `backend/tests/fixtures/OptiSlot_Adversarial_MDB.xlsx` (188 live signals) — **verifier rejects CP-SAT at HEAD**

Output of `q23.py` at HEAD, 3 of 3 runs:

```
{'method': 'greedy', 'greedy_ciocs': 12, 'cpsat_ciocs': 12, 'adopted': False, 'status': 'rejected by verifier', 'time_ms': 0.0,
 'note': 'CP-SAT result failed the independent verifier — greedy kept'}
```

Why (`q3c.py`, which wraps `verify_rows` to print what the gate sees):

```
GATE verdict FAIL viol 1 excepted 7
  FAIL C10 Names follow the project patterns ['320-TT   -20361 (room PIB-30, area - → P30/10001) is in cabinet P30-DCM-32001-04']
```

And the **greedy-only** run at HEAD is *also* not clean (`q3b.py`): `greedy-only verdict FAIL violations 1`. So at HEAD the adversarial fixture
produces **1 hard violation (C10)** even with CP-SAT off; the gate "rejecting CP-SAT" is a symptom, and the final output (greedy) still carries that violation.
The offending tag is a row with a missing design area (`area -`) whose derived name does not match its cabinet.

Caveat: in the *dirty working tree* (another session's uncommitted edits to `normalise.py`/`preflight.py`/`checks.py`, plus new `cabledomain.py`)
the same fixture ran `OPTIMAL`, adopted, verdict PASS, 0 violations, 7 excepted. One mid-QA run against the moving tree also showed the rejection, so the edit was in flight.
That uncommitted work appears to fix the finding, but it is **not in commit a15e108**.

**Update — checked against commit `2e7ebc4`** (clean `git archive 2e7ebc4`, same scripts): the fixture is now clean.
`q23.py`: `{'method': 'cpsat', 'greedy_ciocs': 12, 'cpsat_ciocs': 12, 'adopted': True, 'status': 'OPTIMAL', 'time_ms': 189.8, ...}`;
`q3b.py` (greedy only): `greedy-only verdict PASS violations 0`. So the finding is **fixed in 2e7ebc4, not in a15e108**. I did not re-run the other items or the full suite on 2e7ebc4.
Also: the very first CP-SAT call in a freshly synced venv is slow (`time_ms` 28901 on a15e108 and 34466 on 2e7ebc4 for the sample, vs ~450 ms warm): a cold-start cost, relevant for the stage demo — warm it up before presenting.

### 3c. Lower bound — **not reported**

`grep -rniE "lower_bound|BestObjectiveBound|best_bound|ObjectiveValue|lower bound"` over `backend`, `frontend/src`, `docs`, `scripts` finds **no code** that reads a
CP-SAT bound. The only hit is `docs/questions.md:74`: "**[CHECK]** whether the UI shows a cabinet lower bound" — the answer is **no**.
`OptimiserInfo` (`backend/app/schemas.py:388`) has exactly these fields: `method, greedy_ciocs, cpsat_ciocs, adopted, status, time_ms, note`.
`engine/optimise.py:262` only stores `solver.StatusName(st)`; objective value and bound are never stored.
So: **solver status is reported; a lower bound is not.** Any claim of "provably optimal / gap 0%" must be limited to `status == OPTIMAL` for the per-domain model, which is optimal for the model's weighted objective, not a proof that 3 cabinets is minimal.

### 3d. Where it is shown in the UI

- `frontend/src/components/panels.tsx:410` — `OptimiserPanel` ("Optimiser" card): method (CPSAT/GREEDY), "adopted" / "greedy kept", `status`, Greedy CIOCs, CP-SAT CIOCs, solve ms, `note`.
  I grepped for its use: `grep -rn OptimiserPanel frontend/src` returns **only its definition** — **UNVERIFIED that it is rendered on any screen** (I did not open the running UI).
- `frontend/src/routes/Allocate.tsx:29,32` — the solver-phase list on the Allocate page prints `"<n> CIOCs by the greedy placer"` and
  `"<cpsat_ciocs> CIOCs found · adopted — it scored better and verified"` or `"kept the greedy layout"` / `"Not needed — the greedy layout stands"`. It does not print `status`.
- Per-slot "Why here?" text: `engine/pipeline.py::_annotate` appends "CIOC chosen by CP-SAT ..." or "... CP-SAT optimal found nothing strictly better".

---

## 4. Mutation tests

**Answer (verified):** there is **no dedicated mutation-test file or framework** (`grep -rniE "mutat" backend/tests` finds only a comment in `test_contract.py:39` about a *shared project being mutated*). What exists are hand-written "planted breakage" tests. I counted the distinct mutations they apply:

| File :: test | Mutation(s) | Expected failing check(s) |
|---|---|---|
| `backend/tests/test_verify.py::test_planted_breakages_are_caught` | (1) A cable moved onto a B CIOC; (2) duplicate address; (3) tag row dropped | C07; C02; C01 + C13 — **3 mutations, 3 caught** |
| `backend/tests/test_verify.py::test_tampered_file_fails_on_that_row` | one CHARM Type edited in the exported xlsx | C09 on exactly that Excel row — **1 / 1** |
| `backend/tests/test_fidelity.py::test_tampered_terminal_fails_c20` | `CHARM TB3` `-` → `4` | C20 on that row, C09 still clean — **1 / 1** |
| `backend/tests/test_verify.py::test_cioc_count_agrees_and_disagreement_is_caught` | KPI CIOC count +1; BOM missing one CIOC | C19 — **2 / 2** (per strategy) |
| `backend/tests/test_api.py::test_verify_file_tampered`, `test_custom_rules_api.py` (≈ line 104) | tampered xlsx via `POST /api/verify-file` | FAIL — API-level |
| `scripts/make_tampered.py` | demo generator: one CHARM Type → `SE4303T03` | C09 (Proof Center demo) |

So the test suite deliberately plants **about 7–8 distinct mutations**, all caught.

**Ad-hoc mutation experiment (mine, not in the repo).** To answer "how many does the verifier catch" more broadly, I wrote `$S/mut.py`: on the sample output (verdict PASS, 21/21 checks)
it applies **44 single-edit mutations** (one cell, one row delete/duplicate, etc.) to a deep copy of `out.rows` and calls `verify_rows` (HEAD).
Command: `uv run python $S/mut.py`. Result:

```
CAUGHT 34 of 44            (verdict FAIL = hard violation)
```

Not a hard FAIL (10):

| Mutation | Result |
|---|---|
| Field Cable No changed to a nonexistent cable | **no check fails at all** |
| Revision No / Remarks / Change Type / Sr. No. changed | no check fails (free-form columns; arguably fine) |
| Segregation A→B, Technical Room, Service Description, Signal Type, Old Tag changed | **C17 fails, but C17 is `soft`** → verdict stays PASS (shown as a warning) |

So: **34/44 hard-caught; 39/44 flagged by at least one check; 5/44 invisible.** The one that matters for the "tampered copy fails" promise is
**`Field Cable No`**: editing the cable name of a Field row (pair untouched) is not detected. (It *is* detected if the pair or the CHARM/address changes.)
Mutations caught, by check: C09 (CHARM/TB/description/loop), C20 (TB terminals), C04 (CHARM_No/channel), C05/C10 (names, prefixes, side), C01 (tag identity, deleted/duplicated rows),
C02/C03 (duplicate address / cable+pair), C06 (pair order), C11/C16 (IO type, wired-spare count), C12 (future-spare BP), C13 (grid gap), C14 (status discipline), C15 (alarm BP).

---

## 5. Timing — sample, 950-row replica, 10,000-row replica

**Replicas.** Built by `$S/mkrep.py` from the sample (sheet `MDB-1`, 190 data rows × 143 columns) repeated N times;
suffix `-X<k>` is appended to non-empty values of the four columns `Tag Number`, `TagNumber`, `Multipair Cable No.`, `Loop Name`
(values `-`, blank and `Internal Wiring` are left untouched so cabinet-alarm cables keep their meaning).
- `/tmp/optislot_replicas/replica_950.xlsx` — 950 rows = 190 × 5 (copies -X1..-X5). 945 live (5 DELETED rows).
- `/tmp/optislot_replicas/replica_10000.xlsx` — first 10,000 rows of 53 copies (190 × 52.6). 9,947 live.

**Script** `$S/time1.py <file>` runs `run()` → `write_allocation()` → `verify_rows()` once, prints times and the sha256 of the written xlsx bytes.
Each file was run **twice in separate processes** (`uv run python $S/time1.py <file>`, twice).

| File | Run | `run()` (read→alloc→render) | write xlsx | verify | Total | Allocate stage | Optimiser | Result | output sha256 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| Sample (189 live) | 1 | 758 ms | 650 ms | 24 ms | 1432 ms | 638 ms | OPTIMAL, adopted | PASS, 21/21 | `a5aeff40bd2d7e57d40ad28f1f114e2c3a77f514e78f82220b4d32d03a13f62f` |
| | 2 | 530 ms | 636 ms | 25 ms | 1190 ms | 407 ms | OPTIMAL, adopted | PASS, 21/21 | `a5aeff40…3f62f` — **identical** |
| 950-row (945 live) | 1 | 5014 ms | 1319 ms | 81 ms | 6415 ms | 4428 ms | FEASIBLE, adopted | PASS, 21/21 | `ed2a72cc5c60b20ba5e0363d4dbb93c70093a9ed2d750a2262f27778ea5db6ca` |
| | 2 | 4941 ms | 1271 ms | 79 ms | 6291 ms | 4387 ms | FEASIBLE, adopted | PASS, 21/21 | `ed2a72cc…db6ca` — **identical** |
| 10,000-row (9,947 live) | 1 | 6598 ms | 11526 ms | 862 ms | 18986 ms | 1518 ms | skipped (large) | PASS, 20/21 passed | `176c73134a1a724a92e0afcd519d1266f568d735954c98b287f774dce390a55f` |
| | 2 | 7296 ms | 10488 ms | 758 ms | 18542 ms | 1650 ms | skipped (large) | PASS, 20/21 passed | `176c7313…a55f` — **identical** |

**Determinism: confirmed** — the output sha256 is byte-identical across the two runs for all three inputs
(the app's certificate `output_sha256` is `sha256(write_allocation(rows))`, `verify/certificate.py`, so this is the same hash the certificate shows).

Observations, all from the real output:
- **950 rows: 4.4 s allocate.** CP-SAT hits its 2 s/domain limit (status `FEASIBLE`, not `OPTIMAL`), which dominates; 6 cabinets / 24 CIOCs.
- **10k rows: CP-SAT is skipped** (`skip_large = len(live) > 5000`, `engine/pipeline.py`), note "CP-SAT skipped to keep the run under 3 s; greedy + verifier".
  Reading the 10k xlsx takes 4.3–4.7 s by itself (`read_ms`); the allocate stage is 1.5–1.65 s; **writing the xlsx is 10.5–11.5 s**.
  So the CLAUDE.md goal "10,000 signals in < 3 s" holds for the **allocate stage** only. Whole `run()` from an xlsx is 6.6–7.3 s; with write, ~18.5–19 s.
- **The `/api/projects/{id}/stress` endpoint measures allocate + verify on in-memory synthetic data (no xlsx read/write).** I reproduced its code path (`$S/q5d.py`, `generate(10000, seed=7)` → `run` → `verify_rows`), twice:
  `signals=10009 allocate=2209 ms verify=836 ms total=3045 ms cabinets=46 violations=0`, then `allocate=2463 ms verify=784 ms total=3247 ms`. That is the "live on stage" number: **~3.0–3.2 s total, ~2.2–2.5 s allocate** — borderline for the "< 3 s" claim if "total" includes verify.
- **The 10k replica quarantines 336 signals** (9,611 of 9,947 allocated; 25 TQs). Cause (verified): `TQ-CAP-008/016/024` "No room left for cabinet alarms in P30-DCM-32001-01 / -04 / P24-DCM-50002-01 — not allocated" —
  the replica multiplies the 12 cabinet-alarm rows 53×, and alarms only go to the first marshalling cabinet of each domain, whose reserved alarm baseplates fill up.
  This is a **replica artefact** (a real MDB does not scale alarms with signal count), but it is also a visible behaviour: alarms never spill to the 2nd+ cabinet. The verifier reports these 336 tags as "excepted by TQ" (C01), not a silent pass.
- "20/21 passed" in the 10k run: check **C08** (IO-group consecutive cabinets, `soft`) fails for groups `A` and `B-ALARM` (split across non-consecutive cabinets); `violations=0` because it is soft.

---

## 6. Verifier check ids

Source: `backend/verify/checks.py` (`CHECKS` list, line ~817, and `verify_rows`), `backend/verify/custom.py`, `backend/verify/xlsx.py`.

| Id | Label | Applies when |
|---|---|---|
| C00 | "Workbook has every template column" / "Allocation rows can be read" / "Workbook is a readable allocation" | **Only** when verifying an xlsx (`verify_xlsx`: always added, passes when no column missing) or when rows cannot be parsed (failure). **Not** on in-memory verification. |
| C01 | Every live MDB tag appears exactly once | always |
| C02 | No duplicate CIOC / baseplate / channel | always |
| C03 | No duplicate cable + pair | always |
| C04 | CHARM_No = (baseplate − 1) × 12 + channel | always |
| C05 | Baseplate prefix = CIOC sequence | rule type `naming_pattern` enabled (`r-names`) |
| C06 | Cable pairs contiguous and in order | `cable_contiguous` enabled (`r-cable`) |
| C07, C07.2, C07.3 … | one check **per enabled `segregate` rule** (first is `C07`, then `C07.<n>`) | one per enabled `segregate` rule. Default ruleset: `r-ab` (A/B, CIOC level) = **C07**, `r-is` (IS/NON-IS, baseplate level) = **C07.2** |
| C08 | Each IO grouping kept together, in consecutive cabinets | `group_together` enabled (`r-group`, soft) |
| C09 | CHARM / terminal block match the hardware map | `hardware_map` enabled (`r-hw`) |
| C20 | CHARM TB terminals match the terminal table | `hardware_map` enabled (same rule as C09; listed after C09 in output order) |
| C10 | Names follow the project patterns | `naming_pattern` enabled (`r-names`) |
| C11 | Wired spares ≥ target per IO type per controller | `wired_spare_pct` enabled |
| C12 | Future-spare baseplates kept free at the end of each cabinet | `future_spare_pct` enabled |
| C13 | Full grid present (every slot of every instantiated cabinet) | always |
| C14 | Tag Status discipline | always |
| C15 | Cabinet alarms on the reserved baseplate, exclusively | `reserve_baseplate` enabled |
| C16 | IO type mapped per the IO type map | `io_type_map` enabled |
| C17 | Engineering columns copied from the MDB | `output_map` enabled (soft) |
| C18 | Cabinets and controllers within configured limits | always |
| C19 | CIOC count agrees: allocation rows · BOM · KPIs | always |
| C23, C24, … | dynamic: **one per enabled custom rule** (types `max_per_scope, scope_relation, forbid_mix, zone_cabinets, extra_spares`), ids `C{23+n}` | only if such a rule is enabled. Also `C23` appears as a *failure* "Custom rules can be checked" if the custom-check code itself throws. (C21/C22 are not used.) |

Verified by toggling each rule of the default ruleset (`$S/q6b.py`, base = 21 checks):

```
toggle r-io-map      removed C16          toggle r-group    removed C08     toggle r-hw    removed C09, C20
toggle r-cable       removed C06          toggle r-alarm-bp removed C15     toggle r-names removed C05, C10
toggle r-ab          removed C07.2 *      toggle r-wired-spare removed C11  toggle r-out   removed C17
toggle r-is          removed C07.2 *      toggle r-future   removed C12     toggle r-capacity: nothing removed (always-on checks)
toggle r-uzv (custom_expr, off→on): nothing added   <- see note
* disabling either segregate rule leaves one segregate check, which is renumbered to C07; the set difference shows C07.2 gone.
```

Notes:
- **Why a normal run shows 21, not 20.** The ids C01–C20 are 20 numbers, but the segregate check is emitted **once per enabled `segregate` rule**, and the default ruleset has two (`r-ab`, `r-is`) → `C07` and `C07.2`. Count: C01–C06 (6) + C07, C07.2 (2) + C08, C09, C20 (3) + C10–C19 (10) = **21**. Printed by `$S/q6.py`:
  `['C01','C02','C03','C04','C05','C06','C07','C07.2','C08','C09','C20','C10','C11','C12','C13','C14','C15','C16','C17','C18','C19']`.
  C21 and C22 do not exist in the code. (CLAUDE.md §10.9 mentions "C01…C22" and "20 checks" — both are stale relative to the code.)
- When verifying an **exported xlsx**, `verify_xlsx` adds **C00** → 22 checks (`verify_xlsx on our export: 22 ['C00','C01','C02'] ... C00 present: True`).
- `r-uzv` (type `custom_expr`) is **not** one of the five `CUSTOM_TYPES`, so enabling it adds no C23 check (verified: 21 checks before and after, `$S/q6c.py`). Whether `custom_expr` is enforced/verified anywhere else: **UNVERIFIED**.
- C23 appears only for the new custom types; the existing test `test_custom_rules.py::test_max_per_baseplate_is_obeyed_and_checked` asserts `chk.id == "C23"` for a `max_per_scope` rule. I did not run a live demo of C24+.
- Adversarial MDB also shows 21 checks (`C07.2` included), with `excepted=7`.

---

## 7. Hypothesis (property-based) capacity test

**Exists.** `backend/tests/test_engine.py:234-261` (HEAD copy, verbatim):

```python
@settings(max_examples=3000, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.sampled_from([1, 2, 6, 12, 24]), min_size=1, max_size=40),
       st.integers(min_value=1, max_value=8), st.integers(min_value=0, max_value=4))
def test_capacity_property(sizes, n_usable, offset):
    """Block sizes 1/2/6/12/24 divide each other: if the footprint sum fits the free whole baseplates,
    the deterministic layout always finds an exact placement."""
    usable = list(range(1 + offset, min(9, 1 + offset + n_usable)))
    blocks = [mk_block(i, s) for i, s in enumerate(sizes)]
    total = sum(b.foot for b in blocks)
    result = layout(blocks, usable, G)
    if total <= 12 * len(usable):
        assert result is not None
    if result is not None:
        occ = Counter()
        for b in blocks:
            bp, ch = result[b.id]
            for k in range(b.foot):
                occ[(bp + (ch - 1 + k) // 12, (ch - 1 + k) % 12)] += 1
            if b.span:
                assert ch == 1
            else:
                assert (ch - 1) % b.foot == 0 and ch - 1 + b.foot <= 12
        assert max(occ.values()) == 1
        assert all(bp in usable for bp, _ in occ)
```

Other Hypothesis tests (`grep -rn "@given" backend/tests`), at HEAD:
- `test_engine.py:264` (150 ex.), `:279` (200 ex., junk rows), `:326` (60 ex.) — allocator properties.
- `test_verify.py:201` `test_engine_and_verifier_agree` (120 ex.) and `:219` `test_junk_engine_and_verifier_agree` (500 ex., env `JUNK_EXAMPLES`) — random cable mixes / junk rows → engine and verifier never disagree, never raise.
- `test_fidelity.py:188` (80 ex.), `test_workbench_properties.py` (4 tests, 25–40 ex. each), `test_custom_rules_properties.py:75`.
`hypothesis>=6.170.8` is declared in `backend/pyproject.toml:22`.

---

## 8. Test counts and runtime

Command (HEAD snapshot, from `<snap>/backend`):

```
uv run pytest -q -p no:cacheprovider
```

Real output:

```
........................................................................ [ 24%]
......................
  reference agreement: 30/189 exact addresses (16%), 188/189 same area prefix
.................................................. [ 49%]
........................................................................ [ 74%]
........................................................................ [ 98%]
...                                                                      [100%]
291 passed in 661.58s (0:11:01)
```

| Total | Passing | Failing | Errors/skipped | Runtime |
|---:|---:|---:|---:|---|
| **291** | **291** | **0** | none reported | **661.58 s (11 min 01 s)** wall clock |

Caveats:
- The run was **slow partly because the machine was shared**: a second `pytest -q` process (not mine, from the other session) was running at the same time. Treat 11 min as an upper bound; the Hypothesis tests (3000 + 500 + ... examples) dominate.
- The count is for **commit a15e108**. Commit `2e7ebc4` adds `backend/tests/test_adversarial_fixture.py` (8 tests) and its message says "suite 299 passed"; I did **not** run the suite on `2e7ebc4`, so 299 is the other session's claim (UNVERIFIED by me).
- At a15e108 no test asserted that the adversarial fixture passes the verifier; the failure in §3b was found by running the fixture directly.
- Informative line printed by the suite: `reference agreement: 30/189 exact addresses (16%), 188/189 same area prefix`.

---

## Appendix — what I could not verify (UNVERIFIED)

- Which side (MDB or reference) is "right" about `440-PI-20076-L` vs `...20077-L` — only that they differ.
- Whether `OptimiserPanel` is rendered on any page (defined in `panels.tsx`, no importer found by grep; the running UI was not opened).
- Whether `custom_expr` rules are enforced and verified (they are not among the `CUSTOM_TYPES` that produce C23+).
- Behaviour of the dirty working tree beyond the few runs mentioned in §3b (it was changing during this QA).
- The 10k wall-clock on a different machine, and the browser-side FPS claims (not in scope).
