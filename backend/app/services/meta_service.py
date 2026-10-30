"""Filter options and period context for the UI - every dropdown is driven by stored data."""
from typing import Iterable, List

from app.core.constants import BENEFIT_FREQUENCIES, FULFILLMENT_STATUSES, MOVEMENT_DIRECTIONS, UNRANKED
from app.services.model import Model, fy_label, parse_quarter_label, quarter_label


def _distinct(*series: Iterable) -> List[str]:
    out = set()
    for s in series:
        out.update(str(v) for v in s if v is not None and v == v and str(v).strip())
    return sorted(out, key=str.casefold)


def _with_vocab(vocab: List[str], *series: Iterable) -> List[str]:
    extra = [v for v in _distinct(*series) if v not in vocab]
    return vocab + extra


def filter_options(m: Model) -> dict:
    quarters = set(m.sales["quarter"]) | set(m.fulfillments["quarter"]) | {m.periods.current_label}
    quarters = sorted((q for q in quarters if q), key=lambda q: parse_quarter_label(q) or (0, 0), reverse=True)
    regions = _distinct(m.retailers["region"], m.distributors["region"], m.sales["region"])
    tiers = [d["tier"] for d in m.tier_definitions if d["tier"] != UNRANKED] + [UNRANKED]
    return {
        "current_quarter": m.periods.current_label,
        "previous_quarter": m.periods.previous_label,
        "current_fy": fy_label(m.periods.current_fy),
        "regions": regions,
        "states": _distinct(m.retailers["state"], m.distributors["state"], m.sales["state"]),
        "channels": _distinct(m.retailers["channel"], m.sales["channel"]),
        "quarters": quarters,
        "sales_quarters": [quarter_label(*p) for p in m.sales_quarters],
        "months": sorted({str(v) for v in m.sales["month"].dropna()}, reverse=True),   # 'YYYY-MM', newest first
        "financial_years": [fy_label(fy) for fy in sorted({fy for fy, _ in m.sales_quarters}, reverse=True)],
        "tiers": tiers,
        "distributors": m.distributors.sort_values("name", key=lambda s: s.str.casefold())[["id", "name"]]
        .to_dict("records"),
        "retailers": m.retailers.sort_values("name", key=lambda s: s.str.casefold())[["id", "name"]]
        .to_dict("records"),
        "categories": _distinct(m.sales["category"]),
        "retailer_statuses": _distinct(m.retailers["status"]),
        "distributor_statuses": _distinct(m.distributors["status"]),
        "fulfillment_statuses": FULFILLMENT_STATUSES,
        "benefit_frequencies": _with_vocab(BENEFIT_FREQUENCIES, m.benefits["frequency"]),
        "benefits": m.benefits.sort_values("name", key=lambda s: s.str.casefold())[["id", "name"]]
        .to_dict("records"),
        "movement_directions": MOVEMENT_DIRECTIONS,
    }
