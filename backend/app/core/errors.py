"""
Application errors and global exception handlers.

Every error leaves the API in one shape:
    {"success": false, "error": {"code": "...", "message": "...", "details": {...}}}
Stack traces are logged server-side, never returned to the client.
"""
import logging
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("blue_origin")


class AppError(Exception):
    status_code = 400
    code = "BAD_REQUEST"

    def __init__(self, message: str, details: Optional[Any] = None, code: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.details = details
        if code:
            self.code = code


class InvalidFileError(AppError):
    status_code, code = 400, "INVALID_FILE"


class EmptyFileError(AppError):
    status_code, code = 400, "EMPTY_FILE"


class FileTooLargeError(AppError):
    status_code, code = 413, "FILE_TOO_LARGE"


class MissingColumnsError(AppError):
    status_code, code = 422, "MISSING_COLUMNS"


class InvalidFilterError(AppError):
    status_code, code = 400, "INVALID_FILTER"


class DuplicateUploadError(AppError):
    status_code, code = 409, "DUPLICATE_UPLOAD"


class NotFoundError(AppError):
    status_code, code = 404, "NOT_FOUND"


class UnauthorizedError(AppError):
    """No valid sign-in: the client should show the login page."""
    status_code, code = 401, "UNAUTHORIZED"


class ForbiddenError(AppError):
    """Signed in, but the user's role does not allow this."""
    status_code, code = 403, "FORBIDDEN"


class ConflictError(AppError):
    status_code, code = 409, "CONFLICT"


class TooManyAttemptsError(AppError):
    status_code, code = 429, "TOO_MANY_ATTEMPTS"


class DataNotAvailableError(AppError):
    status_code, code = 503, "DATA_NOT_AVAILABLE"


class StorageError(AppError):
    """The data store (Dropbox) could not be reached or refused the operation."""
    status_code, code = 503, "STORAGE_ERROR"


class ProcessingError(AppError):
    status_code, code = 500, "PROCESSING_FAILED"


class NotImplementedYetError(AppError):
    """Endpoint exists in the API contract but its module belongs to a later phase."""
    status_code, code = 501, "NOT_IMPLEMENTED_YET"

    def __init__(self, module: str, phase: Optional[int]):
        when = f"planned for Phase {phase}" if phase else "not yet scheduled"
        super().__init__(
            f"The '{module}' module is {when} and is not implemented yet.",
            details={"module": module, "planned_phase": phase},
        )


def _body(code: str, message: str, details: Any = None) -> dict:
    return {"success": False, "error": {"code": code, "message": message, "details": details}}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        if exc.status_code >= 500 and not isinstance(exc, NotImplementedYetError):
            log.error("%s: %s | %s", exc.code, exc.message, exc.details)
        return JSONResponse(status_code=exc.status_code, content=_body(exc.code, exc.message, exc.details))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        problems = [
            {"field": ".".join(str(p) for p in e.get("loc", []) if p != "body"), "message": e.get("msg")}
            for e in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=_body("REQUEST_VALIDATION_ERROR", "Some request parameters are invalid.", problems),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(status_code=exc.status_code, content=_body(code, str(exc.detail)))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error")  # full trace goes to server logs only
        return JSONResponse(
            status_code=500,
            content=_body("INTERNAL_ERROR", "An unexpected error occurred. Please contact the BO team."),
        )
