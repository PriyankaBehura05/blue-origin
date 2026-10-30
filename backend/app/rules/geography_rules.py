"""
Geography rules: state normalisation and pincode checks.

Principle: never guess. Unknown states / mismatching pincodes are returned as
needs_review for a human to confirm. Region mapping is empty until the business defines it.
"""
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

from app.core.constants import RecordStatus

CONFIG_PATH = Path(__file__).parent / "config" / "geography.json"
PINCODE_RE = re.compile(r"^[1-9][0-9]{5}$")


@dataclass(frozen=True)
class GeoCheck:
    value: Optional[str]
    status: RecordStatus
    note: Optional[str] = None


@lru_cache
def get_geography_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@lru_cache
def _state_lookup() -> dict:
    cfg = get_geography_config()
    lookup = {s.lower(): s for s in cfg["states"]}
    lookup.update({k.lower(): v for k, v in cfg.get("state_aliases", {}).items()})
    return lookup


def normalize_state(raw: Optional[str]) -> GeoCheck:
    if raw is None or str(raw).strip() == "":
        return GeoCheck(None, RecordStatus.MISSING, "State is blank.")
    key = re.sub(r"\s+", " ", str(raw).strip()).lower()
    canonical = _state_lookup().get(key)
    if canonical:
        return GeoCheck(canonical, RecordStatus.VALID)
    return GeoCheck(str(raw).strip(), RecordStatus.NEEDS_REVIEW, f"Unrecognised state '{raw}'.")


def normalize_pincode(raw) -> GeoCheck:
    """Accepts 560001, '560001', '560 001', 560001.0 (Excel float). Returns a 6-char string."""
    if raw is None or str(raw).strip() == "":
        return GeoCheck(None, RecordStatus.MISSING, "Pincode is blank.")
    s = str(raw).strip()
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".")[0]
    s = s.replace(" ", "")
    if PINCODE_RE.match(s):
        return GeoCheck(s, RecordStatus.VALID)
    return GeoCheck(str(raw).strip(), RecordStatus.INVALID, f"'{raw}' is not a valid 6-digit Indian pincode.")


def pincode_matches_state(pincode: str, state: str) -> Optional[bool]:
    """True/False when the reference prefix table covers the pincode, None when it cannot tell."""
    allowed = get_geography_config().get("pincode_prefix_states", {}).get(pincode[:2])
    if not allowed:
        return None
    return state in allowed


def region_for_state(state: Optional[str]) -> Optional[str]:
    """Returns None until the business defines state_to_region in geography.json."""
    if not state:
        return None
    return get_geography_config().get("state_to_region", {}).get(state)
