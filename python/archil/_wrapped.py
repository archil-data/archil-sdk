"""Public client classes: the async impl classes wrapped by synchronicity into
blocking-plus-async interfaces.

Kept separate from ``__init__`` (and from the impl modules) so the type-stub
generator only emits a stub for THIS module — the pattern Modal uses. ``__init__``
re-exports these names; do not add an ``__init__.pyi`` (a generated whole-package
stub re-declares the model dataclasses as distinct types and breaks pyright)."""

from ._archil import _Archil
from ._disk import _Disk, _DiskMultipart
from ._disks import _Disks
from ._sandbox import _Sandbox, _SandboxExec
from ._sandbox_files import _SandboxFiles
from ._sandbox_process import _SandboxProcess, _SandboxProcesses
from ._sandboxes import _Sandboxes
from ._synchronizer import synchronizer
from ._tokens import _Tokens
from ._workspace import _Workspace

Archil = synchronizer.wrap(_Archil, name="Archil", target_module=__name__)
Disks = synchronizer.wrap(_Disks, name="Disks", target_module=__name__)
# Wrap Multipart before Disk so its impl->wrapped mapping is registered when the
# Disk.multipart property's return value is translated.
Multipart = synchronizer.wrap(_DiskMultipart, name="Multipart", target_module=__name__)
Disk = synchronizer.wrap(_Disk, name="Disk", target_module=__name__)
SandboxExec = synchronizer.wrap(_SandboxExec, name="SandboxExec", target_module=__name__)
SandboxFiles = synchronizer.wrap(_SandboxFiles, name="SandboxFiles", target_module=__name__)
SandboxProcess = synchronizer.wrap(_SandboxProcess, name="SandboxProcess", target_module=__name__)
SandboxProcesses = synchronizer.wrap(_SandboxProcesses, name="SandboxProcesses", target_module=__name__)
Sandbox = synchronizer.wrap(_Sandbox, name="Sandbox", target_module=__name__)
Sandboxes = synchronizer.wrap(_Sandboxes, name="Sandboxes", target_module=__name__)
Tokens = synchronizer.wrap(_Tokens, name="Tokens", target_module=__name__)
Workspace = synchronizer.wrap(_Workspace, name="Workspace", target_module=__name__)
