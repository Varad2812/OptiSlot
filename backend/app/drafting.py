"""Describe a rule in English → a schema-validated Rule DRAFT. AI drafts, it never places.

Provider chain: Claude API (when credentials are present and the network answers) → local Ollama (if running)
→ a deterministic phrase parser (~10 templates). Whatever answers, the output must validate against the Rule
schema and the rule-type checks below, or it is rejected. Nothing is added to the rule set until the engineer
reviews the JSON and clicks Add.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

from app.schemas import Rule, RuleDraft, RuleSet

CLAUDE_MODEL = "claude-opus-5-5"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")

RULE_TYPES = ["segregate", "reserve_baseplate", "wired_spare_pct", "future_spare_pct", "custom_expr", "group_together"]
GUIDE = """You turn an engineer's sentence into ONE OptiSlot allocation rule. Allowed types and params:
- segregate: {"level": "cioc"|"cabinet", "field": "group", "families": {"<NAME>": ["<IO grouping code>", ...], ...}}
- reserve_baseplate: {"purpose": "cabinet_alarm", "cioc": <int>, "baseplate": <int>, "exclusive": true, "match_any": [{"cable": "~(?i)^internal\\\\s*wiring$"}]}
- wired_spare_pct: {"pct": <number>, "rounding": "ceil", "per": ["controller", "io_type"]}
- future_spare_pct: {"pct": <number>, "rounding": "ceil"}
- group_together: {"field": "group", "level": "cabinet", "ignore": ["", "-"]}
- custom_expr: {"expr": "<cond> -> <field> = \\"<value>\\", ..."} where cond uses io_type, signal_type, signal_level,
  instrument_type, instrument_desc, equipment, group, cable, tag with ==, !=, ~= (regex), in [..], not in [..], and/or/not;
  assignable fields: charm, tb, tb1, tb2, tb3, loop_typical.
Hardware: isolated DO = charm "SE4302T02" + tb "SE4502"; standard DO = "SE4302T01" + "SE4501"; AI HART "SE4303T01";
RTD "SE4303T03"; AO "SE4304T01"; DI "SE4301T02". IO types are AIR, AOR, DIR, DOR.
Return the type, a short label, severity "hard" or "soft", and params as a JSON object encoded in a string."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": RULE_TYPES},
        "label": {"type": "string"},
        "severity": {"type": "string", "enum": ["hard", "soft"]},
        "params_json": {"type": "string"},
    },
    "required": ["type", "label", "severity", "params_json"],
    "additionalProperties": False,
}


def _validate(raw: dict, rs: RuleSet) -> Rule:
    params = raw.get("params")
    if params is None:
        params = json.loads(raw.get("params_json") or "{}")
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    taken = {r.id for r in rs.rules}
    base = "r-" + re.sub(r"[^a-z0-9]+", "-", str(raw.get("label", raw.get("type", "rule"))).lower()).strip("-")[:24]
    rid, n = base, 2
    while rid in taken:
        rid, n = f"{base}-{n}", n + 1
    rule = Rule.model_validate({"id": rid, "type": raw["type"], "enabled": True, "severity": raw.get("severity", "hard"),
                                "label": str(raw.get("label") or raw["type"])[:120], "params": params})
    t, p = rule.type, rule.params
    if t == "custom_expr":
        from app.ruleslang import parse_expr
        parse_expr(p.get("expr", ""))
    elif t == "segregate":
        fams = p.get("families")
        if not isinstance(fams, dict) or len(fams) < 2 or not all(isinstance(v, list) and v for v in fams.values()):
            raise ValueError("segregate needs at least two families, each a non-empty list of codes")
    elif t in ("wired_spare_pct", "future_spare_pct"):
        if not 0 <= float(p.get("pct", -1)) <= 100:
            raise ValueError("pct must be between 0 and 100")
    elif t == "reserve_baseplate":
        if int(p.get("baseplate", 0)) < 1 or int(p.get("cioc", 0)) < 1:
            raise ValueError("cioc and baseplate must be ≥ 1")
    elif t not in RULE_TYPES:
        raise ValueError(f"rule type {t} cannot be drafted")
    return rule


# ───────────────────────────── providers ─────────────────────────────

def _claude(text: str) -> dict | None:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return None
    import anthropic
    client = anthropic.Anthropic(timeout=20.0, max_retries=1)
    response = client.beta.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=GUIDE,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        messages=[{"role": "user", "content": text}],
    )
    if response.stop_reason == "refusal":
        return None
    body = next((b.text for b in response.content if b.type == "text"), "")
    return json.loads(body)


def _ollama(text: str) -> dict | None:
    try:
        urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=0.6).read()
    except Exception:
        return None
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps({"model": OLLAMA_MODEL, "stream": False, "format": OUTPUT_SCHEMA,
                         "prompt": f"{GUIDE}\n\nSentence: {text}\nJSON:"}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(json.loads(r.read())["response"])


def _templates(text: str) -> dict | None:
    t = " ".join(text.strip().split())
    low = t.lower()
    num = lambda s: float(s) if "." in s else int(s)  # noqa: E731

    m = re.search(r"never (?:put|mix|place) ([\w\-]+) (?:and|with) ([\w\-]+)(?: signals)? (?:on|in) (?:the )?same (cioc|cabinet)", low)
    if m:
        a, b, lvl = m.group(1).upper(), m.group(2).upper(), m.group(3)
        return {"type": "segregate", "label": f"Never put {a} and {b} on the same {lvl.upper() if lvl == 'cioc' else lvl}",
                "severity": "hard", "params": {"level": lvl, "field": "group", "families": {"A": [a], "B": [b]}}}
    m = re.search(r"(?:wired[ -]?spares?\s*(?:of|to|at|=)?\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*wired[ -]?spares?)", low)
    if m:
        pct = num(m.group(1) or m.group(2))
        return {"type": "wired_spare_pct", "label": f"{pct}% wired spares per IO type per controller", "severity": "hard",
                "params": {"pct": pct, "rounding": "ceil", "per": ["controller", "io_type"]}}
    m = re.search(r"(?:future[ -]?spares?\s*(?:of|to|at|=)?\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*(?:future|free)|keep (\d+(?:\.\d+)?)\s*%\s*(?:of )?(?:the )?baseplates free)", low)
    if m:
        pct = num(next(g for g in m.groups() if g))
        return {"type": "future_spare_pct", "label": f"Keep {pct}% of baseplates free for the future", "severity": "hard",
                "params": {"pct": pct, "rounding": "ceil"}}
    m = re.search(r"reserve baseplate (\d+)(?: of cioc (\d+))? for (?:the )?cabinet alarms?", low)
    if m:
        bp, cioc = int(m.group(1)), int(m.group(2) or 1)
        return {"type": "reserve_baseplate", "label": f"Cabinet alarms on baseplate {bp} of CIOC {cioc}", "severity": "hard",
                "params": {"purpose": "cabinet_alarm", "cioc": cioc, "baseplate": bp, "exclusive": True,
                           "match_any": [{"cable": "~(?i)^internal\\s*wiring$"}, {"equipment": "~(?i)-DC[MS]-"}]}}
    m = re.search(r"(?:instrument type )?([a-z0-9,/ ]+?) (?:uses?|needs?|requires?|gets?|must use) (?:an? )?(isolated|fused|standard|normal|high[ -]side)", low)
    if m:
        types = [x.strip().upper() for x in re.split(r"[,/ ]+(?:and )?|\s+and\s+", m.group(1)) if x.strip() and x.strip() not in ("and", "type", "instrument")]
        iso = m.group(2) in ("isolated", "fused")
        charm, tb = ("SE4302T02", "SE4502") if iso else ("SE4302T01", "SE4501")
        lst = ", ".join(f'"{x}"' for x in types)
        return {"type": "custom_expr", "label": f"{'/'.join(types)} use {'isolated + fused' if iso else 'standard'} DO",
                "severity": "hard",
                "params": {"expr": f'io_type == "DOR" and instrument_type in [{lst}] -> charm = "{charm}", tb = "{tb}"'}}
    m = re.search(r"(?:signal type )?([\w\- ]+?) (?:inputs? |signals? )?(?:uses?|use|needs?) (?:charm )?(se\d{4}t\d{2})", low)
    if m:
        st, charm = m.group(1).strip().upper(), m.group(2).upper()
        return {"type": "custom_expr", "label": f"{st} signals use {charm}", "severity": "hard",
                "params": {"expr": f'signal_type == "{st}" -> charm = "{charm}"'}}
    m = re.search(r"keep (?:each )?(?:io )?group(?:ing)?s? together", low)
    if m:
        return {"type": "group_together", "label": "Keep each IO grouping together in one cabinet", "severity": "soft",
                "params": {"field": "group", "level": "cabinet", "ignore": ["", "-"]}}
    m = re.search(r"([\w\-]+) (?:cables?|signals?) (?:go|goes|must go) (?:to|on) (?:a )?separate cioc", low)
    if m:
        g = m.group(1).upper()
        return {"type": "segregate", "label": f"{g} signals on their own CIOC", "severity": "hard",
                "params": {"level": "cioc", "field": "group", "families": {"A": [g], "B": ["A", "B", "A-CONTROL", "B-ALARM"]}}}
    return None


def draft(text: str, rs: RuleSet) -> RuleDraft:
    if not text.strip():
        return RuleDraft(provider="templates", provider_note="Type a rule in plain English", error="empty text")
    errors = []
    for name, fn, note in (("claude", _claude, f"Claude API ({CLAUDE_MODEL})"),
                           ("ollama", _ollama, f"local Ollama ({OLLAMA_MODEL})")):
        try:
            raw = fn(text)
        except Exception as e:  # offline, timeout, auth, malformed output → fall through
            errors.append(f"{name}: {type(e).__name__}")
            continue
        if raw is None:
            continue
        try:
            return RuleDraft(provider=name, provider_note=note, rule=_validate(raw, rs))  # type: ignore[arg-type]
        except Exception as e:
            errors.append(f"{name} draft rejected by schema: {e}")
    raw = _templates(text)
    note = "AI offline — using rule templates" if not errors else "AI unavailable (" + "; ".join(errors) + ") — using rule templates"
    if raw is None:
        return RuleDraft(provider="templates", provider_note=note,
                         error="No template matches. Try: 'never put A and B on the same CIOC', 'wired spare 15%', "
                               "'keep 12% of baseplates free', 'UZV uses isolated DO', 'reserve baseplate 2 for cabinet alarms'.")
    try:
        return RuleDraft(provider="templates", provider_note=note, rule=_validate(raw, rs))
    except Exception as e:
        return RuleDraft(provider="templates", provider_note=note, error=f"draft rejected by schema: {e}")
