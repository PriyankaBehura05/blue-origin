"""
Benefit rules (Phase 6). Phase 1 only exposes the configurable category list.
Entitlement quantities/frequencies are deliberately absent until the business provides them.
"""
import json
from functools import lru_cache
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "config" / "benefits.json"


@lru_cache
def get_benefit_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def benefit_categories() -> list:
    return get_benefit_config()["categories"]
