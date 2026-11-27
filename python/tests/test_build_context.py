import gzip
import io
import os
import tarfile

import pytest

import archil._build_context as build_context
from archil._build_context import pack_context


def write(root, relative: str, content: str = "x") -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def members(data: bytes) -> dict[str, tarfile.TarInfo]:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        return {member.name: member for member in tar.getmembers()}


def test_pack_leaves_out_what_dockerignore_excludes(tmp_path):
    for relative in [
        "app/main.py",
        "app/debug.log",
        "node_modules/left/index.js",
        "build/keep.txt",
        "build/drop.txt",
        "docs/a/b/notes.md",
        "secret.env",
    ]:
        write(tmp_path, relative)
    write(
        tmp_path,
        ".dockerignore",
        "# dependencies\nnode_modules\n**/*.log\n/build\n!build/keep.txt\ndocs/**/*.md\n*.env\n",
    )

    names = set(members(pack_context(tmp_path)[0]))

    assert names == {".dockerignore", "app", "app/main.py", "build/keep.txt", "docs", "docs/a", "docs/a/b"}


def test_pack_is_the_same_for_the_same_files(tmp_path):
    write(tmp_path, "src/main.c", "int main(void) { return 0; }\n")
    os.symlink("src/main.c", tmp_path / "main.c")
    first = pack_context(tmp_path)
    os.utime(tmp_path / "src" / "main.c", (1_000_000, 1_000_000))

    second = pack_context(tmp_path)

    assert first == second
    entries = members(second[0])
    assert entries["main.c"].issym() and entries["main.c"].linkname == "src/main.c"
    assert {(m.mtime, m.uid, m.gid, m.uname) for m in entries.values()} == {(0, 0, 0, "")}
    assert gzip.decompress(second[0])


def test_pack_keeps_the_executable_bit(tmp_path):
    write(tmp_path, "run.sh", "#!/bin/sh\n")
    (tmp_path / "run.sh").chmod(0o755)

    assert members(pack_context(tmp_path)[0])["run.sh"].mode == 0o755


def test_pack_refuses_a_context_over_the_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(build_context, "MAX_CONTEXT_BYTES", 64)
    write(tmp_path, "random.bin", os.urandom(4096).hex())

    with pytest.raises(ValueError, match="over"):
        pack_context(tmp_path)


def test_pack_requires_a_directory(tmp_path):
    with pytest.raises(ValueError, match="not a directory"):
        pack_context(tmp_path / "missing")
