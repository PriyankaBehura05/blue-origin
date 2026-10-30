"""Tier definitions (config + retailer counts), quarter-on-quarter movement, config and classification."""
from typing import List, Optional, Tuple

from app.rules.tier_rules import bands_on, classify_amount, get_tier_config
from app.schemas.tier import TierBandOut, TierClassification, TierConfigOut
from app.core.constants import UNRANKED
from app.services.common import ListQuery, list_query
from app.core.errors import InvalidFilterError
from app.services.model import Model, fy_label, parse_quarter_label, quarter_label, quarter_start

MOVEMENT_SEARCH = ("retailerName", "retailerCode", "retailerId", "distributorName")
MOVEMENT_FILTERS = ("direction", "tier", "from", "region", "distributorName")


def resolve_quarter(m: Model, quarter: Optional[str]) -> Tuple[int, int]:
    """'Q1 FY 27' -> (2026, 1); blank -> the latest quarter with sales."""
    if not quarter:
        return m.periods.current
    parsed = parse_quarter_label(quarter)
    if parsed is None:
        raise InvalidFilterError("quarter must look like 'Q1 FY 27'.", details={"quarter": quarter})
    return parsed


def ladder(m: Model, fy: int, q: int) -> List[dict]:
    """The tier definitions in force in quarter (fy, q), with that quarter's ranges: Silver 2.5 L - 5 L (Green up
    to 2.5 L) until Q1 FY 27, 3 L - 5 L (Green up to 3 L) from Q2 FY 27. A tier that starts later (Platinum from
    Q1 FY 27) is left out and the highest remaining tier has no upper limit."""
    bands = {b.name: b for b in bands_on(get_tier_config(), quarter_start(fy, q))}
    defs = []
    for d in m.tier_definitions:
        if d["tier"] == UNRANKED:
            defs.append(d)
        elif d["tier"] in bands:
            b = bands[d["tier"]]
            defs.append({**d, "minQuarterlySales": b.min_amount, "maxQuarterlySales": b.max_amount})
    return defs


def definitions(m: Model, quarter: Optional[str] = None) -> List[dict]:
    """Tier ladder with the number of retailers in each tier in the selected quarter (default: latest)."""
    fy, q = resolve_quarter(m, quarter)
    view = m.quarter_view(fy, q)
    counts = view.loc[view["quarterSales"] != 0, "tier"].value_counts().to_dict()
    return [{**d, "retailerCount": int(counts.get(d["tier"], 0))} for d in ladder(m, fy, q)]


def movements(m: Model, q: ListQuery, quarter: Optional[str] = None) -> dict:
    """Every retailer that bought in the selected quarter or the one before: current tier, sales, movement."""
    view = m.quarter_view(*resolve_quarter(m, quarter))
    v = view[(view["quarterSales"] != 0) | (view["previousQuarterSales"] != 0)]
    df = v.rename(columns={"id": "retailerId", "name": "retailerName", "code": "retailerCode",
                           "previousTier": "from", "quarterSales": "quarterlySales"})
    df = df.assign(to=df["tier"])
    return list_query(df, q, MOVEMENT_SEARCH)


def mix_by_quarter(m: Model, fy_filter: Optional[str] = None) -> List[dict]:
    """Tier counts for every quarter that has sales (optionally one financial year), newest first."""
    rows = []
    for fy, qn in m.sales_quarters:
        if fy_filter and fy_label(fy).casefold() != fy_filter.strip().casefold():
            continue
        v = m.quarter_view(fy, qn)
        buying = v[v["quarterSales"] != 0]
        counts = buying["tier"].value_counts().to_dict()
        rows.append({"quarter": quarter_label(fy, qn), "buying_retailers": len(buying),
                     "tiered_retailers": int((buying["tier"] != UNRANKED).sum()),
                     "net_sales": float(buying["quarterSales"].sum()),
                     "counts": {d["tier"]: int(counts.get(d["tier"], 0)) for d in ladder(m, fy, qn)}})
    return rows


def tier_config() -> TierConfigOut:
    cfg = get_tier_config()
    notes = [n for n in (cfg.raw.get("qualification_basis_note"), cfg.raw.get("boundary_rule_note"),
                         cfg.raw.get("below_minimum_note"), cfg.raw.get("effective_from_note"),
                                    cfg.raw.get("earlier_note")) if n]
    return TierConfigOut(
        status=cfg.status, currency=cfg.currency, qualification_basis=cfg.qualification_basis,
        boundary_rule=cfg.boundary_rule, notes=notes,
        tiers=[TierBandOut(code=b.code, name=b.name, rank=b.rank, min_amount=b.min_amount, max_amount=b.max_amount,
                           effective_from=b.effective_from)
               for b in cfg.bands],
    )


def classify(amount: Optional[float], quarter: Optional[str] = None) -> TierClassification:
    """Tier for an amount; with a quarter, only the tiers in force in that quarter count."""
    on = None
    if quarter:
        parsed = parse_quarter_label(quarter)
        if parsed is None:
            raise InvalidFilterError("quarter must look like 'Q1 FY 27'.", details={"quarter": quarter})
        on = quarter_start(*parsed)
    r = classify_amount(amount, on=on)
    return TierClassification(amount=amount, tier_code=r.tier_code, status=r.status.value, note=r.note)
