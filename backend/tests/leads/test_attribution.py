"""Lead -> campaign attribution rules and the campaign scoring (made-up numbers, tests only)."""
from datetime import date

import pandas as pd

from app.leads.services import attribution as A
from app.leads.services import spend_service as S

META = {
    "campaigns": [
        {"campaign_id": "m1", "name": "Lead Gen Whatsapp", "objective": "OUTCOME_LEADS"},
        {"campaign_id": "m2", "name": "Leadgen Telangana", "objective": "OUTCOME_LEADS"},
        {"campaign_id": "m3", "name": "Store traffic", "objective": "OUTCOME_TRAFFIC"},
    ],
    "daily": [
        {"campaign_id": "m1", "date": "2026-05-01", "spend": 900, "leads": 40},
        {"campaign_id": "m3", "date": "2026-05-01", "spend": 500, "leads": 3},     # not a lead-form campaign: ignored
        {"campaign_id": "m1", "date": "2026-05-02", "spend": 900, "leads": 35},
        {"campaign_id": "m2", "date": "2026-05-02", "spend": 400, "leads": 12},
    ],
    "lead_map": {"111": {"campaign_id": "m2", "is_organic": False}, "222": {"campaign_id": "m1", "is_organic": True}},
    "lead_map_available": True,
}


def one(source="Meta", day="2026-05-01", state="", lead_id="", cid="", cname=""):
    return A.attribute_one(A.PlatformData("Meta", META) if source == "Meta" else None, source, day, state, lead_id, cid, cname)


def test_lead_id_is_the_exact_link_and_organic_is_non_paid():
    assert one(lead_id="111")[:3] == (A.MATCHED, A.LEAD_ID, "m2")
    assert one(lead_id="222")[0] == A.NONPAID


def test_campaign_id_and_name_columns_win_over_dates():
    assert one(cid="m3")[:3] == (A.MATCHED, A.CAMPAIGN_ID, "m3")
    assert one(cname="lead gen whatsapp", day="2026-05-02")[:3] == (A.MATCHED, A.CAMPAIGN_NAME, "m1")


def test_date_fallback_only_when_one_lead_campaign_ran():
    assert one(day="2026-05-01")[:3] == (A.MATCHED, A.DATE_ONLY, "m1")      # the traffic campaign does not count
    st, me, cid, note = one(day="2026-05-02")
    assert (st, cid) == (A.UNMATCHED, "") and note.startswith(A.SEVERAL)     # two ran: never guessed
    assert one(day="2026-05-02", state="Telangana")[:3] == (A.MATCHED, A.NAME_DATE, "m2")
    assert one(day="2026-05-09")[0:4:3] == (A.UNMATCHED, A.NONE_THAT_DAY)


def test_sources_without_ad_platform_and_missing_ad_data():
    assert one(source="Print")[0] == A.NONPAID
    assert one(source="Other")[0::3] == (A.UNMATCHED, A.UNKNOWN_PLATFORM)      # a tab naming no platform is never "non-paid"
    assert one(source="Google")[0::3] == (A.UNMATCHED, A.NO_DATA)


def test_attribute_sets_campaign_names_and_keeps_every_row():
    leads = pd.DataFrame({"source": ["Meta", "Meta", "Print"], "date": [date(2026, 5, 1), date(2026, 5, 2), date(2026, 5, 2)],
                          "state": ["", "", ""], "lead_id": ["", "", ""], "campaign": ["(no campaign)"] * 3, "unique": [True, False, True]})
    out = A.attribute(leads, {"Meta": META, "Google": None})
    assert out["campaign"].tolist() == ["Lead Gen Whatsapp", "Unmatched Meta", "Non-paid"]
    s = A.summary(out, {"Meta": META, "Google": None})
    assert s["duplicates"] == 1 and sum(r["submissions"] for r in s["rows"]) == 3


def _row(name, spend, leads, new, judged=None, revenue=0.0):
    t = {"spend": spend, "unique": leads, "submissions": leads, "judged": judged or leads, "converted": new, "new": new,
         "revenue": revenue, "active_days": 30}
    return {"key": name, "name": name, "platform": "Meta", "kind": "campaign", **S._kpis(t, 30)}


def test_scoring_prefers_retailers_over_lead_volume_and_needs_volume():
    rows = [_row("A", 20000, 400, 8), _row("B", 15000, 150, 15), _row("C", 10000, 200, 2), _row("Lucky", 6000, 1, 1)]
    S._score(rows, S.THRESHOLDS)
    by = {r["name"]: r for r in rows}
    assert by["B"]["score"] > by["A"]["score"] > by["C"]["score"]           # B acquires most retailers for less
    assert by["Lucky"]["score"] is None and "Not enough data" in by["Lucky"]["score_note"]
    assert by["A"]["cpl"] == 50.0 and by["B"]["cost_per_new_retailer"] == 1000.0
    best = S._rank(rows, "cost_per_new_retailer", lambda r: r["unique_leads"] >= 30 and r["new_retailers"] >= 3, True)
    assert [r["name"] for r in best] == ["B", "A"]                          # C (2 retailers) and Lucky are below the minimum
