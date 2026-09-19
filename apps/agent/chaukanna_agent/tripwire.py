"""The tripwire. Runs on the transport, on every user transcript fragment, before anything is
stored, independent of the model. The model's own `tripwire` tool is a second, weaker net.

Fire first, ask later. A false positive ends a drill early, which costs nothing. A false negative
stores a real number, which is the one unacceptable outcome in this product.

What trips:
- six or more digits in one run, spoken as numerals (ASCII or Devanagari) or as number words in
  English, romanized Hindi, Devanagari Hindi, or English words written in Devanagari
- a spelled identifier: a run of letters and digits with at least three digits and eight or more
  characters, which catches PAN-style reads such as "A B C D E 1 2 3 4 F"
- a written PAN, a UPI handle, or "at the rate" (how @ is read aloud)
- three or more digits right after OTP, PIN, CVV or password
A run continues across fragments that arrive close together, because speech recognition splits
long numbers.
"""

from __future__ import annotations

import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

TripKind = Literal["digits", "spelled_identifier", "pan_like", "upi_like", "otp"]

MIN_DIGIT_RUN = 6
MIN_SPELLED_LENGTH = 8
MIN_SPELLED_DIGITS = 3
MIN_SECRET_DIGITS = 3
# A digit run keeps counting across fragments that arrive within this many seconds.
RUN_CARRY_SECONDS = 8.0

# Digit value 1 unless noted. Tens and teens are read as two digits ("ninety eight").
_ONE_DIGIT_WORDS = {
    # English
    "zero",
    "oh",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    # romanized Hindi, including common ASR spellings
    "shunya",
    "sunya",
    "shoonya",
    "ek",
    "do",
    "teen",
    "tin",
    "char",
    "chaar",
    "paanch",
    "panch",
    "paach",
    "chhe",
    "chhah",
    "chah",
    "che",
    "chhai",
    "saat",
    "sat",
    "aath",
    "ath",
    "nau",
    "no",
    # Devanagari Hindi
    "शून्य",
    "एक",
    "दो",
    "तीन",
    "चार",
    "पांच",
    "पाँच",
    "छह",
    "छः",
    "छे",
    "छै",
    "सात",
    "आठ",
    "नौ",
    # English digit words as Hindi speech recognition writes them
    "ज़ीरो",
    "जीरो",
    "वन",
    "टू",
    "थ्री",
    "फोर",
    "फ़ोर",
    "फाइव",
    "फ़ाइव",
    "सिक्स",
    "सेवन",
    "एट",
    "ऐट",
    "नाइन",
}
_TWO_DIGIT_WORDS = {
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fourty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
    "das",
    "gyarah",
    "gyara",
    "barah",
    "bara",
    "terah",
    "chaudah",
    "pandrah",
    "solah",
    "satrah",
    "atharah",
    "unnis",
    "bees",
    "tees",
    "chalis",
    "chaalis",
    "pachas",
    "pachaas",
    "saath",
    "sattar",
    "assi",
    "nabbe",
    "दस",
    "ग्यारह",
    "बारह",
    "तेरह",
    "चौदह",
    "पंद्रह",
    "पन्द्रह",
    "सोलह",
    "सत्रह",
    "अठारह",
    "उन्नीस",
    "बीस",
    "तीस",
    "चालीस",
    "पचास",
    "साठ",
    "सत्तर",
    "अस्सी",
    "नब्बे",
    # "double five" is two digits: count double as the extra one, the digit word counts itself
    "double",
    "डबल",
}
_THREE_DIGIT_WORDS = {"triple", "ट्रिपल"}  # "triple" adds two, the digit word adds the third
# Fillers that do not break a run of spoken digits.
_RUN_FILLERS = {"and", "aur", "or", "uh", "um", "umm", "hmm", "haan", "ha", "फिर", "और", "हाँ", "हां", "phir", "fir"}
_SECRET_WORDS = re.compile(r"\b(otp|o\s*t\s*p|pin|cvv|password|passcode)\b|ओटीपी|पिन|पासवर्ड", re.IGNORECASE)

_PAN = re.compile(r"\b[a-z]{5}\s?[0-9]{4}\s?[a-z]\b", re.IGNORECASE)
_UPI = re.compile(r"[a-z0-9._\-]{2,}@[a-z]{2,}", re.IGNORECASE)
_AT_THE_RATE = re.compile(r"\bat\s+the\s+rate\b|एट\s+द\s+रेट|ऐट\s+द\s+रेट", re.IGNORECASE)
_TOKEN = re.compile(r"[^\s,.;:!?।|/\\()\[\]{}\"'“”‘’\-–—_+*#=<>]+")


@dataclass(frozen=True)
class Trip:
    kind: TripKind


def _normalize(text: str) -> str:
    # NFKC folds full width digits; Devanagari digits are mapped explicitly below.
    text = unicodedata.normalize("NFKC", text)
    return text.translate(str.maketrans("०१२३४५६७८९", "0123456789")).lower()


def _digit_value(token: str) -> int | None:
    """Digits a token contributes to a run, or None when it is not number-like."""
    if token.isdigit():
        return len(token)
    if token in _ONE_DIGIT_WORDS:
        return 1
    if token in _TWO_DIGIT_WORDS:
        return 2 if token not in {"double", "डबल"} else 1
    if token in _THREE_DIGIT_WORDS:
        return 2
    digits = sum(ch.isdigit() for ch in token)
    return digits if digits else None


@dataclass
class _Run:
    digits: int = 0
    chars: int = 0
    last_at: float = 0.0

    def reset(self) -> None:
        self.digits = 0
        self.chars = 0


@dataclass
class Tripwire:
    """Stateful matcher for one speaker. Feed every user fragment, in order, to `check`."""

    clock: Callable[[], float] = time.monotonic
    _run: _Run = field(default_factory=_Run)

    def check(self, fragment: str) -> Trip | None:
        now = self.clock()
        if now - self._run.last_at > RUN_CARRY_SECONDS:
            self._run.reset()
        self._run.last_at = now

        text = _normalize(fragment)
        if _PAN.search(text):
            return Trip("pan_like")
        if _UPI.search(text) or _AT_THE_RATE.search(text):
            return Trip("upi_like")

        secret_context = bool(_SECRET_WORDS.search(text))
        for token in _TOKEN.findall(text):
            value = _digit_value(token)
            if value is not None:
                self._run.digits += value
                self._run.chars += len(token) if token.isalnum() and not token.isalpha() else 1
            elif len(token) == 1 and token.isalpha():
                # A spelled letter extends a run only as part of an identifier.
                self._run.chars += 1
            elif token in _RUN_FILLERS:
                continue
            else:
                self._run.reset()
                continue

            if self._run.digits >= MIN_DIGIT_RUN:
                return Trip("digits")
            if self._run.chars >= MIN_SPELLED_LENGTH and self._run.digits >= MIN_SPELLED_DIGITS:
                return Trip("spelled_identifier")
            if secret_context and self._run.digits >= MIN_SECRET_DIGITS:
                return Trip("otp")
        return None


def trips(fragment: str) -> bool:
    """Stateless check of one complete string, used for quotes and stored text."""
    return Tripwire(clock=lambda: 0.0).check(fragment) is not None


REDACTED = "[redacted]"


def redact(text: str) -> str:
    """Anything the tripwire would fire on is dropped whole before it is written anywhere.
    Short numbers such as 1930 survive, because the scoring rubric credits naming the helpline."""
    return REDACTED if trips(text) else text
