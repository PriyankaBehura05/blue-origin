"""Shared constants and enums. Business thresholds do NOT live here - see app/rules/config/."""
from enum import Enum


class FileType(str, Enum):
    XLSX = "xlsx"
    XLS = "xls"
    CSV = "csv"


ALLOWED_EXTENSIONS = {".xlsx": FileType.XLSX, ".xls": FileType.XLS, ".csv": FileType.CSV}


class DatasetType(str, Enum):
    """Kinds of BO file the backend understands. Each is stored as datasets/<value>.csv in the data store."""
    SALES = "sales"
    RETAILERS = "retailers"
    DISTRIBUTORS = "distributors"
    BENEFITS = "benefits"          # benefit catalogue
    FULFILLMENTS = "fulfillments"  # benefit fulfilment records
    TARGETS = "targets"            # monthly sales targets


# Datasets whose rows carry an `id` column that the API can create / update / delete.
# Rows without an id get one assigned (PREFIX-0001, ...) when the dataset is stored.
EDITABLE_DATASET_ID_PREFIX = {
    DatasetType.BENEFITS: "BEN",
    DatasetType.FULFILLMENTS: "FUL",
}


class RecordStatus(str, Enum):
    """Row-level status. Questionable rows are flagged, never silently dropped."""
    VALID = "valid"
    INVALID = "invalid"            # value present but cannot be parsed / is impossible
    MISSING = "missing"            # a required value is blank
    DUPLICATE = "duplicate"        # exact repeat of an earlier row in the same file
    NEEDS_REVIEW = "needs_review"  # parseable, but suspicious or ambiguous


# Highest severity first; a row takes the most severe status among its issues.
STATUS_PRECEDENCE = [
    RecordStatus.INVALID,
    RecordStatus.MISSING,
    RecordStatus.DUPLICATE,
    RecordStatus.NEEDS_REVIEW,
    RecordStatus.VALID,
]


class Severity(str, Enum):
    ERROR = "error"
    WARNING = "warning"


# Values treated as blank after whitespace stripping (case-insensitive).
BLANK_TOKENS = {"", "-", "--", "na", "n/a", "null", "none", "nil", "nan", "#n/a"}

# Indian financial year starts in April. FY26 = Apr-2025 .. Mar-2026.
FY_START_MONTH = 4

# Pagination
DEFAULT_PAGE_SIZE = 15
MAX_PAGE_SIZE = 500

# Domain vocabularies exposed to the UI through /meta/filters
FULFILLMENT_STATUSES = ["Planned", "In Progress", "Fulfilled", "Overdue"]
BENEFIT_FREQUENCIES = ["One-time", "Quarterly", "Annual"]
# Tier movement of a retailer in a quarter vs the quarter before (first matching rule wins):
#   New                                first purchase ever is in this quarter
#   No sales                           bought in the previous quarter, nothing in this one
#   Upgraded / Downgraded / Stayed in same tier   on a tier now, compared with the previous quarter's tier
#   Dropped from the tier              buying below the lowest tier now, but was on a tier in an earlier quarter
#   Never been on tier but some sales  buying below the lowest tier and never reached a tier
MOVE_UP, MOVE_DOWN, MOVE_SAME = "Upgraded", "Downgraded", "Stayed in same tier"
MOVE_DROPPED, MOVE_NEVER, MOVE_NEW, MOVE_NONE = ("Dropped from the tier", "Never been on tier but some sales", "New",
                                                 "No sales")
MOVEMENT_DIRECTIONS = [MOVE_DOWN, MOVE_DROPPED, MOVE_NEVER, MOVE_NEW, MOVE_NONE, MOVE_SAME, MOVE_UP]
PAN_INDIA = "Pan-India"

UNRANKED = "Unranked"
