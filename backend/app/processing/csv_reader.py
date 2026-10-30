"""CSV reading. Everything is read as text so pincodes, codes and amounts keep their original form."""
from io import BytesIO
from typing import Union

import pandas as pd

ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")


def read_csv(content: Union[bytes, str]) -> pd.DataFrame:
    """Read CSV bytes/text. Tries common encodings (Excel on Windows often saves cp1252)."""
    if isinstance(content, str):
        content = content.encode("utf-8")
    last_err = None
    for enc in ENCODINGS:
        try:
            return pd.read_csv(
                BytesIO(content), dtype=str, keep_default_na=False, encoding=enc,
                sep=None, engine="python",  # sniff , ; \t
                skip_blank_lines=True,
            )
        except UnicodeDecodeError as err:
            last_err = err
            continue
        except pd.errors.EmptyDataError:
            return pd.DataFrame()
    raise last_err  # pragma: no cover
