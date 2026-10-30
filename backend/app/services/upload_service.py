"""
Upload service: validate-only, store-and-validate, activate, and upload history.

Uploaded files are stored unchanged in the data store under uploads/. History lives in
uploads/_upload_history.json. Activating an upload writes its rows (canonical column names,
as text) to datasets/<dataset>.csv - replacing the dataset, or appending to it - which makes
it the live data every page reads.
"""
import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import pandas as pd

from app.core.config import Settings
from app.core.constants import DatasetType
from app.core.errors import (DuplicateUploadError, EmptyFileError, FileTooLargeError, InvalidFilterError,
                             NotFoundError, ProcessingError)
from app.processing.data_cleaner import normalize_columns
from app.processing.data_transformer import to_records
from app.processing.data_validator import ValidationResult
from app.processing.dataset_specs import get_spec
from app.processing.file_loader import detect_file_type, read_tabular
from app.processing.pipeline import run_pipeline
from app.repositories.base import DataRepository
from app.repositories.store_repository import dataset_path
from app.schemas.upload import ActivationResult, UploadRecord, UploadResult, ValidationIssueOut, ValidationReportOut
from app.storage.base import UPLOADS_DIR, BlobStore

_LOCK = threading.RLock()
HISTORY_PATH = f"{UPLOADS_DIR}/_upload_history.json"


def _check_size(content: bytes, settings: Settings, filename: str) -> None:
    if not content:
        raise EmptyFileError("The uploaded file is empty.", details={"filename": filename})
    if len(content) > settings.max_upload_bytes:
        raise FileTooLargeError(f"File exceeds the {settings.MAX_UPLOAD_MB} MB limit.",
                                details={"filename": filename, "size_bytes": len(content)})


def build_report(v: ValidationResult, data, filename: str, sheet_name: Optional[str],
                 settings: Settings) -> ValidationReportOut:
    limit = settings.VALIDATION_ISSUE_LIMIT
    preview = to_records(data.head(settings.PREVIEW_ROWS)) if len(data.columns) else []
    return ValidationReportOut(
        dataset=v.dataset, filename=filename, sheet_name=sheet_name, total_rows=v.total_rows,
        can_process=v.can_process, status_counts=v.status_counts, column_mapping=v.column_mapping,
        missing_required_columns=v.missing_required_columns, unrecognised_columns=v.unrecognised_columns,
        file_errors=[ValidationIssueOut(**i.as_dict()) for i in v.file_errors],
        file_warnings=[ValidationIssueOut(**i.as_dict()) for i in v.file_warnings],
        issues=[ValidationIssueOut(**i.as_dict()) for i in v.issues[:limit]],
        issues_total=len(v.issues), issues_truncated=len(v.issues) > limit, preview=preview,
    )


def validate_file(content: bytes, filename: str, dataset: DatasetType, sheet_name: Optional[str],
                  settings: Settings) -> ValidationReportOut:
    _check_size(content, settings, filename)
    result = run_pipeline(content, dataset, filename=filename, sheet_name=sheet_name)
    return build_report(result.validation, result.data, filename, sheet_name, settings)


# ------------------------------------------------------------------ history
def _read_history(store: BlobStore) -> List[dict]:
    raw = store.read(HISTORY_PATH)
    return json.loads(raw.decode("utf-8")) if raw else []


def _write_history(store: BlobStore, rows: List[dict]) -> None:
    store.write(HISTORY_PATH, json.dumps(rows, indent=2).encode("utf-8"))


def list_history(store: BlobStore) -> List[UploadRecord]:
    return sorted((UploadRecord(**r) for r in _read_history(store)), key=lambda r: r.uploaded_at, reverse=True)


def _safe_name(filename: str) -> str:
    stem, suffix = Path(filename).stem, Path(filename).suffix.lower()
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._") or "upload"
    return f"{stem[:80]}{suffix}"


def store_upload(repo: DataRepository, content: bytes, filename: str, dataset: DatasetType,
                 sheet_name: Optional[str], settings: Settings, allow_duplicate: bool = False) -> UploadResult:
    _check_size(content, settings, filename)
    detect_file_type(filename, content)
    sha = hashlib.sha256(content).hexdigest()
    store = repo.store

    with _LOCK:
        history = _read_history(store)
        if not allow_duplicate:
            dup = next((h for h in history if h["sha256"] == sha and h["dataset"] == dataset.value), None)
            if dup:
                raise DuplicateUploadError(
                    "This exact file was already uploaded for this dataset.",
                    details={"existing_upload_id": dup["upload_id"], "uploaded_at": dup["uploaded_at"],
                             "hint": "Pass allow_duplicate=true to store it again."},
                )
        result = run_pipeline(content, dataset, filename=filename, sheet_name=sheet_name)
        report = build_report(result.validation, result.data, filename, sheet_name, settings)

        now = datetime.now(timezone.utc)
        upload_id = uuid.uuid4().hex[:12]
        stored = f"{now:%Y%m%d_%H%M%S}_{upload_id}_{_safe_name(filename)}"
        store.write(f"{UPLOADS_DIR}/{stored}", content)

        record = UploadRecord(
            upload_id=upload_id, original_filename=filename, stored_filename=stored, dataset=dataset.value,
            sha256=sha, size_bytes=len(content), uploaded_at=now, total_rows=report.total_rows,
            can_process=report.can_process, status_counts=report.status_counts, sheet_name=sheet_name,
        )
        history.append(json.loads(record.model_dump_json()))
        _write_history(store, history)
    return UploadResult(upload=record, report=report)


# ------------------------------------------------------------------ activation
def canonical_table(content: bytes, filename: str, sheet_name: Optional[str], dataset: DatasetType) -> pd.DataFrame:
    """A file's rows as text with canonical column names (exactly what the validator saw)."""
    spec = get_spec(DatasetType(dataset))
    raw = read_tabular(content, filename=filename, sheet_name=sheet_name)
    table, _ = normalize_columns(raw, spec.aliases)
    return table.astype(str).replace({"nan": ""})


def activate_upload(repo: DataRepository, upload_id: str, mode: str = "replace") -> ActivationResult:
    if mode not in ("replace", "append"):
        raise InvalidFilterError("mode must be 'replace' or 'append'.", details={"mode": mode})
    store = repo.store
    with _LOCK:
        history = _read_history(store)
        entry = next((h for h in history if h["upload_id"] == upload_id), None)
        if entry is None:
            raise NotFoundError(f"Upload '{upload_id}' was not found.", details={"upload_id": upload_id})
        record = UploadRecord(**entry)
        if not record.can_process:
            raise InvalidFilterError("This upload has file-level errors and cannot be activated. "
                                     "Fix the file and upload it again.", details={"upload_id": upload_id},
                                     code="UPLOAD_NOT_PROCESSABLE")
        content = store.read(f"{UPLOADS_DIR}/{record.stored_filename}")
        if content is None:
            raise ProcessingError("The stored upload file is missing from the data store.",
                                  details={"stored_filename": record.stored_filename})

        dataset = DatasetType(record.dataset)
        table = canonical_table(content, record.stored_filename, record.sheet_name, dataset)
        if mode == "append":
            existing = repo.raw_table(dataset)
            table = pd.concat([existing, table], ignore_index=True).fillna("")
        repo.save_table(dataset, table)

        now = datetime.now(timezone.utc)
        entry.update(processed=True, activated_at=now.isoformat(), activation_mode=mode)
        _write_history(store, history)
    return ActivationResult(upload=UploadRecord(**entry), dataset=dataset.value, mode=mode,
                            rows_stored=len(table), path=dataset_path(dataset))
