from __future__ import annotations

from datetime import datetime
from xml.etree import ElementTree as ET

# S3 XML responses carry a default namespace, so ElementTree tags arrive as
# "{http://s3.amazonaws.com/doc/2006-03-01/}Contents". We match on the local
# name throughout and never hard-code the namespace URI.


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if _local(child.tag) == name]


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if _local(child.tag) == name:
            return (child.text or "").strip()
    return None


def _to_int(value: str | None, default: int) -> int:
    """Parse integer XML text leniently. A well-formed listing with a non-numeric
    ``Size`` / ``KeyCount`` degrades to ``default`` instead of raising a bare
    ValueError that would bypass the SDK's structured-error path (mirrors the JS
    SDK's ``Number(... ?? 0)`` leniency)."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _parse_last_modified(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        # S3 emits RFC 3339 / ISO 8601 with a trailing "Z".
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_error(body: str) -> dict[str, str | None]:
    """Extract Code/Message/RequestId from an S3 ``<Error>`` document. Returns a
    dict of ``None`` values when the body isn't parseable XML — error bodies
    aren't always XML (e.g. a proxy 5xx), and building an error must never raise."""
    fields: dict[str, str | None] = {"code": None, "message": None, "request_id": None}
    if not body.strip():
        return fields
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return fields
    # The body is usually a bare <Error> document, but tolerate it being wrapped.
    target = root if _local(root.tag) == "Error" else next(
        (e for e in root.iter() if _local(e.tag) == "Error"), root
    )
    fields["code"] = _child_text(target, "Code")
    fields["message"] = _child_text(target, "Message")
    fields["request_id"] = _child_text(target, "RequestId")
    return fields


def parse_list_objects(body: str) -> dict:
    """Parse an S3 ``<ListBucketResult>`` document into the fields the SDK
    surfaces. Returns a plain dict consumed by ``Disk._list_objects_page``."""
    objects: list[dict] = []
    common_prefixes: list[str] = []
    result = {
        "objects": objects,
        "common_prefixes": common_prefixes,
        "is_truncated": False,
        "next_continuation_token": None,
        "key_count": None,
        "prefix": None,
    }
    if not body.strip():
        return result

    root = ET.fromstring(body)

    for contents in _children(root, "Contents"):
        objects.append(
            {
                "key": _child_text(contents, "Key") or "",
                "size": _to_int(_child_text(contents, "Size"), 0),
                "etag": _child_text(contents, "ETag"),
                "last_modified": _parse_last_modified(_child_text(contents, "LastModified")),
            }
        )

    for cp in _children(root, "CommonPrefixes"):
        prefix = _child_text(cp, "Prefix")
        if prefix is not None:
            common_prefixes.append(prefix)

    truncated = _child_text(root, "IsTruncated")
    result["is_truncated"] = truncated == "true"
    result["next_continuation_token"] = _child_text(root, "NextContinuationToken")
    key_count = _child_text(root, "KeyCount")
    result["key_count"] = _to_int(key_count, len(objects)) if key_count is not None else len(objects)
    result["prefix"] = _child_text(root, "Prefix")
    return result


def _escape(value: str) -> str:
    """Escape text for safe inclusion in XML element content."""
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_delete_request(keys: list[str], quiet: bool) -> str:
    """Build a ``<Delete>`` request body for the DeleteObjects API."""
    objects = "".join(f"<Object><Key>{_escape(k)}</Key></Object>" for k in keys)
    quiet_tag = "<Quiet>true</Quiet>" if quiet else ""
    return f'<?xml version="1.0" encoding="UTF-8"?><Delete>{objects}{quiet_tag}</Delete>'


def build_complete_multipart_upload(parts: list[tuple[int, str]]) -> str:
    """Build a ``<CompleteMultipartUpload>`` body from ``(part_number, etag)`` pairs."""
    body = "".join(
        f"<Part><PartNumber>{n}</PartNumber><ETag>{_escape(etag)}</ETag></Part>"
        for n, etag in parts
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<CompleteMultipartUpload>{body}</CompleteMultipartUpload>"
    )


def parse_initiate_multipart_upload(body: str) -> dict:
    """Parse an S3 ``<InitiateMultipartUploadResult>`` document."""
    root = ET.fromstring(body)
    return {
        "upload_id": _child_text(root, "UploadId"),
        "key": _child_text(root, "Key"),
        "bucket": _child_text(root, "Bucket"),
    }


def parse_complete_multipart_upload(body: str) -> dict:
    """Parse an S3 ``<CompleteMultipartUploadResult>`` document."""
    root = ET.fromstring(body)
    return {
        "etag": _child_text(root, "ETag"),
        "location": _child_text(root, "Location"),
        "bucket": _child_text(root, "Bucket"),
        "key": _child_text(root, "Key"),
    }


def parse_delete_result(body: str) -> dict:
    """Parse an S3 ``<DeleteResult>`` document into ``deleted`` keys and ``errors``."""
    deleted: list[str] = []
    errors: list[dict] = []
    result = {"deleted": deleted, "errors": errors}
    if not body.strip():
        return result
    root = ET.fromstring(body)
    for d in _children(root, "Deleted"):
        key = _child_text(d, "Key")
        if key is not None:
            deleted.append(key)
    for e in _children(root, "Error"):
        errors.append(
            {
                "key": _child_text(e, "Key") or "",
                "code": _child_text(e, "Code"),
                "message": _child_text(e, "Message"),
            }
        )
    return result


def parse_list_parts(body: str) -> dict:
    """Parse an S3 ``<ListPartsResult>`` document."""
    parts: list[dict] = []
    result = {
        "parts": parts,
        "is_truncated": False,
        "part_number_marker": 0,
        "next_part_number_marker": None,
        "max_parts": 0,
        "bucket": None,
        "key": None,
        "upload_id": None,
    }
    if not body.strip():
        return result
    root = ET.fromstring(body)
    for p in _children(root, "Part"):
        parts.append(
            {
                "part_number": _to_int(_child_text(p, "PartNumber"), 0),
                "size": _to_int(_child_text(p, "Size"), 0),
                "etag": _child_text(p, "ETag"),
                "last_modified": _parse_last_modified(_child_text(p, "LastModified")),
            }
        )
    result["is_truncated"] = _child_text(root, "IsTruncated") == "true"
    result["part_number_marker"] = _to_int(_child_text(root, "PartNumberMarker"), 0)
    next_marker = _child_text(root, "NextPartNumberMarker")
    result["next_part_number_marker"] = _to_int(next_marker, 0) if next_marker is not None else None
    result["max_parts"] = _to_int(_child_text(root, "MaxParts"), len(parts))
    result["bucket"] = _child_text(root, "Bucket")
    result["key"] = _child_text(root, "Key")
    result["upload_id"] = _child_text(root, "UploadId")
    return result


def parse_list_multipart_uploads(body: str) -> dict:
    """Parse an S3 ``<ListMultipartUploadsResult>`` document."""
    uploads: list[dict] = []
    common_prefixes: list[str] = []
    result = {
        "uploads": uploads,
        "common_prefixes": common_prefixes,
        "is_truncated": False,
        "bucket": None,
        "key_marker": None,
        "upload_id_marker": None,
        "next_key_marker": None,
        "next_upload_id_marker": None,
        "prefix": None,
        "delimiter": None,
        "max_uploads": None,
    }
    if not body.strip():
        return result
    root = ET.fromstring(body)
    for u in _children(root, "Upload"):
        uploads.append(
            {
                "key": _child_text(u, "Key") or "",
                "upload_id": _child_text(u, "UploadId") or "",
                "initiated": _parse_last_modified(_child_text(u, "Initiated")),
            }
        )
    for cp in _children(root, "CommonPrefixes"):
        prefix = _child_text(cp, "Prefix")
        if prefix is not None:
            common_prefixes.append(prefix)
    result["is_truncated"] = _child_text(root, "IsTruncated") == "true"
    result["bucket"] = _child_text(root, "Bucket")
    result["key_marker"] = _child_text(root, "KeyMarker")
    result["upload_id_marker"] = _child_text(root, "UploadIdMarker")
    result["next_key_marker"] = _child_text(root, "NextKeyMarker")
    result["next_upload_id_marker"] = _child_text(root, "NextUploadIdMarker")
    result["prefix"] = _child_text(root, "Prefix")
    result["delimiter"] = _child_text(root, "Delimiter")
    max_uploads = _child_text(root, "MaxUploads")
    result["max_uploads"] = _to_int(max_uploads, 0) if max_uploads is not None else None
    return result
