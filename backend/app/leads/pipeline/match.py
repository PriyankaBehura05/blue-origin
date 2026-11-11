"""Lead -> retailer matching in three passes, and the three matching levels built from them.

    pass 1  exact mobile: the lead's mobile is a retailer's main phone
    pass 2  alternate numbers: the lead's mobile is a retailer's alternate phone, or the lead's alternate number is a
            retailer's phone (main or alternate)
    pass 3  fuzzy: business name similarity within the same pincode, else the same city/district, with a 0-100 score

    floor    pass 1 only                          (the number we are sure of)
    likely   pass 1 + 2 + fuzzy score >= 90
    ceiling  pass 1 + 2 + fuzzy score >= 75       (the most generous reading: sizes the undercount risk)

Only leads with a valid mobile are matched (the rest are 'Unmatchable'). When one number belongs to several retailers,
the one billed first is taken.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List

import numpy as np
import pandas as pd

LEVELS = ("floor", "likely", "ceiling")
FUZZY_LIKELY = 90
FUZZY_CEILING = 75


def _phone_index(sales, column: str, first: Dict[int, int]) -> Dict[str, int]:
    idx: Dict[str, int] = {}
    for pos, phones in enumerate(sales.retailers[column]):
        for p in phones:
            cur = idx.get(p)
            if cur is None or first.get(pos, 10**7) < first.get(cur, 10**7):
                idx[p] = pos
    return idx


def match(leads: pd.DataFrame, sales) -> pd.DataFrame:
    """Adds mpass (0 none, 1, 2, 3), conf (0-100) and r_floor / r_likely / r_ceiling (retailer position or -1)."""
    first = {r: int(a[0]) for r, a in sales.active.items() if len(a)}
    main = _phone_index(sales, "phones", first)
    alt = _phone_index(sales, "alt_phones", first)
    n = len(leads)
    ret = np.full(n, -1)
    pas = np.zeros(n, dtype=int)
    conf = np.zeros(n, dtype=int)
    for i, (mob, a, valid) in enumerate(zip(leads["mobile"], leads["alt"], leads["valid"])):
        if not valid:
            continue
        if mob in main:
            ret[i], pas[i], conf[i] = main[mob], 1, 100
        elif mob in alt or (a and (a in main or a in alt)):
            ret[i], pas[i], conf[i] = alt.get(mob, main.get(a, alt.get(a, -1))), 2, 100

    todo = [i for i in range(n) if pas[i] == 0 and leads["valid"].iat[i] and leads["name_key"].iat[i]]
    if todo:
        from rapidfuzz import fuzz, process
        r = sales.retailers
        by_pin: Dict[str, List[int]] = defaultdict(list)
        by_city: Dict[str, List[int]] = defaultdict(list)
        for pos, (pin, ck, nk) in enumerate(zip(r["pin"], r["city_key"], r["name_key"])):
            if not nk:
                continue
            if pin:
                by_pin[pin].append(pos)
            if ck:
                by_city[ck].append(pos)
        names = r["name_key"].tolist()
        for i in todo:
            pin, ck, nk = leads["pin"].iat[i], leads["city_key"].iat[i], leads["name_key"].iat[i]
            cands = by_pin.get(pin) if pin else None
            bonus = 5
            if not cands:
                cands, bonus = by_city.get(ck) if ck else None, 0
            if not cands:
                continue
            best = process.extractOne(nk, [names[c] for c in cands], scorer=fuzz.token_set_ratio)
            if best is None:
                continue
            score = min(100, int(round(best[1])) + bonus)
            if score >= FUZZY_CEILING:
                ret[i], pas[i], conf[i] = cands[best[2]], 3, score

    out = leads.copy()
    out["mpass"], out["conf"] = pas, conf
    out["r_floor"] = np.where(pas == 1, ret, -1)
    out["r_likely"] = np.where((pas == 1) | (pas == 2) | ((pas == 3) & (conf >= FUZZY_LIKELY)), ret, -1)
    out["r_ceiling"] = np.where(pas > 0, ret, -1)
    return out
