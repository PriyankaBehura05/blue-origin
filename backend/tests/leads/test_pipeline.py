"""Lead Generation pipeline: small fictional inputs, checked rule by rule."""
import gzip
import io
import json
from datetime import date

import pandas as pd

from app.leads.pipeline import normalise as N
from app.leads.pipeline import run
from app.leads.pipeline.classify import EXISTING, NEW, NOT_CONVERTED, REACTIVATED, UNMATCHABLE, outcome

RETAILERS = """Retailer_ID,Distributor,District,State,City,Pincode,Address,Phone,Name_Variants,Source_Rows,Retailer_Name,Phone_Alt,Region,First_Active_Month,Last_Active_Month,First_Active_Quarter,First_Listed_Quarter,Lifetime_Revenue
R1,Dist A,Pune,Maharashtra,,411001,,9876500001,,1,Alpha Sports,,West,Apr_26,Jul_26,Q1_FY27,Q1_FY27,30000
R2,Dist A,Pune,Maharashtra,,411001,,9876500002,,1,Beta Garments,9876500022,West,Jan_26,Jun_26,Q4_FY26,Q4_FY26,15000
R3,Dist B,Indore,Madhya Pradesh,,452001,,,,1,Gamma Fashion House,,Central,Jun_26,Jun_26,Q1_FY27,Q1_FY27,5000
R4,Dist B,Indore,Madhya Pradesh,,452001,,9876500004,,1,Delta Store,,Central,Mar_26,Jun_26,Q4_FY26,Q4_FY26,8000
"""
MONTHS = """Retailer_ID,Month,Revenue,Quarter
R1,Apr_26,10000,Q1_FY27
R1,May_26,10000,Q1_FY27
R1,July_26,10000,Q2_FY27
R2,Jan_26,10000,Q4_FY26
R2,Jun_26,5000,Q1_FY27
R3,Jun_26,5000,Q1_FY27
R4,Mar_26,4000,Q4_FY26
R4,Jun_26,4000,Q1_FY27
"""
QUARTERS = """Retailer_ID,Quarter,Revenue,Tier_Basis,Reported_Tier,Computed_Tier
R1,Q1_FY27,20000,20000,Yellow,Yellow
R1,Q2_FY27,10000,10000,Untiered,Untiered
"""
# L1 new (R1 first bill Apr), L2 repeat of L1, L3 reactivated via alternate number (R2 dormant since Jan),
# L4 fuzzy name match in the same pincode (R3, no phone), L5 invalid mobile, L6 no match,
# L7 existing active (R4 billed Mar, lead in May), L8 no readable date (dropped)
LEADS = """Lead Date,Phone Number,Business Name,City,Pincode,Platform,Campaign Name,Ad Set Name
2026-04-10T10:00:00+05:30,+91 98765 00001,Alpha Sports,Pune,411001,facebook,Spring Retailers,Set 1
15-05-2026,09876500001,Alpha Sports,Pune,411001,google,Search Brand,
2026-05-20,9876500022,Beta,Pune,411001,fb,Spring Retailers,Set 2
2026-06-02,9123456789,Gamma Fashion House,Indore,452001,JustDial,JD Listing,
2026-06-05,12345,Someone,Indore,,Print,Newspaper,
2026-05-06,9988776655,Nobody Shop,Nagpur,440001,instagram,Spring Retailers,Set 1
2026-05-03,9876500004,Delta Store,Indore,452001,google,Search Brand,
,9876500099,No Date,Pune,,google,Search Brand,
"""
SPEND = """Campaign,Month,Amount Spent (INR)
Spring Retailers,Apr 2026,"10,000"
Search Brand,May 2026,5000
"""


def _run(extra=None, overrides=None):
    inbox = {"meta_google_leads.csv": LEADS.encode(), "campaign_spend.csv": SPEND.encode(), **(extra or {})}
    sales = {"retailers.csv": RETAILERS.encode(), "retailer_month.csv": MONTHS.encode(),
             "retailer_quarter.csv": QUARTERS.encode()}
    return run(inbox, sales, target_overrides=overrides, today=date(2026, 11, 9))


def test_mobile_normalisation():
    assert N.mobile("+91 98765 43210") == "9876543210"
    assert N.mobile("09876543210") == "9876543210"
    assert N.mobile("919876543210") == "9876543210"
    assert N.mobile("9876543210.0") == "9876543210"
    assert N.mobile("12345") == ""
    assert N.mobile("5876543210") == ""        # Indian mobiles start 6-9
    assert N.mobile("9999999999") == ""
    assert N.mobiles("9876543210 | 8765432109") == ["9876543210", "8765432109"]


def test_months_quarters_sources():
    assert N.sales_month("Sept_24") == 2024 * 12 + 8
    assert N.fy_quarter(2026 * 12 + 6) == "Q2_FY27"   # Jul 2026
    assert N.fy_quarter(2027 * 12 + 0) == "Q4_FY27"   # Jan 2027
    assert N.source("fb") == "Meta" and N.source("Just Dial") == "JustDial" and N.source("", "google_ads.csv") == "Google"


def test_outcome_rules():
    import numpy as np
    a = np.array([10, 11])
    assert outcome(a, 12, 13) == EXISTING            # billed in the 3 months before
    assert outcome(np.array([5, 13]), 12, 13) == REACTIVATED
    assert outcome(np.array([12]), 12, 13) == NEW     # same month counts as after
    assert outcome(np.array([15]), 12, 13) == NOT_CONVERTED
    assert outcome(None, 12, 13) == NOT_CONVERTED


def test_pipeline_buckets_and_passes():
    res = _run()
    p = res.payload
    L = p["leads"]
    assert len(L["day"]) == 7                        # the row without a date is dropped and logged
    assert sum(L["uniq"]) == 6                       # 2nd Alpha lead is a repeat
    o = {L["name"][i]: L["o"][i] for i in range(7) if L["uniq"][i]}
    likely60 = lambda name: int(o[name][1 * 3 + 1])  # noqa: E731  levels x windows: likely = 2nd level, 60 = 2nd window
    assert likely60("Alpha Sports") == NEW
    assert likely60("Beta") == REACTIVATED           # pass 2 (alternate number)
    assert likely60("Gamma Fashion House") == NEW    # pass 3 (fuzzy, same pincode)
    assert likely60("Someone") == UNMATCHABLE
    assert likely60("Nobody Shop") == NOT_CONVERTED
    assert likely60("Delta Store") == EXISTING
    floor60 = int(o["Beta"][1])
    assert floor60 == NOT_CONVERTED                  # floor = exact main phone only
    passes = {L["name"][i]: L["pass"][i] for i in range(7) if L["uniq"][i]}
    assert passes["Alpha Sports"] == 1 and passes["Beta"] == 2 and passes["Gamma Fashion House"] == 3
    assert p["hasSpend"] and sum(p["spend"]["v"]) == 15000
    dropped = [s for s in p["steps"] if s["step"].startswith("rows with a readable lead date")]
    assert dropped and dropped[0]["dropped"] == 1


def test_reconciliation_workbook_checks_pass():
    res = _run()
    book = pd.read_excel(io.BytesIO(res.reconciliation), sheet_name=None)
    assert (book["Checks"]["OK"] == "Yes").all()
    assert (book["Lead buckets"]["Reconciles"] == "Yes").all()
    assert len(book["Lead buckets"]) == 9
    assert "Findings" in res.memo and "Insight" in res.memo


def test_targets_sheet_and_overrides():
    targets = "Metric,Target\nConversion %,7\nNew retailers per quarter,40\n"
    res = _run({"targets.csv": targets.encode()}, overrides={"sla_days": 3})
    t = res.payload["targets"]
    assert t["conversion_pct"] == 7 and t["new_retailers_quarter"] == 40 and t["sla_days"] == 3
    assert "conversion_pct" in res.payload["targetsFromFile"]


def test_runs_without_any_lead_files():
    sales = {"retailers.csv": RETAILERS.encode(), "retailer_month.csv": MONTHS.encode()}
    res = run({}, sales, today=date(2026, 11, 9))
    assert not res.payload["hasLeads"] and len(res.payload["retailers"]["id"]) == 4
    assert any("No lead dump" in g for g in res.payload["gaps"])
    json.dumps(res.payload)  # serialisable


def test_api_builds_and_serves(client, store):
    store.write("network/retailers.csv", RETAILERS.encode())
    store.write("network/retailer_month.csv", MONTHS.encode())
    store.write("network/retailer_quarter.csv", QUARTERS.encode())
    store.write("leads/inbox/leads.csv", LEADS.encode())
    r = client.get("/api/leads/data")
    assert r.status_code == 200
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else json.loads(gzip.decompress(r.content))
    assert body["hasLeads"] and len(body["leads"]["day"]) == 7
    assert client.get("/api/leads/reconciliation").status_code == 200
    assert "Findings" in client.get("/api/leads/memo").text
    r = client.put("/api/leads/actions", json={"items": [{"id": "a1", "recommendation": "Call leads", "owner": "ASM"}]})
    assert r.status_code == 200 and client.get("/api/leads/actions").json()["data"][0]["owner"] == "ASM"


def test_lead_newer_than_sales_is_too_recent_to_judge():
    """A lead whose window runs past the last sales month may still convert: not 'Not converted', not in the rate."""
    from app.leads.pipeline.classify import PENDING
    late = LEADS.splitlines()[0] + "\n2026-09-20,9000000001,Late Shop,Pune,411001,facebook,Spring Retailers,Set 1\n"
    sales = {"retailers.csv": RETAILERS.encode(), "retailer_month.csv": MONTHS.encode(),
             "retailer_quarter.csv": QUARTERS.encode()}
    res = run({"late.csv": late.encode()}, sales, today=date(2026, 11, 9))
    o = res.payload["leads"]["o"]
    assert all(c == str(PENDING) for c in o[0][3:6])          # likely level, 30/60/90-day windows


def test_asm_columns_on_the_lead_sheet_and_bo_order_check():
    """ASM NAME / Calling Done / Visit Done / Order Placed on the lead sheet become the follow-up; a claimed order is
    checked against BO billing of the matched retailer (lead month + 2)."""
    from app.leads.pipeline import metrics as Mx
    from app.leads.pipeline.build import I, prepare_leads, prepare_sales
    sheet = ("created_time,full_name,phone_number,retailer,city,pincode,shop_name,ASM NAME,Calling Done,Visit Done,"
             "Order Placed,Order Value,Category\n"
             "10-04-2026,A,9876500001,yes,Pune,411001,Alpha Sports,ravi k,Yes,Yes,Yes,\"12,500\",Interested\n"
             "12-04-2026,A,9876500001,yes,Pune,411001,Alpha Sports,,,,,,\n"
             "06-05-2026,B,9988776655,no,Nagpur,440001,Nobody Shop,Ravi K,yes,No,Yes,4000,Not Responding\n"
             "07-05-2026,C,9123400000,,Nagpur,440001,Third Shop,Meena S,No,,No,,\n")
    sales = {"retailers.csv": RETAILERS.encode(), "retailer_month.csv": MONTHS.encode(),
             "retailer_quarter.csv": QUARTERS.encode()}
    res = run({"Meta_Leads.csv": sheet.encode()}, sales, today=date(2026, 11, 9))
    p = res.payload
    assert p["hasFollowup"] and not p["hasContactDates"]
    L, owners = p["leads"], p["dims"]["owner"]
    assert sorted(set(owners)) == ["Meena S", "Ravi K"]                  # one spelling per ASM
    assert L["called"][:4] == [1, 1, 1, 0] and L["ordered"][:2] == [1, 1]  # repeat row carries the mobile's ASM set
    assert L["ordv"][0] == 12500 and L["selfEx"][0] == 1 and L["zdist"][0] >= 0  # Pune 411001 -> Dist A territory
    inp = I.load({"Meta_Leads.csv": sheet.encode()}, sales)
    log = []
    leads = prepare_leads(inp, log, date(2026, 11, 9))
    from app.leads.pipeline.match import match
    from app.leads.pipeline.classify import classify
    fh = Mx.followup_headlines(classify(match(leads, prepare_sales(inp, [])), prepare_sales(inp, [])),
                               prepare_sales(inp, []))
    assert (fh["leads"], fh["called"], fh["claimed"], fh["bo_billed"], fh["bo_not_billed"]) == (3, 2, 2, 1, 1)
    assert fh["median_value"] == 8250
    assert "Field follow-up" in res.memo


def test_lead_state_names_follow_bo_spelling():
    assert [N.state_name(s) for s in ("Tamil_Nadu", "UttarPradesh", "west  bengal", "Delhi", "Jammu And Kashmir", "")] == \
        ["Tamil Nadu", "Uttar Pradesh", "West Bengal", "Delhi Ncr", "Jammu", ""]


def test_sheet_cleaning_duplicates_junk_names_and_categories():
    """Fictional rows: a lead copied 3 times keeps the copy with follow-up; test / placeholder rows go; ASM spellings
    merge; free-typed categories fold into the short list; '1' + mobile is repaired."""
    head = "Id,created_time,full_name,phone_number,shop_name,ASM NAME,Calling Done,Category\n"
    rows = ["L1,10-04-2026,A,9876500001,Alpha Sports,,,"] * 2 + ["L1,10-04-2026,A,9876500001,Alpha Sports,Satish,Yes,Not intrested"]
    rows += [f"L{i},11-04-2026,P{i},98100000{i:02d},Shop {i},Satish,Yes,NOT RESPONDING" for i in range(2, 14)]
    rows += ["L20,12-04-2026,B,19123400001,,sATISH,Yes,pdf shared",            # '1' + mobile, shop blank -> person's name
             "L21,12-04-2026,test,9123400002,test,,,",
             "No leads found for odisha,No leads found for odisha,No leads found for odisha,No leads found for odisha,"
             "No leads found for odisha,,,"]
    res = run({"Meta_Leads.csv": (head + "\n".join(rows) + "\n").encode()},
              {"retailers.csv": RETAILERS.encode(), "retailer_month.csv": MONTHS.encode(),
               "retailer_quarter.csv": QUARTERS.encode()}, today=date(2026, 11, 9))
    p, L = res.payload, res.payload["leads"]
    assert len(L["day"]) == 14                                            # 1 + 12 + 1 lead rows
    assert p["dims"]["owner"] == ["Satish"]
    assert set(p["dims"]["status"]) == {"Not interested", "Not reachable", "Catalogue sent"}
    assert "9123400001" in L["mob"] and "B" in L["name"]
    steps = {s["step"] for s in p["steps"]}
    assert {"placeholder and test rows removed", "duplicate copies of the same lead removed", "mobiles repaired"} <= steps
