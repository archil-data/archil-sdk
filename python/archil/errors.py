from __future__ import annotations

from ._s3xml import parse_error


class ArchilError(Exception):
    """Base class for every error the SDK raises. Catch with
    ``except ArchilError`` to handle control-plane and S3 failures uniformly.
    ``status`` is the HTTP status code and ``code`` a machine-readable error code
    when the server provided one."""

    def __init__(self, message: str, status: int, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class ArchilApiError(ArchilError):
    """Error from the control-plane REST API."""


class SandboxStartError(ArchilError):
    """The sandbox entered an inactive state before startup completed."""

    def __init__(self, sandbox: object) -> None:
        status = getattr(sandbox, "status", "unknown")
        exit_reason = getattr(sandbox, "exit_reason", None)
        detail = f": {exit_reason}" if exit_reason else ""
        super().__init__(
            f"Sandbox entered {status} before it started{detail}",
            409,
            "SANDBOX_START_FAILED",
        )
        self.latest = sandbox


class SandboxFileTransferError(ArchilError):
    def __init__(self, operation: str, path: str, detail: str) -> None:
        super().__init__(
            f"Sandbox file {operation} failed for {path}: {detail}",
            500,
            "SANDBOX_FILE_TRANSFER_FAILED",
        )
        self.operation = operation
        self.path = path


class ArchilS3Error(ArchilError):
    """Error from the S3-compatible object API (``get_object`` / ``put_object`` /
    ``delete_object`` / ``head_object`` / ``list_objects``). The gateway returns
    an S3-style XML ``<Error>`` body; this surfaces its parts as structured fields
    (``status``, ``code``, ``request_id``) while keeping the full body on ``raw``
    for debugging."""

    def __init__(
        self,
        *,
        operation: str,
        status_code: int,
        status_text: str | None = None,
        code: str | None = None,
        message: str | None = None,
        request_id: str | None = None,
        raw: str = "",
    ) -> None:
        detail = message or status_text or ""
        code_part = f" {code}" if code else ""
        suffix = f" — {detail}" if detail else ""
        super().__init__(
            f"S3 {operation} failed: {status_code}{code_part}{suffix}",
            status_code,
            code,
        )
        self.request_id = request_id
        self.raw = raw


def parse_s3_error(operation: str, status_code: int, status_text: str, body: str) -> ArchilS3Error:
    fields = parse_error(body)
    return ArchilS3Error(
        operation=operation,
        status_code=status_code,
        status_text=status_text,
        code=fields["code"],
        message=fields["message"],
        request_id=fields["request_id"],
        raw=body,
    )
