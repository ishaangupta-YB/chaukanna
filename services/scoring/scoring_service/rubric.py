"""The rubric from PRD section 9. The numbers live there; this file mirrors them.

`tests/test_rubric.py` parses the JSON block straight out of `docs/PRD.md` and asserts these
values match it, so the rubric cannot drift from the document that defines it. Bump
`RUBRIC_VERSION` whenever a weight or a band changes: it is recorded on every score row so an old
score can always be traced to the rubric that produced it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

RUBRIC_VERSION = "prd.v1"

STARTING_SCORE = 50
MIN_SCORE = 0
MAX_SCORE = 100

FLAG_WEIGHTS: dict[str, int] = {
    "stayed_on_call": 25,
    "accepted_secrecy": 20,
    "shared_identifier": 30,
    "agreed_to_move_money": 35,
    "accepted_authority": 10,
}

CREDIT_WEIGHTS: dict[str, int] = {
    "disconnected_early": 30,
    "independent_verify": 25,
    "named_helpline": 15,
}

#: name -> inclusive [low, high]. Ordered worst to best only for readability; lookup is by range.
BANDS: dict[str, tuple[int, int]] = {
    "at_risk": (0, 39),
    "wobbly": (40, 69),
    "safe": (70, 100),
}


class UnknownBand(Exception):
    """A score fell outside every band. Only reachable if BANDS stops covering 0..100."""


@dataclass(frozen=True)
class Rubric:
    flags: dict[str, int] = field(default_factory=lambda: dict(FLAG_WEIGHTS))
    credits: dict[str, int] = field(default_factory=lambda: dict(CREDIT_WEIGHTS))
    bands: dict[str, tuple[int, int]] = field(default_factory=lambda: dict(BANDS))
    version: str = RUBRIC_VERSION

    def flag_weight(self, flag_id: str) -> int | None:
        """None for an id the rubric does not know. The caller ignores it and logs it rather than
        guessing a weight: a model that invented an id must not be able to move a score."""
        return self.flags.get(flag_id)

    def credit_weight(self, credit_id: str) -> int | None:
        return self.credits.get(credit_id)

    def known_flag_ids(self) -> set[str]:
        return set(self.flags)

    def known_credit_ids(self) -> set[str]:
        return set(self.credits)

    def band(self, score: int) -> str:
        for name, (low, high) in self.bands.items():
            if low <= score <= high:
                return name
        raise UnknownBand(f"no band covers {score}")


DEFAULT_RUBRIC = Rubric()
