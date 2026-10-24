"""Deterministic English → rule parser. No network, no model; covers the common phrasings.

Returns (candidates, clarifying_question). A candidate is a plain dict {rule_type, params, severity, label, readback,
confidence, warnings}; the caller validates it with the same validator as POST /rules.
"""
from __future__ import annotations

import re

IO_WORDS = {
    "AIR": ["ai", "air", "analog input", "analogue input", "analog inputs", "analogue inputs", "4-20ma input"],
    "AOR": ["ao", "aor", "analog output", "analogue output", "analog outputs", "analogue outputs"],
    "DIR": ["di", "dir", "digital input", "digital inputs"],
    "DOR": ["do", "dor", "digital output", "digital outputs"],
}
_IO_LOOKUP = {w: k for k, ws in IO_WORDS.items() for w in ws}
_SCOPE_RE = r"(base\s?plates?|ciocs?|cabinets?)"
_NUM_WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "eight": 8, "ten": 10, "twelve": 12}


def _scope(s: str) -> str:
    t = re.sub(r"\s+", "", s.lower()).rstrip("s")
    return "baseplate" if t.startswith("base") else t


def _num(s: str) -> int | None:
    s = s.lower().strip()
    return int(s) if s.isdigit() else _NUM_WORDS.get(s)


def term_filter(term: str) -> dict | None:
    """A noun phrase → a filter dict, or None when it cannot be read safely."""
    t = term.strip().strip(".,;:\"'").strip()
    t = re.sub(r"^(all|the|any|every)\s+", "", t, flags=re.I)
    t = re.sub(r"\s+(signals?|tags?|channels?|charms?)$", "", t, flags=re.I)
    low = t.lower()
    if low in _IO_LOOKUP:
        return {"io_type": _IO_LOOKUP[low]}
    m = re.match(r"^(?:instrument(?: type)?|type)\s+([A-Za-z]{2,6})$", t, flags=re.I)
    if m:
        return {"instrument_type": m.group(1).upper()}
    m = re.match(r"^(?:group|segregation)\s+(\S+)$", t, flags=re.I)
    if m:
        return {"group": m.group(1)}
    if re.search(r"[*?]", t) or (re.search(r"\d", t) and "-" in t):
        return {"tag": t}
    if re.fullmatch(r"[A-Z]{2,5}", t):
        return {"instrument_type": t}
    return None


def _io_list(s: str) -> list[str] | None:
    parts = [p for p in re.split(r"\s*(?:,|/|\band\b|\bor\b|&)\s*", s.strip()) if p]
    out = []
    for p in parts:
        f = term_filter(p)
        if not f or set(f) != {"io_type"}:
            return None
        out.append(f["io_type"])
    return out or None


def _cand(rule_type, params, label, readback, confidence=0.8, severity="hard", warnings=None):
    return {"rule_type": rule_type, "params": params, "severity": severity, "label": label[:200], "readback": readback,
            "confidence": confidence, "warnings": warnings or []}


def parse(text: str) -> tuple[list[dict], str | None]:
    raw = " ".join((text or "").split())[:500]
    s = raw.rstrip(".! ")
    if not s:
        return [], "What rule would you like? For example: \"no more than 8 AI per baseplate\"."
    severity = "soft" if re.search(r"\b(prefer|ideally|advisory|if possible|should)\b", s, re.I) else "hard"

    # keep X and Y on different CIOCs / never on the same ...
    m = (re.match(rf"^(?:keep|put|place)\s+(.+?)\s+(?:and|from|away from|apart from)\s+(.+?)\s+(?:on|in)\s+(?:different|separate|distinct)\s+{_SCOPE_RE}$", s, re.I)
         or re.match(rf"^(?:never|do not|don't)\s+(?:put|place|keep)\s+(.+?)\s+(?:and|with)\s+(.+?)\s+(?:on|in)\s+the\s+same\s+{_SCOPE_RE}$", s, re.I))
    if m:
        a, b, sc = term_filter(m.group(1)), term_filter(m.group(2)), _scope(m.group(3))
        if a is None or b is None:
            return [], (f"I could not tell which signals \"{m.group(1) if a is None else m.group(2)}\" means. "
                        "Name an IO type (AI, DO …), an instrument type (XYV), or a tag pattern like 320-FT*.")
        return [_cand("scope_relation", {"filter_a": a, "filter_b": b, "scope": sc, "relation": "different"},
                      f"Keep {m.group(1)} and {m.group(2)} on different {sc}s",
                      f"{_fdesc(a)} and {_fdesc(b)} never share a {sc}.", 0.85, severity)], None

    # never mix A and B on a baseplate / cioc   (families) or never mix AI and DI (io types)
    m = re.match(rf"^(?:never\s+|do not\s+|don't\s+)?(?:mix|combine|put)\s+(.+?)\s+(?:and|with)\s+(.+?)\s+(?:on|in)\s+(?:the\s+same\s+|one\s+|a\s+|an\s+|any\s+)?{_SCOPE_RE}$", s, re.I)
    if m:
        sc = _scope(m.group(3))
        t1, t2 = m.group(1).strip(), m.group(2).strip()
        fam = {re.sub(r"(?i)\s*(family|segregation|signals?)$", "", t).strip().upper() for t in (t1, t2)}
        if fam == {"A", "B"} and sc in ("baseplate", "cioc", "cabinet"):
            return [_cand("segregate", {"level": sc, "field": "group",
                                        "families": {"A": ["A", "A-CONTROL"], "B": ["B", "B-ALARM"]}},
                          f"Never mix A and B on a {sc}", f"A-family and B-family signals never share a {sc}.", 0.85, severity)], None
        ia, ib = _io_list(t1), _io_list(t2)
        if ia and ib and sc in ("baseplate", "cioc"):
            return [_cand("forbid_mix", {"io_type_a": ia, "io_type_b": ib, "scope": sc}, f"No {'/'.join(ia)} with {'/'.join(ib)} on a {sc}",
                          f"{'/'.join(ia)} and {'/'.join(ib)} never meet on one {sc}.", 0.85, severity)], None
        fa, fb = term_filter(t1), term_filter(t2)
        if fa and fb:
            return [_cand("scope_relation", {"filter_a": fa, "filter_b": fb, "scope": sc, "relation": "different"},
                          f"Never mix {t1} and {t2} on a {sc}", f"{_fdesc(fa)} and {_fdesc(fb)} never share a {sc}.", 0.7, severity)], None
        return [], "Which two kinds of signal should never mix? Name IO types (AI, DI), families (A, B) or tag patterns."

    # no more than N <io type> per baseplate/cioc/cabinet
    m = re.match(rf"^(?:no more than|not more than|at most|max(?:imum)?(?: of)?|up to|limit(?:ed)? to|only)\s+(\w+)\s+(.+?)\s+(?:per|on a|on each|in a|in each|on any|in any|on one)\s+{_SCOPE_RE}$", s, re.I)
    if m:
        n, f, sc = _num(m.group(1)), term_filter(m.group(2)), _scope(m.group(3))
        if n is None:
            return [], f"How many exactly? \"{m.group(1)}\" is not a number."
        if f is None:
            return [], f"I could not tell which signals \"{m.group(2)}\" means. Name an IO type (AI, DO …), an instrument type (XYV), or a tag pattern."
        return [_cand("max_per_scope", {"filter": f, "scope": sc, "max": n}, f"At most {n} {m.group(2)} per {sc}",
                      f"No {sc} holds more than {n} of {_fdesc(f)}.", 0.9, severity)], None

    # reserve N% spares for <io>
    m = re.match(r"^(?:reserve|keep|add|hold|provide)\s+(?:an?\s+extra\s+|extra\s+)?(\d+(?:\.\d+)?)\s*(%|percent|pct)?\s*(?:extra\s+)?(?:wired\s+)?spares?\s+(?:for|on|of)\s+(.+)$", s, re.I)
    if m:
        io = _io_list(m.group(3))
        if not io or len(io) != 1:
            return [], "Which IO type are the spares for? One of AI, AO, DI, DO."
        pct = float(m.group(1))
        if not m.group(2):
            return [_cand("extra_spares", {"io_type": io[0], "extra_count": int(pct)}, f"{int(pct)} extra {io[0]} wired spares",
                          f"Keep {int(pct)} extra wired {io[0]} spares per controller.", 0.6, severity,
                          ["No % sign — read as a count; say \"10%\" if you meant a percentage."])], None
        return [_cand("extra_spares", {"io_type": io[0], "extra_pct": pct}, f"{pct:g}% extra {io[0]} wired spares",
                      f"Keep {pct:g}% extra wired {io[0]} spares per controller, on top of the global percentage.", 0.85, severity)], None

    # tags matching <glob> only in cabinet <name>
    m = re.match(r"^(?:tags?|signals?)\s+(?:matching|like|named|that match)\s+(\S+)\s+(?:only\s+)?(?:go\s+|must\s+go\s+|belong\s+|stay\s+|sit\s+)?(?:only\s+)?(?:in|on|to)\s+cabinets?\s+(.+)$", s, re.I)
    if m:
        cabs = [c for c in re.split(r"\s*(?:,|\band\b|\bor\b)\s*", m.group(2).strip()) if c]
        cabs = [int(c) if c.isdigit() else c for c in cabs]
        return [_cand("zone_cabinets", {"filter": {"tag": m.group(1)}, "cabinets": cabs}, f"{m.group(1)} only in cabinet {m.group(2)}",
                      f"Signals matching {m.group(1)} may only be placed in cabinet(s) {', '.join(map(str, cabs))}.", 0.85, severity)], None

    return [], ("I did not understand that rule. Try one of: \"keep AI and DI on different CIOCs\", \"no more than 8 AI per baseplate\", "
                "\"never mix A and B on a baseplate\", \"reserve 10% spares for AI\", \"tags matching 320-FT* only in cabinet 4\".")


def _fdesc(f: dict) -> str:
    return " & ".join(f"{k} {v}" for k, v in f.items())
