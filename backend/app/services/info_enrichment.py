"""
Fills blank retailer details from the reference workbook in BO_INFO_FOLDER (/INFORMATION/BO_Consolidate_Final.xlsx,
sheet Final_Data: Code name, Retailer_Name, Distributor, Phone, Pincode, City, ...).

A consolidated retailer is matched within its own distributor, first on any of its phone numbers, else on its
cleaned name (any spelling it absorbed). Only blank values are filled - City, Pincode (6 digits) and Phone
(valid mobile) - nothing already known is overwritten. Applied to the pipeline output before it is stored:
retailers.csv (read by the connector) and dashboard_data.json (adds "ct" = city per retailer).
"""
import io
import json
import re
from pathlib import Path
from typing import Dict, Optional, Tuple

import pandas as pd

REFERENCE_FILE = "BO_Consolidate_Final.xlsx"
_SHEETS = ("Final_Data", "Consolidated_Tiered")
_REP = {"SPORT": "SPORTS", "GARMENT": "GARMENTS", "FASHIONS": "FASHION", "COLLECTIONS": "COLLECTION",
        "TRADER": "TRADERS", "ENTERPRISE": "ENTERPRISES", "HOSIERIES": "HOSIERY", "MENS": "MEN",
        "MENSWEAR": "MEN WEAR", "READYMADES": "READYMADE", "CLOTHINGS": "CLOTHING", "CENTER": "CENTRE",
        "SHREE": "SRI", "SHRI": "SRI", "SREE": "SRI"}
_MOBILE = re.compile(r"^[6-9]\d{9}$")


def name_key(s: str) -> str:
    """Same cleaning as compact() in bo_pipeline.py."""
    s = re.sub(r"^\s*M\s*/\s*S\.?\s*", "", str(s).upper()).replace("&", " AND ")
    s = re.sub(r"[^A-Z0-9]", " ", s)
    return "".join(_REP.get(t, t) for t in s.split() if t not in {"THE", "AND"})


def phone(v) -> str:
    d = re.sub(r"\D", "", re.sub(r"\.0$", "", str(v)))[-10:]
    return d if _MOBILE.match(d) and len(set(d)) > 2 else ""


def _pincode(v) -> str:
    d = re.sub(r"\.0$", "", str(v)).strip()
    return d if re.fullmatch(r"[1-9]\d{5}", d) else ""


def load_reference(content: bytes) -> pd.DataFrame:
    book = pd.ExcelFile(io.BytesIO(content))
    sheet = next((s for s in _SHEETS if s in book.sheet_names), book.sheet_names[0])
    df = book.parse(sheet, dtype=str).fillna("")
    need = {"Retailer_Name", "Distributor"}
    if not need <= set(df.columns):
        raise ValueError(f"{REFERENCE_FILE}: sheet '{sheet}' has no {', '.join(sorted(need - set(df.columns)))} column")
    for c in ("Phone", "Pincode", "City"):
        if c not in df:
            df[c] = ""
    return df


class _Index:
    def __init__(self, ref: pd.DataFrame):
        self.by_phone: Dict[Tuple[str, str], dict] = {}
        self.by_name: Dict[Tuple[str, str], dict] = {}
        for row in ref[["Distributor", "Retailer_Name", "Phone", "Pincode", "City"]].to_dict("records"):
            info = {"city": str(row["City"]).strip(), "pin": _pincode(row["Pincode"]), "phone": phone(row["Phone"])}
            if info["phone"]:
                self.by_phone.setdefault((row["Distributor"], info["phone"]), info)
            self.by_name.setdefault((row["Distributor"], name_key(row["Retailer_Name"])), info)

    def find(self, dist: str, phones, names) -> Tuple[Optional[dict], str]:
        for p in phones:
            hit = self.by_phone.get((dist, phone(p))) if phone(p) else None
            if hit:
                return hit, "phone"
        for n in names:
            hit = self.by_name.get((dist, name_key(n))) if n else None
            if hit:
                return hit, "name"
        return None, ""


def enrich(out_dir: Path, ref: pd.DataFrame) -> dict:
    """Fill blanks in out_dir/retailers.csv and out_dir/dashboard_data.json. Returns fill counts."""
    idx = _Index(ref)
    rpath = out_dir / "retailers.csv"
    r = pd.read_csv(rpath, dtype=str, keep_default_na=False)
    for c in ("City", "Pincode", "Phone", "Phone_Alt", "Name_Variants", "District"):
        if c not in r:
            r[c] = ""
    stats = {"matched_phone": 0, "matched_name": 0, "city": 0, "pincode": 0, "phone": 0}
    city, pin, ph = r["City"].tolist(), r["Pincode"].tolist(), r["Phone"].tolist()
    for i, row in enumerate(r.itertuples(index=False)):
        info, how = idx.find(row.Distributor, [row.Phone, *str(row.Phone_Alt).split(" | ")],
                             [row.Retailer_Name, *str(row.Name_Variants).split(" | ")])
        if not info:
            continue
        stats[f"matched_{how}"] += 1
        # the reference "City" is the post-office locality: used only when neither city nor district is known
        if not str(city[i]).strip() and not str(row.District).strip() and info["city"]:
            city[i] = info["city"]
            stats["city"] += 1
        if not str(pin[i]).strip() and info["pin"]:
            pin[i] = info["pin"]
            stats["pincode"] += 1
        if not str(ph[i]).strip() and info["phone"]:
            ph[i] = info["phone"]
            stats["phone"] += 1
    r["City"], r["Pincode"], r["Phone"] = city, pin, ph
    r.to_csv(rpath, index=False)

    jpath = out_dir / "dashboard_data.json"
    if jpath.exists():
        payload = json.loads(jpath.read_bytes())
        by_id = r.set_index("Retailer_ID")[["City", "Pincode", "Phone"]].to_dict("index")
        for rec in payload.get("retailers", []):
            x = by_id.get(rec["id"])
            if not x:
                continue
            if str(x["City"]).strip():
                rec["ct"] = str(x["City"]).strip().title()
            if not rec.get("pin") and str(x["Pincode"]).strip():
                rec["pin"] = str(x["Pincode"]).strip()
            if not rec.get("ph") and str(x["Phone"]).strip():
                rec["ph"] = str(x["Phone"]).strip()
        payload["enrichment"] = {"source": REFERENCE_FILE, **stats}
        jpath.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return stats
