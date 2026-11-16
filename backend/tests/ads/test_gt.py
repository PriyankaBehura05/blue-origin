"""GT (YASHA) campaigns: the campaign-name filter, and Google leads taken from the one conversion action named "Conversion"
(made-up numbers, tests only)."""
from datetime import date

from app.ads import common as C, gt as GT
from app.ads.google_sheet import GoogleAdsSheet


def test_only_campaigns_with_the_filter_word_count(settings):
    s = settings.model_copy(update={"ADS_CAMPAIGN_FILTER": "YASHA"})
    assert C.keep_campaign("YASHA_Lead Gen Whatsapp", s) and C.keep_campaign("gt_leadgen_pmax_yasha_12oct26", s)
    assert not C.keep_campaign("TS_Awareness_Retail_Hyperlocal_Gold_May", s) and not C.keep_campaign(None, s)
    assert C.keep_campaign("anything", settings.model_copy(update={"ADS_CAMPAIGN_FILTER": ""}))   # empty filter = every campaign


class FakeSheet(GoogleAdsSheet):
    def __init__(self, settings, tabs):
        super().__init__(settings)
        self._fake = tabs

    def _tabs(self):
        return self._fake


CONV = [
    {"date": "2026-10-14", "campaign_id": "1", "conversion_action": "Conversion", "conversions": "5", "all_conversions": "5"},
    {"date": "2026-10-14", "campaign_id": "1", "conversion_action": "Phone call", "conversions": "9", "all_conversions": "9"},
    {"date": "2026-10-15", "campaign_id": "1", "conversion_action": "conversion", "conversions": "2", "all_conversions": "2"},
    {"date": "2026-10-15", "campaign_id": "2", "conversion_action": "Conversion", "conversions": "1", "all_conversions": "1"},
]


def test_google_leads_are_the_conversion_action_only(settings):
    g = FakeSheet(settings, {"Ads_Conversions": CONV})
    got = g.lead_conversions(None, date(2026, 10, 1), date(2026, 10, 31), "Conversion")
    assert got == {("1", "2026-10-14"): 5.0, ("1", "2026-10-15"): 2.0, ("2", "2026-10-15"): 1.0}   # "Phone call" is not a lead


def test_a_secondary_conversion_action_uses_all_conversions(settings):
    rows = [{"date": "2026-10-14", "campaign_id": "1", "conversion_action": "Conversion", "conversions": "0", "all_conversions": "4"}]
    g = FakeSheet(settings, {"Ads_Conversions": rows})
    assert g.lead_conversions(None, date(2026, 10, 1), date(2026, 10, 31), "Conversion") == {("1", "2026-10-14"): 4.0}


def test_without_the_breakdown_the_sheet_says_so(settings):
    assert FakeSheet(settings, {}).lead_conversions(None, date(2026, 10, 1), date(2026, 10, 31), "Conversion") is None
    daily = [{"campaign_id": "1", "date_start": "2026-10-14", "spend": 100.0, "impressions": 1000, "clicks": 50, "conversions": 14}]
    out = GT.google(daily, None, settings)
    assert out["campaign_monthly"][0]["leads"] == 14 and out["leads_basis"].startswith("All Google Ads conversions")
    out = GT.google(daily, {("1", "2026-10-14"): 5.0}, settings)
    assert out["campaign_monthly"][0]["leads"] == 5 and out["campaign_monthly"][0]["all_conversions"] == 14
    assert "Conversion" in out["leads_basis"] and not out["has_reach"]


def test_the_filter_word_never_shows_in_a_campaign_name(settings):
    s = settings.model_copy(update={"ADS_CAMPAIGN_FILTER": "YASHA"})
    assert C.display_name("YASHA_Lead Gen Whatsapp", s) == "Lead Gen Whatsapp"
    assert C.display_name("YASHA_GT_Leadgen_new_Po_P1_Sept_29Sept", s) == "GT_Leadgen_new_Po_P1_Sept_29Sept"
    assert C.display_name("GT_LeadGen_PMax_Tamil Nadu_yasha_12Oct26", s) == "GT_LeadGen_PMax_Tamil Nadu_12Oct26"   # the state stays: the attribution needs it
    assert C.display_name("Other campaign", settings.model_copy(update={"ADS_CAMPAIGN_FILTER": ""})) == "Other campaign"


# ---------------------------------------------------------------- ad detail (ad sets, ads, Google detail tabs)
from app.ads import detail as DT   # noqa: E402


def test_audience_and_placements_are_summarised_from_the_targeting():
    t = {"age_min": 25, "age_max": 55, "geo_locations": {"cities": [{"name": "Agra"}, {"name": "Alwar"}, {"name": "Baghpat"}, {"name": "Etah"}]},
         "custom_audiences": [{"id": "1"}], "excluded_custom_audiences": [{"id": "2"}, {"id": "3"}],
         "publisher_platforms": ["facebook", "instagram"], "facebook_positions": ["feed", "story"], "instagram_positions": ["stream"],
         "flexible_spec": [{"interests": [{"name": "Sports"}]}]}
    a = DT.audience(t)
    assert a["age"] == "25–55" and a["gender"] == "All genders" and a["locations"] == "Agra, Alwar, Baghpat +1 more"
    assert a["custom_audiences"] == 1 and a["excluded_audiences"] == 2 and a["interests"] == ["Sports"]
    assert DT.audience({"genders": [2], "age_max": 65})["gender"] == "Women"
    assert DT.placements(t)["text"] == "Facebook, Instagram · 3 positions"
    assert DT.placements({})["text"] == "Automatic placements"            # no placements set = automatic, never invented


def test_meta_leads_are_the_largest_lead_action_never_the_sum():
    acts = [{"action_type": "onsite_conversion.lead_grouped", "value": "10"}, {"action_type": "lead", "value": "10"}, {"action_type": "link_click", "value": "500"}]
    assert DT._leads(acts) == 10.0 and DT._leads(None) == 0.0


def test_the_filter_word_is_scrubbed_from_every_detail_string(settings):
    s = settings.model_copy(update={"ADS_CAMPAIGN_FILTER": "YASHA"})
    out = DT.scrub({"ads": [{"name": "YASHA_Video_1", "headline": "Join Yasha shops", "n": 5}], "ok": "Gold tier"}, s)
    assert out == {"ads": [{"name": "Video_1", "headline": "Join shops", "n": 5}], "ok": "Gold tier"}


def test_google_detail_tabs_distinguish_missing_from_empty_from_failed(settings):
    tabs = {"Ads_Info": [{"key": "keywords_error", "value": "Not supported for PMax"}],
            "Ads_Devices": [{"month": "2026-10-01", "campaign_id": "7", "campaign_name": "GT_PMax", "device": "MOBILE", "cost": "100", "impressions": "1000", "clicks": "50", "conversions": "4"},
                            {"month": "2026-10-01", "campaign_id": "8", "campaign_name": "Other", "device": "MOBILE", "cost": "9", "impressions": "9", "clicks": "9", "conversions": "9"}],
            "Ads_Geo": []}
    g = FakeSheet(settings, tabs)
    out = g.detail_tabs(lambda n: n == "GT_PMax")
    assert out["devices"]["available"] and len(out["devices"]["rows"]) == 1 and out["devices"]["rows"][0]["period"] == "2026-10"   # other campaigns dropped
    assert out["geo"]["available"] and out["geo"]["rows"] == []                 # written but empty: a real zero
    assert out["search_terms"]["available"] is False and out["search_terms"]["error"] is None      # not written by the script: not available
    assert out["keywords"]["available"] is False and "PMax" in out["keywords"]["error"]            # the script reported why
