"""
Lead Generation pipeline (pandas), rerunnable with new files: drop them in the inbox and the next build picks them up.

    inputs     read lead dumps, spend, follow-up log, targets (inbox) + the BO Dashboard's sales outputs (read-only)
    normalise  mobiles to the last 10 digits (strip +91 / 0), dates, months, sources, cities, names
    prep       clean frames, logging rows kept / dropped at every step
    match      lead -> retailer in 3 passes (exact mobile, alternate numbers, fuzzy name + pincode/city with a score);
               matching levels floor / likely / ceiling
    classify   five mutually exclusive outcomes per unique lead, for every level x attribution window (30/60/90)
    payload    the dashboard's column arrays (the browser applies the filters)
    metrics    headline numbers for the memo and the reconciliation sheet
    build      run it all -> payload, reconciliation workbook (.xlsx), findings memo (.md)

Command line (local folders, no Dropbox needed):
    python -m app.leads.pipeline --inbox <lead files folder> --sales <folder with retailers.csv, retailer_month.csv,
                                 retailer_quarter.csv> --out <output folder>
"""
from .build import Result, run  # noqa: F401
