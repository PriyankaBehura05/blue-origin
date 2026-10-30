"""
One call that runs the whole processing chain:
    read file -> normalise columns -> clean -> validate -> transform
Used by the upload service AND by the store repository, so stored data goes through
exactly the same path real BO files will.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import pandas as pd

from app.core.constants import DatasetType
from app.processing.data_transformer import transform
from app.processing.data_validator import ValidationResult, validate_dataframe
from app.processing.dataset_specs import get_spec
from app.processing.file_loader import read_tabular


@dataclass
class PipelineResult:
    validation: ValidationResult
    data: pd.DataFrame     # cleaned + derived fields; every source row retained


def run_pipeline(source: Union[str, Path, bytes], dataset: DatasetType,
                 filename: Optional[str] = None, sheet_name: Optional[str] = None) -> PipelineResult:
    raw = read_tabular(source, filename=filename, sheet_name=sheet_name)
    validation = validate_dataframe(raw, get_spec(dataset))
    data = transform(validation.clean, dataset) if validation.can_process else validation.clean
    return PipelineResult(validation, data)
