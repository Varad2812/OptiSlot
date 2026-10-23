"""OptiSlot API contract — the single source of truth for every shape that crosses a boundary.

The engine, the verifier, the API and the generated TypeScript types (frontend/src/api/types.ts)
all use these models. Change a model here, then run `make types`.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ENGINE_VERSION = "optislot-0.1.0"

TagStatus = Literal["Field", "Wired Spare", "Spare Slot", "Cabinet Alarm"]
Severity = Literal["critical", "high", "medium", "low", "info"]
RuleSeverity = Literal["hard", "soft"]
TQStatus = Literal["open", "applied", "closed"]
Confidence = Literal["confirmed", "candidate"]
RuleType = Literal[
    "capacity", "cable_contiguous", "group_together", "segregate", "reserve_baseplate",
    "wired_spare_pct", "future_spare_pct", "hardware_map", "io_type_map", "naming_pattern",
    "output_map", "custom_expr",
]
SignalKind = Literal["field", "cabinet_alarm"]
Family = Literal["A", "B", "-"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ───────────────────────────── rules ─────────────────────────────

class Rule(Model):
    id: str
    type: RuleType
    enabled: bool = True
    severity: RuleSeverity = "hard"
    label: str
    params: dict[str, Any] = Field(default_factory=dict)


class RuleSet(Model):
    id: str
    name: str
    version: int = 1
    description: str = ""
    rules: list[Rule]


class DecisionEntry(Model):
    ts: str
    who: str = "engineer"
    why: str
    tq_id: str | None = None
    rule_id: str | None = None
    patch: dict[str, Any] | None = None
    ruleset_version: int | None = None


# ───────────────────────────── project ─────────────────────────────

class ProjectSettings(Model):
    """Hidden-test safety net: defaults so that missing data never blocks allocation."""
    loc_prefix_default: str = "P01"
    area_code_default: str = "10001"
    domain_keys: list[str] = Field(default_factory=lambda: ["room", "area"])
    ciocs_per_cabinet: int = 4
    baseplates_per_cioc: int = 8
    channels_per_baseplate: int = 12
    max_cabinets_per_controller: int = 1
    max_cabinets_per_domain: int = 99
    revision: str = "00"
    cpsat_enabled: bool = True
    cpsat_time_limit_s: float = 2.0


class ColumnMapping(Model):
    field: str
    label: str
    source: str | None = None
    confidence: float = 0.0
    required: bool = False
    overridden: bool = False


class ImportSummary(Model):
    file: str
    sheet: str
    header_row: int
    rows: int
    live_rows: int
    quarantined: int
    mapping: list[ColumnMapping]
    preview: list[dict[str, str]] = Field(default_factory=list)
    sha256: str


class Project(Model):
    id: str
    name: str
    revision: str = "A"
    revisions: list[str] = Field(default_factory=lambda: ["A"])
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    ruleset_id: str = "default"
    ruleset_version: int = 1
    mdb_file: str | None = None
    created: str
    updated: str


# ───────────────────────────── normalised input ─────────────────────────────

class Signal(Model):
    """One normalised MDB row (live or not). Raw passthrough values live in `extra`."""
    row: int                     # 1-based Excel row in the source sheet
    tag: str                     # original spelling
    tag_key: str                 # whitespace removed
    status: str = ""             # New / Modified / DELETED / ...
    live: bool = True
    kind: SignalKind = "field"
    io_type_raw: str = ""
    io_type: str = ""            # mapped AIR/AOR/DIR/DOR ('' when unmapped)
    signal_type: str = "-"
    signal_level: str = "-"
    instrument_type: str = "-"
    instrument_desc: str = "-"
    equipment: str = "-"
    room: str = "-"
    area: str = "-"
    loc: str = ""
    area_code: str = ""
    area4: str = ""
    domain: str = ""
    cable: str = ""
    cable_spec: str = "-"
    cable_size: int | None = None
    pair: int | None = None
    pair_label: str = "-"
    group: str = "-"
    family: Family = "-"
    extra: dict[str, str] = Field(default_factory=dict)
    quarantined: bool = False
    quarantine_reason: str | None = None


# ───────────────────────────── allocation ─────────────────────────────

class WhyStep(Model):
    rule_id: str | None = None
    text: str


class Slot(Model):
    id: str                      # "<cabinet>/<cioc3>/<bp>/<ch>"
    cabinet: str                 # marshalling cabinet name
    cabinet_seq: int
    system_cabinet: str
    controller: str
    controller_seq: int
    domain: str
    cioc: str
    cioc_seq: int
    cioc_local: int              # 1..ciocs_per_cabinet
    side: str
    baseplate: str
    bp: int
    ch: int
    charm_no: int
    status: TagStatus
    tag: str = "-"
    tag_key: str = ""
    io_type: str = "-"
    family: Family = "-"
    group: str = "-"
    cable: str = "-"
    cable_spec: str = "-"
    cable_size: int | None = None
    pair: int | None = None
    pair_label: str = "-"
    block_id: str | None = None
    charm: str = "SE6103"
    charm_desc: str = ""
    tb: str = "SE4501"
    tb_desc: str = ""
    tb1: str = "-"
    tb2: str = "-"
    tb3: str = "-"
    loop_typical: str = "-"
    signal_type: str = "-"
    signal_level: str = "-"
    service: str = "-"
    instrument_type: str = "-"
    reserved: Literal["cabinet_alarm", "future"] | None = None
    source_row: int | None = None
    revision: str = "00"
    change_type: str = "-"
    old_tag: str = "-"
    remarks: str = "-"
    pinned: bool = False
    tq_ids: list[str] = Field(default_factory=list)
    why: list[WhyStep] = Field(default_factory=list)


class BaseplateInfo(Model):
    bp: int
    name: str
    reserved: Literal["cabinet_alarm", "future"] | None = None
    used: int = 0
    wired_spares: int = 0


class CiocInfo(Model):
    name: str
    seq: int
    local: int
    side: str
    family: Family = "-"
    used: int = 0
    wired_spares: int = 0
    capacity: int = 96
    baseplates: list[BaseplateInfo]


class CabinetInfo(Model):
    name: str
    seq: int
    system_cabinet: str
    controller: str
    controller_seq: int
    domain: str
    loc: str
    area_code: str
    declared: bool = False       # declared by cabinet-alarm rows in the MDB
    ciocs: list[CiocInfo]


class FixOption(Model):
    label: str
    rule_patch: dict[str, Any] | None = None   # {"rule_id": ..., "op": "...", ...}
    data_patch: dict[str, Any] | None = None   # {"row": N, "field": ..., "value": ...}


class TQ(Model):
    id: str
    category: str
    severity: Severity
    status: TQStatus = "open"
    confidence: Confidence = "confirmed"
    rows: list[int] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    field: str | None = None
    rules_in_conflict: list[str] = Field(default_factory=list)
    message: str
    fix_options: list[FixOption] = Field(default_factory=list)
    unchanged_note: str = ""
    slot_ids: list[str] = Field(default_factory=list)
    decision: str | None = None


class QuarantineRow(Model):
    row: int
    tag: str
    reason: str
    tq_id: str | None = None
    values: dict[str, str] = Field(default_factory=dict)


class Violation(Model):
    row: int | None = None       # Excel row in the allocation sheet
    tag: str | None = None
    slot_id: str | None = None
    message: str


class CheckResult(Model):
    id: str
    label: str
    rule_id: str | None = None
    severity: RuleSeverity = "hard"
    passed: int = 0
    failed: int = 0
    excepted: int = 0
    violations: list[Violation] = Field(default_factory=list)
    exceptions: list[Violation] = Field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.failed == 0


class RuleCheckReport(Model):
    source: Literal["memory", "file"] = "memory"
    file: str | None = None
    checks: list[CheckResult]
    checks_total: int
    checks_passed: int
    violations: int              # hard-rule failures only
    warnings: int = 0            # soft-rule failures
    excepted: int = 0            # covered by a TQ
    verdict: Literal["PASS", "FAIL"]


class Certificate(Model):
    run_id: str
    timestamp: str
    engine_version: str = ENGINE_VERSION
    mdb_sha256: str
    ruleset_hash: str
    output_sha256: str
    verdict: Literal["PASS", "FAIL"]
    checks_passed: int
    checks_total: int
    violations: int


class SpareCompliance(Model):
    controller: str
    io_type: str
    field: int
    wired: int
    target: int
    pct: float
    ok: bool


class CabinetSpares(Model):
    cabinet: str
    controller: str
    used: int
    wired_spares: int
    spare_slots: int
    empty_baseplates: int
    future_baseplates: int
    fill_pct: float


class Kpis(Model):
    signals: int                 # live signals in the MDB
    allocated: int
    allocated_pct: float         # (allocated + TQ-explained) / live
    unallocated_with_tq: int
    tqs_open: int
    violations: int
    cabinets: int
    ciocs: int
    baseplates_used: int
    fill_pct: float
    wired_spares: int
    wired_target: int
    stability_pct: float | None = None
    status_counts: dict[str, int]
    tq_by_category: dict[str, int]
    spare_compliance: list[SpareCompliance]
    spares_per_cabinet: list[CabinetSpares]
    hardware_bom: dict[str, int] = Field(default_factory=dict)


class OptimiserInfo(Model):
    method: Literal["greedy", "cpsat"] = "greedy"
    greedy_ciocs: int
    cpsat_ciocs: int | None = None
    adopted: bool = False
    status: str = "not run"
    time_ms: float = 0.0
    note: str = ""


class ActivityEvent(Model):
    ts: str
    kind: Literal["import", "allocate", "verify", "tq", "rule", "revision", "export", "whatif"]
    text: str


class AllocationResult(Model):
    project_id: str
    revision: str
    run_id: str
    cabinets: list[CabinetInfo]
    slots: list[Slot]
    tqs: list[TQ]
    quarantine: list[QuarantineRow]
    kpis: Kpis
    report: RuleCheckReport
    certificate: Certificate
    optimiser: OptimiserInfo
    runtime_ms: float
    activity: list[ActivityEvent] = Field(default_factory=list)


class RunRecord(Model):
    run_id: str
    project_id: str
    timestamp: str
    revision: str
    kind: Literal["allocate", "revision", "verify-file", "stress"] = "allocate"
    mdb_sha256: str
    ruleset_hash: str
    output_sha256: str
    engine_version: str = ENGINE_VERSION
    verdict: Literal["PASS", "FAIL"]
    violations: int
    signals: int
    runtime_ms: float


# ───────────────────────────── interaction ─────────────────────────────

class Move(Model):
    block_id: str | None = None  # move a whole cable block …
    slot_id: str | None = None   # … or a single slot
    target_cioc: str
    target_bp: int
    target_ch: int = 1


class WhatIfRequest(Model):
    moves: list[Move] = Field(default_factory=list)
    rule_toggles: dict[str, bool] = Field(default_factory=dict)
    params: dict[str, dict[str, Any]] = Field(default_factory=dict)


class SlotDiff(Model):
    tag: str
    from_slot: str | None = None
    to_slot: str | None = None
    change: Literal["moved", "added", "removed", "hardware"]
    reason: str = ""


class WhatIfResult(Model):
    allowed: bool
    blocked_reason: str | None = None
    kpis: Kpis
    report: RuleCheckReport
    moves: int
    diff: list[SlotDiff]
    slots: list[Slot] = Field(default_factory=list)


class MoveItem(Model):
    tag: str
    from_slot: str | None = None
    to_slot: str | None = None
    reason: str


class RevisionImpact(Model):
    from_rev: str
    to_rev: str
    added: list[MoveItem]
    deleted: list[MoveItem]
    modified: list[MoveItem]
    moved: list[MoveItem]
    unchanged_in_place: int
    previous_live: int
    stability_pct: float
    cabinets_touched: list[str]
    new_tqs: list[str] = Field(default_factory=list)


class RuleDraft(Model):
    provider: Literal["claude", "ollama", "templates"]
    provider_note: str
    rule: Rule | None = None
    error: str | None = None


class ExportFile(Model):
    kind: Literal["allocation", "rule_check", "tq_register", "revision_impact", "capacity_bom"]
    filename: str
    rows: int
    sha256: str | None = None


class StressResult(Model):
    n: int
    signals: int
    allocate_ms: float
    verify_ms: float
    total_ms: float
    cabinets: int
    violations: int
    tqs: int
