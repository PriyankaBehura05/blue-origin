from typing import List

from fastapi import APIRouter, Depends, Response

from app.api.deps import DataRepository, get_repository
from app.core.constants import DatasetType
from app.core.errors import NotFoundError
from app.processing.dataset_specs import get_spec
from app.repositories.store_repository import dataset_path
from app.schemas.common import ApiResponse, ResponseMeta
from app.schemas.meta import DatasetStatus
from app.services.common import data_source_info

router = APIRouter(prefix="/datasets", tags=["Datasets"])


@router.get("", response_model=ApiResponse[List[DatasetStatus]], summary="What is stored in the data store")
def list_datasets(repo: DataRepository = Depends(get_repository)):
    out = []
    for info in repo.dataset_info():
        spec = get_spec(DatasetType(info.dataset))
        out.append(DatasetStatus(dataset=info.dataset, stored=info.stored, rows=info.rows, valid_rows=info.valid_rows,
                                 modified=info.modified, path=info.path, required_columns=spec.required,
                                 optional_columns=spec.optional))
    return ApiResponse(data=out, meta=ResponseMeta(data_source=data_source_info(repo)))


@router.post("/reload", response_model=ApiResponse[List[DatasetStatus]],
             summary="Drop the cache and re-read every dataset (after editing files directly in Dropbox)")
def reload(repo: DataRepository = Depends(get_repository)):
    repo.reload()
    return list_datasets(repo)


@router.get("/{dataset}/template", response_class=Response, summary="Empty CSV with the dataset's columns")
def template(dataset: DatasetType):
    spec = get_spec(dataset)
    header = ",".join(spec.all_columns) + "\n"
    return Response(content=header.encode("utf-8"), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{dataset.value}_template.csv"'})


@router.get("/{dataset}/download", response_class=Response, summary="The stored dataset CSV (backup / export)")
def download(dataset: DatasetType, repo: DataRepository = Depends(get_repository)):
    content = repo.store.read(dataset_path(dataset))
    if content is None:
        raise NotFoundError(f"No {dataset.value} data has been stored yet.", details={"dataset": dataset.value})
    return Response(content=content, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{dataset.value}.csv"'})
