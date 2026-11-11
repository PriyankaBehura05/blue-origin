"""Normalise mobiles, dates, months, sources, cities and names so leads and retailers can be compared."""
from __future__ import annotations

import re
from datetime import date
from typing import Optional

import pandas as pd

_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def mobile(raw: object) -> str:
    """Last 10 digits after stripping +91 / 91 / 0; '' when it is not a valid Indian mobile (6-9 start, not all one digit)."""
    s = str(raw or "").strip()
    if re.fullmatch(r"\d+\.0+", s):          # Excel number read as text: 9876543210.0
        s = s.split(".")[0]
    if re.fullmatch(r"\d(\.\d+)?[eE]\+?\d+", s):
        try:
            s = str(int(float(s)))
        except ValueError:
            return ""
    d = re.sub(r"\D", "", s)
    # country code / trunk prefix typed in any mix in front of the 10 digits: 91, 0, 091, 0091, and the lone "1" a
    # dropped 9 of +91 leaves behind ("19876543210"); only ever the front is cut, so the last 10 digits are the mobile
    if len(d) > 10 and re.fullmatch(r"(0|1|91|0?91|00?91|9191|191|911)", d[:-10]):
        d = d[-10:]
    if len(d) != 10 or d[0] not in "6789" or len(set(d)) == 1:
        return ""
    return d


def mobile_repaired(raw: object) -> bool:
    """True when mobile() had to repair the number (not a plain 10 digits, +91 / 91 / 0 / 091 + 10 digits)."""
    d = re.sub(r"\D", "", str(raw or ""))
    plain = len(d) == 10 or (len(d) == 12 and d.startswith("91")) or (len(d) == 11 and d.startswith("0")) or \
        (len(d) == 13 and d.startswith("091"))
    return not plain and mobile(raw) != ""


def mobiles(raw: object) -> list[str]:
    """Every valid mobile in a cell that may hold several ('98.. | 97..', '98.., 97..')."""
    parts = re.split(r"[|,;/]+|\s{2,}", str(raw or ""))
    seen = []
    for p in parts:
        m = mobile(p)
        if m and m not in seen:
            seen.append(m)
    return seen


def lead_date(raw: object) -> Optional[date]:
    s = str(raw or "").strip()
    if not s:
        return None
    if re.fullmatch(r"\d{5}(\.\d+)?", s):    # Excel serial day
        d = pd.Timestamp("1899-12-30") + pd.Timedelta(days=float(s))
        return d.date()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)  # ISO, also '2026-05-03T10:22:11+05:30'
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    d = pd.to_datetime(s, errors="coerce", dayfirst=True)
    return None if pd.isna(d) else d.date()


def month_int(d: date) -> int:
    return d.year * 12 + d.month - 1


def month_label(m: int) -> str:
    return f"{m // 12}-{m % 12 + 1:02d}"


def sales_month(label: str) -> Optional[int]:
    """'Sept_24' / 'July_25' / 'Jun_26' -> month int."""
    m = re.match(r"^([A-Za-z]{3})[A-Za-z]*[ _-]?(\d{2,4})$", str(label).strip())
    if not m or m[1].lower() not in _MONTHS:
        return None
    y = int(m[2])
    y = y + 2000 if y < 100 else y
    return y * 12 + _MONTHS[m[1].lower()] - 1


def fy_quarter(m: int) -> str:
    """Financial-year quarter key (April-March, FY named after the year it ends): 2026-07 -> 'Q2_FY27'."""
    y, mo = m // 12, m % 12 + 1
    q = (mo - 4) % 12 // 3 + 1
    fy = y + 1 if mo >= 4 else y
    return f"Q{q}_FY{fy % 100:02d}"


def spend_month(raw: object) -> Optional[int]:
    s = str(raw or "").strip()
    m = sales_month(s.replace(" ", "_"))
    if m is not None:
        return m
    m2 = re.match(r"^(\d{4})-(\d{1,2})$", s)
    if m2:
        return int(m2[1]) * 12 + int(m2[2]) - 1
    d = lead_date(s)
    return month_int(d) if d else None


def flag(raw: object) -> int:
    """Yes / No cell of an ASM sheet: 1 yes, 0 no, -1 blank or anything else ("Na", "No leads found for ...")."""
    s = str(raw or "").strip().lower()
    if s in ("yes", "y", "done", "true", "1"):
        return 1
    if s in ("no", "n", "not done", "false", "0"):
        return 0
    return -1


def amount(raw: object) -> float:
    """₹ amount in a sheet cell ('₹12,500', '12500.00'); 0 when blank or unreadable."""
    try:
        return max(float(re.sub(r"[₹,\s]|rs\.?|inr", "", str(raw or ""), flags=re.I) or 0), 0.0)
    except ValueError:
        return 0.0


# lead-sheet spellings -> the state names the BO data uses (Delhi is "Delhi NCR", J&K is "Jammu" there)
STATE_ALIASES = {"Delhi": "Delhi Ncr", "New Delhi": "Delhi Ncr", "Ncr": "Delhi Ncr", "Jammu And Kashmir": "Jammu",
                 "Jammu & Kashmir": "Jammu", "Orissa": "Odisha", "Tamilnadu": "Tamil Nadu", "Chattisgarh": "Chhattisgarh",
                 "Uttaranchal": "Uttarakhand", "Pondicherry": "Puducherry", "Westbengal": "West Bengal"}


def state_name(raw: object) -> str:
    """'Tamil_Nadu', 'UttarPradesh', 'west bengal', 'Delhi' -> 'Tamil Nadu', 'Uttar Pradesh', 'West Bengal', 'Delhi Ncr'."""
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(raw or "").strip())
    s = re.sub(r"[_\s]+", " ", s).strip().title()
    return STATE_ALIASES.get(s, s)


# What happened on the call, in plain words: the ASMs' free-typed Category (69 spellings) folded into one list.
# First matching rule wins, so specific phrases come before general ones ("not interested" before "interested").
CATEGORY_RULES = [
    ("Converted", r"\bconverted\b|order placed"),
    ("Already a customer", r"existing customer|exciting customer|already buyer|^retailer$"),
    ("Wants distributorship", r"distrib\w* *$|wants? to be (a )?distrib|distributorship"),
    ("Franchise enquiry", r"franchise"),
    ("Outside our area", r"other ?s[ta]a?te|ohter|different territory|from odisha|not from|buyer is from"),
    ("Not interested", r"not in?te?re?s?ted|not intrested"),
    ("Not reachable", r"not respond|not picking|not connecting|not reachable|in meeting|busy"),
    ("Wrong number", r"invalid|incorrect number|wrong number|not in service|us in correct"),
    ("No shop / consumer", r"consumer|no shop|don'?t have any shop|planing to open|m[ae]dical shop|buying new shop"),
    ("Catalogue sent", r"p\.?d\.?f|catalogue|catalog"),
    ("Distributor visit", r"distib|distributor visit|distributor office"),
    ("Interested", r"in?te?re?s?ted|intrest|interest|future prospect|will (call|start|check|come)|after a week|next month|place order|revert"),
    ("Commercial", r"commercial"),
    ("Pending", r"pending"),
]


def category(raw: object) -> str:
    s = re.sub(r"\s+", " ", str(raw or "").strip().lower())
    if not s:
        return ""
    for label, rule in CATEGORY_RULES:
        if re.search(rule, s):
            return label
    return "Other note"


SOURCES = ["Meta", "Google", "JustDial", "Print", "Other"]


def source(raw: object, file_name: str = "") -> str:
    """The platform named in the source value; when it names none (blank, or e.g. a state sub-sheet name), the one
    named in the file / tab name (Meta_Leads.csv, "Google Sheet - Google_Leads")."""
    found = _platform(str(raw or ""))
    return found if found != "Other" or not file_name else _platform(file_name)


def _platform(text: str) -> str:
    s = re.sub(r"[_\-.]+", " ", text).lower()
    if any(w in s for w in ("meta", "facebook", "instagram", "insta")) or re.search(r"\b(fb|ig)\b", s):
        return "Meta"
    if any(w in s for w in ("google", "adwords", "youtube", "gads", "search ads")):
        return "Google"
    if "justdial" in s or "just dial" in s or re.search(r"\bjd\b", s):
        return "JustDial"
    if any(w in s for w in ("print", "newspaper", "paper", "pamphlet", "flyer", "hoarding", "magazine")):
        return "Print"
    return "Other"


def city_key(raw: object) -> str:
    s = re.sub(r"[^a-z ]+", " ", str(raw or "").lower())
    s = re.sub(r"\b(city|district|dist|urban|rural|east|west|north|south)\b", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return {"bangalore": "bengaluru", "bombay": "mumbai", "madras": "chennai", "calcutta": "kolkata", "gurgaon": "gurugram",
            "allahabad": "prayagraj", "vizag": "visakhapatnam", "trivandrum": "thiruvananthapuram", "mysore": "mysuru",
            "mangalore": "mangaluru", "belgaum": "belagavi", "baroda": "vadodara", "cochin": "kochi", "pondicherry": "puducherry",
            "orissa": "odisha"}.get(s, s)


def pincode(raw: object) -> str:
    d = re.sub(r"\D", "", str(raw or ""))
    return d if len(d) == 6 and d[0] != "0" else ""


_NAME_NOISE = re.compile(r"\b(the|and|shop|store|stores|sports?|wear|garments?|readymades?|hosiery|traders?|enterprises?|"
                         r"collections?|fashions?|mart|centre|center|pvt|ltd|llp|co|m s|ms)\b")


def name_key(raw: object) -> str:
    s = re.sub(r"\(.*?\)", " ", str(raw or "").lower())
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = _NAME_NOISE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


# City tiers for the untapped pool (HRA classification X / Y; everything else Tier 3)
TIER1 = {"mumbai", "delhi", "new delhi", "bengaluru", "chennai", "kolkata", "hyderabad", "pune", "ahmedabad"}
TIER2 = {
    "agra", "ajmer", "aligarh", "amravati", "amritsar", "asansol", "aurangabad", "bareilly", "belagavi", "bhavnagar",
    "bhiwandi", "bhopal", "bhubaneswar", "bikaner", "bokaro", "chandigarh", "coimbatore", "cuttack", "dehradun", "dhanbad",
    "durg", "bhilai", "durgapur", "erode", "faridabad", "firozabad", "ghaziabad", "gorakhpur", "gulbarga", "kalaburagi",
    "guntur", "gurugram", "guwahati", "gwalior", "hubli", "dharwad", "indore", "jabalpur", "jaipur", "jalandhar", "jammu",
    "jamnagar", "jamshedpur", "jhansi", "jodhpur", "kakinada", "kannur", "kanpur", "kochi", "kolhapur", "kollam", "kota",
    "kozhikode", "kurnool", "lucknow", "ludhiana", "madurai", "malappuram", "mathura", "mangaluru", "meerut", "moradabad",
    "mysuru", "nagpur", "nanded", "nashik", "nellore", "noida", "patna", "puducherry", "prayagraj", "raipur", "rajkot",
    "rajahmundry", "ranchi", "rourkela", "salem", "sangli", "shimla", "siliguri", "solapur", "srinagar", "surat",
    "thanjavur", "thiruvananthapuram", "thrissur", "tiruchirappalli", "trichy", "tirunelveli", "tiruppur", "ujjain",
    "vadodara", "varanasi", "vasai virar", "vijayawada", "visakhapatnam", "warangal", "davanagere", "bellary", "ballari",
    "tumakuru", "shivamogga", "vellore", "hosur", "berhampur", "sambalpur", "navi mumbai", "thane", "howrah",
}


def city_tier(key: str) -> str:
    if key in TIER1:
        return "Tier 1"
    if key in TIER2:
        return "Tier 2"
    return "Tier 3" if key else "Unknown"
