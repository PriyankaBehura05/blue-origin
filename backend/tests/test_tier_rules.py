import json
from dataclasses import replace
from datetime import date

import pytest

from app.core.constants import RecordStatus
from app.rules.tier_rules import CONFIG_PATH, classify_amount, get_tier_config, load_tier_config


@pytest.mark.parametrize("amount,tier", [
    (60000, "YELLOW"), (200000, "GREEN"), (420000, "SILVER"), (750000, "GOLD"), (2500000, "PLATINUM"),
])
def test_amount_inside_band(amount, tier):
    r = classify_amount(amount)
    assert r.tier_code == tier and r.status == RecordStatus.VALID


@pytest.mark.parametrize("amount", [50000, 150000, 300000, 500000, 1000000])
def test_boundary_is_not_guessed_when_rule_unconfirmed(amount):
    unconfirmed = replace(get_tier_config(), boundary_rule="unconfirmed")
    r = classify_amount(amount, unconfirmed)
    assert r.tier_code is None and r.status == RecordStatus.NEEDS_REVIEW


@pytest.mark.parametrize("amount,tier", [
    (50000, "YELLOW"), (150000, "GREEN"), (299999, "GREEN"), (300000, "SILVER"), (500000, "GOLD"),
    (1000000, "PLATINUM"),
])
def test_business_boundaries_go_to_the_higher_tier(amount, tier):
    assert classify_amount(amount).tier_code == tier


def test_lower_and_upper_inclusive_rules():
    lower = replace(get_tier_config(), boundary_rule="lower_inclusive")
    upper = replace(get_tier_config(), boundary_rule="upper_inclusive")
    assert classify_amount(150000, lower).tier_code == "GREEN"
    assert classify_amount(150000, upper).tier_code == "YELLOW"
    assert classify_amount(50000, upper).tier_code == "YELLOW"       # lowest floor still qualifies
    assert classify_amount(1000000, lower).tier_code == "PLATINUM"


def test_below_minimum_negative_and_missing():
    assert classify_amount(10000).tier_code is None
    assert classify_amount(-5).status == RecordStatus.NEEDS_REVIEW
    assert classify_amount(None).status == RecordStatus.MISSING


def test_thresholds_come_only_from_config(tmp_path):
    raw = json.loads(CONFIG_PATH.read_text())
    raw["tiers"][0]["min_amount"] = 75000
    path = tmp_path / "tiers.json"
    path.write_text(json.dumps(raw))
    cfg = load_tier_config(path)
    assert classify_amount(60000, cfg).tier_code is None
    assert classify_amount(80000, cfg).tier_code == "YELLOW"


def test_invalid_boundary_rule_rejected(tmp_path):
    raw = json.loads(CONFIG_PATH.read_text())
    raw["boundary_rule"] = "whatever"
    path = tmp_path / "tiers.json"
    path.write_text(json.dumps(raw))
    with pytest.raises(ValueError):
        load_tier_config(path)


def test_platinum_only_from_april_2026():
    from datetime import date

    from app.rules.tier_rules import cap_tier, classify_amount
    assert classify_amount(1_500_000, on=date(2026, 4, 1)).tier_code == "PLATINUM"   # Q1 FY 27
    assert classify_amount(1_500_000, on=date(2026, 1, 1)).tier_code == "GOLD"       # Q4 FY 26: Gold is the top
    assert classify_amount(600_000, on=date(2025, 7, 1)).tier_code == "GOLD"
    assert classify_amount(200_000, on=date(2025, 7, 1)).tier_code == "GREEN"
    assert cap_tier("Platinum", date(2025, 10, 1)) == "Gold" and cap_tier("Platinum", date(2026, 7, 1)) == "Platinum"
    assert cap_tier("Silver", date(2025, 10, 1)) == "Silver"


def test_tier_ladder_per_quarter(client):
    old = client.get("/api/tiers/definitions?quarter=Q4 FY 26").json()["data"]
    assert [d["tier"] for d in old][-1] == "Gold" and old[-1]["maxQuarterlySales"] is None
    new = client.get("/api/tiers/definitions?quarter=Q1 FY 27").json()["data"]
    assert new[-1]["tier"] == "Platinum" and new[-1]["effectiveFrom"] == "2026-04-01"
    assert client.get("/api/tiers/classify?amount=2000000&quarter=Q3 FY 26").json()["data"]["tier_code"] == "GOLD"
    assert client.get("/api/tiers/classify?amount=2000000&quarter=Q3 FY 27").json()["data"]["tier_code"] == "PLATINUM"
    mix = client.get("/api/tiers/by-quarter").json()["data"]
    assert all("Platinum" not in row["counts"] for row in mix)   # test data is Q3-Q4 FY 26


@pytest.mark.parametrize("on,amount,tier", [
    (date(2026, 4, 1), 249999, "GREEN"), (date(2026, 4, 1), 250000, "SILVER"), (date(2026, 4, 1), 299999, "SILVER"),
    (date(2025, 7, 1), 260000, "SILVER"),
    (date(2026, 7, 1), 250000, "GREEN"), (date(2026, 7, 1), 299999, "GREEN"), (date(2026, 7, 1), 300000, "SILVER"),
    (date(2026, 10, 1), 299999, "GREEN"), (date(2026, 10, 1), 300000, "SILVER"), (date(2026, 10, 1), 499999, "SILVER"),
])
def test_silver_starts_at_3_lakh_from_q2_fy27(on, amount, tier):
    """Silver: 2.5 L - 5 L until Q1 FY 27 (quarters before July 2026), 3 L - 5 L from Q2 FY 27; Green ends where Silver starts."""
    assert classify_amount(amount, on=on).tier_code == tier


def test_tier_ladder_shows_the_ranges_of_the_selected_quarter():
    from types import SimpleNamespace

    from app.core.constants import UNRANKED
    from app.services.tier_service import ladder
    cfg = get_tier_config()                        # the model's tier_definitions: current amounts from tiers.json
    defs = [{"tier": UNRANKED, "minQuarterlySales": 0.0, "maxQuarterlySales": cfg.bands[0].min_amount}] + [
        {"tier": b.name, "minQuarterlySales": b.min_amount, "maxQuarterlySales": b.max_amount,
         "effectiveFrom": b.effective_from} for b in cfg.bands]
    m = SimpleNamespace(tier_definitions=defs)
    rng = lambda fy, q: {d["tier"]: (d["minQuarterlySales"], d["maxQuarterlySales"]) for d in ladder(m, fy, q)}  # noqa: E731
    q1, q2 = rng(2026, 1), rng(2026, 2)            # Q1 FY 27 (Apr-Jun 2026), Q2 FY 27 (Jul-Sep 2026)
    assert q1["Green"] == (150000, 250000) and q1["Silver"] == (250000, 500000)
    assert q2["Green"] == (150000, 300000) and q2["Silver"] == (300000, 500000)
    assert "Platinum" not in rng(2025, 4) and rng(2025, 4)["Gold"] == (500000, None)
