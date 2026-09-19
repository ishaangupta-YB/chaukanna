"""Deterministic stop phrases, checked on the transport alongside the tripwire.

The persona is also told to stop on these (drill.persona.v1 hard limit 5), but a prompt is not a
control. The safe word, "is this real", and signs of distress end the drill from code.

Matching is on whole tokens, not regex word boundaries, because Devanagari vowel signs are not
word characters and `\\b` splits words in the middle.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

StopKind = Literal["safe_word", "is_this_real", "distress"]

# Speech recognition writes the default safe word in either script.
_KNOWN_SAFE_WORD_SPELLINGS = {"roko": {"roko", "रोको", "रोकों"}}

_IS_THIS_REAL = [
    "is this real",
    "is this a real call",
    "is this call real",
    "are you real",
    "real call hai",
    "kya yeh asli",
    "kya ye asli",
    "kya yah asli",
    "yeh asli hai",
    "ye asli hai",
    "asli call",
    "sach mein police",
    "kya yeh sach",
    "kya ye sach",
    "क्या यह असली",
    "क्या ये असली",
    "असली कॉल",
    "क्या यह सच",
    "क्या ये सच",
]
_DISTRESS = [
    "i am scared",
    "i'm scared",
    "im scared",
    "i am afraid",
    "help me",
    "please stop",
    "i feel sick",
    "chest pain",
    "can't breathe",
    "cannot breathe",
    "dar lag raha",
    "dar lag rahi",
    "darr lag",
    "mujhe dar",
    "ghabrahat",
    "ghabra rahi",
    "ghabra raha",
    "chakkar aa",
    "seene mein dard",
    "sine me dard",
    "saans nahi",
    "tabiyat kharab",
    "bachao",
    "ro rahi",
    "ro raha",
    "bp badh",
    "मुझे डर",
    "डर लग",
    "घबराहट",
    "घबरा रही",
    "घबरा रहा",
    "चक्कर आ",
    "सीने में दर्द",
    "सांस नहीं",
    "साँस नहीं",
    "तबीयत खराब",
    "तबियत खराब",
    "बचाओ",
    "रो रही",
    "रो रहा",
]
_TOKEN = re.compile(r"[^\s,.;:!?।|/\\()\[\]{}\"“”‘’\-–—_+*#=<>]+")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(unicodedata.normalize("NFKC", text).lower())


def _phrase_tokens(phrases: list[str]) -> list[tuple[str, ...]]:
    return [tuple(_tokens(p)) for p in phrases]


def _contains(tokens: list[str], phrase: tuple[str, ...]) -> bool:
    n = len(phrase)
    return any(tuple(tokens[i : i + n]) == phrase for i in range(len(tokens) - n + 1))


@dataclass(frozen=True)
class Stop:
    kind: StopKind


class StopPhrases:
    """Built once per drill from the configured safe word."""

    def __init__(self, safe_word: str, extra_spellings: list[str] | None = None) -> None:
        base = safe_word.strip().lower()
        spellings = {
            base,
            *_KNOWN_SAFE_WORD_SPELLINGS.get(base, set()),
            *(s.strip().lower() for s in extra_spellings or []),
        }
        self._safe = [tuple(_tokens(s)) for s in spellings if s]
        self._real = _phrase_tokens(_IS_THIS_REAL)
        self._distress = _phrase_tokens(_DISTRESS)

    def check(self, text: str) -> Stop | None:
        tokens = _tokens(text)
        if any(_contains(tokens, p) for p in self._safe):
            return Stop("safe_word")
        if any(_contains(tokens, p) for p in self._real):
            return Stop("is_this_real")
        if any(_contains(tokens, p) for p in self._distress):
            return Stop("distress")
        return None
