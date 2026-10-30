"""
Tier rules - the ONLY place tier boundaries are interpreted.

Thresholds come from app/rules/config/tiers.json. Change them there; nothing else
in the codebase holds tier numbers.
"""
import json
from dataclasses import dataclass, replace
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Tuple

from app.core.constants import RecordStatus

CONFIG_PATH = Path(__file__).parent / "config" / "tiers.json"
VALID_BOUNDARY_RULES = {"lower_inclusive", "upper_inclusive", "unconfirmed"}


@dataclass(frozen=True)
class TierBand:
    code: str
    name: str
    rank: int
    min_amount: float
    max_amount: Optional[float]  # None = open-ended
    color: str = "#94a3b8"
    description: str = ""
    effective_from: Optional[date] = None  # None = always; else only for periods starting on/after this date
    # amounts that applied before a date: ((date, min_amount, max_amount), ...), None = unchanged; oldest date first
    earlier: Tuple[Tuple[date, Optional[float], Optional[float]], ...] = ()

    def amounts_on(self, on: Optional[date]) -> "TierBand":
        """This band with the amounts in force for a period starting on `on` (None = the current amounts)."""
        if on is None:
            return self
        for before, lo, hi in self.earlier:
            if on < before:
                return replace(self, min_amount=self.min_amount if lo is None else lo,
                               max_amount=self.max_amount if hi is None else hi, earlier=())
        return self


@dataclass(frozen=True)
class TierConfig:
    status: str
    currency: str
    qualification_basis: str
    boundary_rule: str
    bands: List[TierBand]
    raw: dict


@dataclass(frozen=True)
class TierResult:
    tier_code: Optional[str]
    status: RecordStatus
    note: Optional[str] = None


def _earlier(items) -> Tuple[Tuple[date, Optional[float], Optional[float]], ...]:
    """tiers.json 'earlier': [{"before": "2026-07-01", "min_amount": 250000}] -> ((date(2026, 7, 1), 250000.0, None),)"""
    def amount(v):
        return None if v is None else float(v)
    return tuple(sorted((date.fromisoformat(e["before"]), amount(e.get("min_amount")), amount(e.get("max_amount")))
                        for e in items or ()))


def load_tier_config(path: Path = CONFIG_PATH) -> TierConfig:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    bands = sorted(
        (TierBand(t["code"], t["name"], int(t["rank"]), float(t["min_amount"]),
                  None if t.get("max_amount") is None else float(t["max_amount"]),
                  t.get("color", "#94a3b8"), t.get("description", ""),
                  date.fromisoformat(t["effective_from"]) if t.get("effective_from") else None,
                  _earlier(t.get("earlier")))
         for t in raw["tiers"]),
        key=lambda b: b.min_amount,
    )
    rule = raw.get("boundary_rule", "unconfirmed")
    if rule not in VALID_BOUNDARY_RULES:
        raise ValueError(f"tiers.json boundary_rule must be one of {sorted(VALID_BOUNDARY_RULES)}, got {rule!r}")
    return TierConfig(raw.get("status", ""), raw.get("currency", "INR"),
                      raw.get("qualification_basis", ""), rule, bands, raw)


@lru_cache
def get_tier_config() -> TierConfig:
    return load_tier_config()


def bands_on(cfg: TierConfig, on: Optional[date]) -> List[TierBand]:
    """Bands in force for a period starting on `on` (None = every band, with the current amounts).

    Each band takes the amounts of that period (Silver started at 2.5 L until Q1 FY 27, at 3 L from Q2 FY 27).
    A band with an effective_from later than `on` does not exist yet; the highest band left then has
    no upper limit (before Platinum starts in April 2026, every amount from the Gold minimum up is Gold).
    """
    if on is None:
        return cfg.bands
    active = [b.amounts_on(on) for b in cfg.bands if b.effective_from is None or b.effective_from <= on]
    if not active or len(active) == len(cfg.bands):
        return active or cfg.bands
    if active[-1].max_amount is not None:
        active[-1] = replace(active[-1], max_amount=None)
    return active


def classify_amount(amount: Optional[float], config: Optional[TierConfig] = None,
                    on: Optional[date] = None) -> TierResult:
    """Classify one period's sales amount into a tier. `on` = first day of the period (tiers in force then).

    Never guesses on ambiguity:
      * missing amount         -> MISSING
      * negative amount        -> NEEDS_REVIEW
      * exactly on a boundary  -> NEEDS_REVIEW while boundary_rule == 'unconfirmed'
      * below lowest threshold -> tier None (treatment unconfirmed)
    """
    cfg = config or get_tier_config()
    bands = bands_on(cfg, on)
    if amount is None or amount != amount:  # None or NaN
        return TierResult(None, RecordStatus.MISSING, "No sales amount for the period.")
    amount = float(amount)
    if amount < 0:
        return TierResult(None, RecordStatus.NEEDS_REVIEW, "Negative period sales (returns exceed sales?).")

    boundaries = {b.min_amount for b in bands} | {b.max_amount for b in bands if b.max_amount is not None}
    if cfg.boundary_rule == "unconfirmed" and amount in boundaries:
        return TierResult(None, RecordStatus.NEEDS_REVIEW,
                          f"Amount {amount:,.0f} sits exactly on a tier boundary; boundary rule not confirmed.")

    lowest = bands[0].min_amount
    if amount < lowest:
        return TierResult(None, RecordStatus.VALID, "Below the lowest tier threshold (treatment unconfirmed).")

    for band in bands:
        lo, hi = band.min_amount, band.max_amount
        if cfg.boundary_rule == "upper_inclusive":
            inside = (amount > lo or (amount == lo and lo == lowest)) and (hi is None or amount <= hi)
        else:  # lower_inclusive, or unconfirmed with a non-boundary amount
            inside = amount >= lo and (hi is None or amount < hi)
        if inside:
            return TierResult(band.code, RecordStatus.VALID)

    return TierResult(None, RecordStatus.NEEDS_REVIEW, "Amount did not fall in any configured band.")


def cap_tier(name: str, on: Optional[date], config: Optional[TierConfig] = None) -> str:
    """A reported tier name limited to the tiers in force on `on`: 'Platinum' before April 2026 -> 'Gold'."""
    cfg = config or get_tier_config()
    by_name = {b.name.casefold(): b for b in cfg.bands}
    band = by_name.get(str(name).strip().casefold())
    if band is None or on is None or band.effective_from is None or band.effective_from <= on:
        return name
    active = bands_on(cfg, on)
    return next((b.name for b in reversed(active) if b.rank <= band.rank), name)
