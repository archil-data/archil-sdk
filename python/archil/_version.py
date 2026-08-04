from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _version

try:
    __version__ = _version("archil")
except PackageNotFoundError:
    # Running from a source tree without install metadata (e.g. a bare checkout).
    __version__ = "0.0.0+unknown"

# User-Agent sent on every control-plane request, distinct from the JS SDK's
# (archil-js/...) so the control plane can tell the clients apart.
USER_AGENT = f"archil-python/{__version__}"
