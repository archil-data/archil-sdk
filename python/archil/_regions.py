from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

_REGION_URLS: dict[str, str] = {
    "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
    "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
    "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
    "gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com",
}


def resolve_base_url(region: str) -> str:
    url = _REGION_URLS.get(region)
    if url is None:
        valid = ", ".join(_REGION_URLS)
        raise ValueError(f'Unknown region "{region}". Valid regions: {valid}')
    return url


def derive_s3_base_url(control_base_url: str) -> str | None:
    """Derive the S3-compatible endpoint from a control-plane base URL by swapping
    a leading ``control.`` hostname segment for ``s3.`` (e.g.
    ``control.green.us-east-1.…`` → ``s3.green.us-east-1.…``). Returns ``None`` if
    the URL can't be parsed; a host without a ``control.`` prefix is returned
    unchanged (minus any trailing slash)."""
    try:
        parts = urlsplit(control_base_url)
        if not parts.hostname:
            return None
        host = parts.hostname
        if host.startswith("control."):
            host = "s3." + host[len("control.") :]
        netloc = host
        if parts.port is not None:
            netloc = f"{host}:{parts.port}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment)).rstrip("/")
    except ValueError:
        return None
