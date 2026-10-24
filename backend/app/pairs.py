"""What counts as a pair number in an MDB cell — ONE grammar, shared by the normaliser and the verifier.

Accepted (case-insensitive, surrounding whitespace ignored): "Pair 3", "PAIR  3", "P3", "P-3", "Pair-3", "Pair_3",
"Pair No. 3", "Pair #3", "Triad 1", "PR3", "#3", "3", "03", "3.0", "3,0".
Never guessed: ranges ("3-5"), several numbers ("3 4", "3/4"), 0, negatives ("-3"), non-integers ("3.5"), more than four
digits, and text with no digits. The caller turns those into an "Unreadable pair" TQ."""
from __future__ import annotations

import re

_WORD = r"(?:(?:pair|triad)(?:\s*no\.?)?|pr|p)"              # a leading word; "-" and "_" may join it to the number
_NUM = r"(\d{1,4})(?:[.,]0+)?"                                # 3, 03, 3.0, 3,0
PAIR_RX = re.compile(rf"(?:{_WORD}[-_]?\s*#?\s*|#\s*)?{_NUM}", re.I | re.ASCII)


def parse_pair_text(text: str | None) -> int | None:
    """The pair number written in a cell, or None when it is empty or not one clean positive integer."""
    m = PAIR_RX.fullmatch(str(text if text is not None else "").strip())
    if not m:
        return None
    n = int(m.group(1))
    return n if n > 0 else None
