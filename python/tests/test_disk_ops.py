import uuid

import httpx
import pytest

from archil import ArchilApiError, AwsStsUser, Branch, Delegation, ExecMountSpec, TokenUser
from conftest import error_envelope, ok_envelope

DISK_JSON = {
    "id": "dsk-1",
    "name": "my-disk",
    "organization": "org-1",
    "status": "available",
    "provider": "aws",
    "region": "aws-us-east-1",
    "createdAt": "2026-01-01T00:00:00Z",
}


def _disk(archil, router):
    router.set(lambda req: ok_envelope(DISK_JSON))
    return archil.disks.get("dsk-1")


def test_add_user_serializes_token_user(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: ok_envelope({"type": "token", "identifier": "tok-1", "nickname": "ci"}))
    user = d.add_user(TokenUser(nickname="ci"))
    assert user.identifier == "tok-1"
    assert router.requests[-1].json == {"type": "token", "nickname": "ci"}


def test_add_user_awssts(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: ok_envelope({"type": "awssts", "identifier": "arn:x"}))
    d.add_user(AwsStsUser(principal="arn:x"))
    assert router.requests[-1].json == {"type": "awssts", "principal": "arn:x"}


def test_remove_user_query_param(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: ok_envelope(None))
    d.remove_user("token", "tok-1")
    req = router.requests[-1]
    assert req.method == "DELETE"
    assert req.path == "/api/disks/dsk-1/users/token"
    assert req.query["identifier"] == "tok-1"


def test_list_delegations(archil, router):
    d = _disk(archil, router)
    router.set(
        lambda req: ok_envelope(
            {
                "delegations": [
                    {
                        "clientId": "42",
                        "inodeId": 7,
                        "path": "dir/file.txt",
                        "isPending": False,
                        "isOrphaned": False,
                    },
                    {
                        "clientId": "99",
                        "inodeId": 10,
                        "isPending": True,
                        "isOrphaned": True,
                    },
                ]
            }
        )
    )

    assert d.list_delegations() == [
        Delegation(
            client_id="42",
            inode_id=7,
            path="dir/file.txt",
            is_pending=False,
            is_orphaned=False,
        ),
        Delegation(client_id="99", inode_id=10, is_pending=True, is_orphaned=True),
    ]
    req = router.requests[-1]
    assert req.method == "GET"
    assert req.path == "/api/disks/dsk-1/delegations"


def test_revoke_delegation(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: ok_envelope({"message": "Delegation revoked"}))
    delegation = Delegation(
        client_id="99",
        inode_id=10,
        path="stale/file.txt",
        is_pending=False,
        is_orphaned=True,
    )

    d.revoke_delegation(delegation)

    req = router.requests[-1]
    assert req.method == "POST"
    assert req.path == "/api/disks/dsk-1/revoke-delegation"
    assert req.json == {"clientId": "99", "inodeId": 10}


def test_allowed_ips_add_and_remove(archil, router):
    d = _disk(archil, router)
    state = {"ips": ["10.0.0.0/8"]}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "PUT":
            import json

            state["ips"] = json.loads(req.content)["allowedIps"]
        return ok_envelope({"allowedIps": state["ips"]})

    router.set(handler)
    after_add = d.add_allowed_ip("1.2.3.4")
    assert "1.2.3.4" in after_add
    # Idempotent add doesn't issue a PUT.
    puts_before = sum(1 for r in router.requests if r.method == "PUT")
    d.add_allowed_ip("1.2.3.4")
    puts_after = sum(1 for r in router.requests if r.method == "PUT")
    assert puts_after == puts_before
    after_remove = d.remove_allowed_ip("10.0.0.0/8")
    assert "10.0.0.0/8" not in after_remove


def test_allowed_ips_null_array(archil, router):
    d = _disk(archil, router)
    # Empty allowlist as JSON null must come back as [], and add must still work.
    router.set(lambda req: ok_envelope({"allowedIps": None}))
    assert d.get_allowed_ips() == []

    state = {"ips": None}

    def handler(req):
        if req.method == "PUT":
            import json
            state["ips"] = json.loads(req.content)["allowedIps"]
        return ok_envelope({"allowedIps": state["ips"]})

    router.set(handler)
    after = d.add_allowed_ip("1.2.3.4")  # must not TypeError on the null current list
    assert after == ["1.2.3.4"]


def test_exec_and_grep(archil, router):
    d = _disk(archil, router)
    router.set(
        lambda req: ok_envelope(
            {"exitCode": 0, "stdout": "hi", "stderr": "", "timing": {"totalMs": 5, "queueMs": 1, "executeMs": 4}}
        )
    )
    res = d.exec("echo hi")
    assert res.exit_code == 0 and res.stdout == "hi"
    assert res.timing.total_ms == 5
    assert router.requests[-1].json == {"command": "echo hi"}

    router.set(
        lambda req: ok_envelope(
            {
                "matches": [{"file": "a.log", "line": 3, "text": "ERROR x"}],
                "stoppedReason": "completed",
                "filesScanned": 1,
                "containersDispatched": 1,
                "computeSecondsUsed": 0.5,
                "durationMs": 10,
                "listingMs": 2,
                "grepMs": 3,
            }
        )
    )
    grep = d.grep(directory="logs", pattern="ERROR")
    assert grep.matches[0].line == 3
    assert grep.stopped_reason == "completed"

    # Go nil slice: "matches": null must yield [] rather than TypeError.
    router.set(
        lambda req: ok_envelope(
            {
                "matches": None,
                "stoppedReason": "completed",
                "filesScanned": 0,
                "containersDispatched": 0,
                "computeSecondsUsed": 0.0,
                "durationMs": 1,
                "listingMs": 0,
                "grepMs": 0,
            }
        )
    )
    empty = d.grep(directory="logs", pattern="nope")
    assert empty.matches == []
    body = router.requests[-1].json
    assert body["maxDurationSeconds"] == 30 and body["concurrency"] == 50 and body["maxResults"] == 1000


def test_share_default_expiry(archil, router):
    d = _disk(archil, router)
    share_url = "https://control.test/api/shared/tok.sig"
    router.set(lambda req: ok_envelope({"url": share_url, "expiresIn": 86400}))
    result = d.share("reports/2026-01/data.pdf")
    assert result.url == share_url
    assert result.expires_in == 86400
    req = router.requests[-1]
    assert req.method == "POST"
    assert req.path == "/api/disks/dsk-1/share"
    # Key goes in the body; no expiresIn sent when the caller omits it (server defaults).
    assert req.json == {"key": "reports/2026-01/data.pdf"}


def test_share_explicit_expiry_in_body(archil, router):
    d = _disk(archil, router)
    # Any positive integer is allowed, not just a fixed set of presets.
    router.set(lambda req: ok_envelope({"url": "https://x/api/shared/t", "expiresIn": 90}))
    # Reserved characters in the key need no encoding — it rides in the JSON body.
    result = d.share("my docs/q&a.txt", expires_in=90)
    assert result.expires_in == 90
    req = router.requests[-1]
    assert req.path == "/api/disks/dsk-1/share"
    assert req.json == {"key": "my docs/q&a.txt", "expiresIn": 90}


def test_archil_exec_payload_shapes(archil, router):
    d = _disk(archil, router)
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/exec":
            import json

            captured["body"] = json.loads(req.content)
            return ok_envelope(
                {"exitCode": 0, "stdout": "", "stderr": "", "timing": {"totalMs": 1, "queueMs": 0, "executeMs": 1}}
            )
        return ok_envelope(DISK_JSON)

    router.set(handler)
    archil.exec(
        disks={
            "data": d,  # a Disk → its id
            "raw": "dsk-2",  # a plain id string
            "logs": ExecMountSpec(disk="dsk-3", subdirectory="app/logs", read_only=True),
            "work": ExecMountSpec(disk="dsk-4", conditional=True),
        },
        command="ls",
    )
    assert captured["body"]["disks"] == {
        "data": "dsk-1",
        "raw": "dsk-2",
        "logs": {"disk": "dsk-3", "readOnly": True, "conditional": False, "subdirectory": "app/logs"},
        "work": {"disk": "dsk-4", "readOnly": False, "conditional": True},
    }
    assert captured["body"]["command"] == "ls"


BRANCH_JSON = {
    "root_filesystem_id": "dsk-1",
    "branch_name": "work",
    "filesystem_id": "dsk-2",
    "from_checkpoint_name": "cp1",
    "from_checkpoint_filesystem_id": "dsk-1",
    "created_at": "2026-10-07T00:00:00Z",
}

BRANCH = Branch(
    root_filesystem_id="dsk-1",
    branch_name="work",
    filesystem_id="dsk-2",
    from_checkpoint_name="cp1",
    from_checkpoint_filesystem_id="dsk-1",
    created_at="2026-10-07T00:00:00Z",
)


def test_create_branch_sends_spec_fields_and_uuid_idempotency_key(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: httpx.Response(201, json={"success": True, "data": BRANCH_JSON}))

    assert d.create_branch("work", "cp1", from_branch="base") == BRANCH

    req = router.requests[-1]
    assert req.method == "POST"
    assert req.path == "/api/disks/dsk-1/branches"
    assert req.json == {"branch_name": "work", "from_checkpoint_name": "cp1", "from_branch": "base"}
    uuid.UUID(req.headers["idempotency-key"])


def test_create_branch_omits_from_branch_when_unset(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: httpx.Response(201, json={"success": True, "data": BRANCH_JSON}))

    d.create_branch("work", "cp1")

    assert router.requests[-1].json == {"branch_name": "work", "from_checkpoint_name": "cp1"}


def test_create_branch_retries_with_the_same_idempotency_key(archil, router):
    d = _disk(archil, router)
    responses = iter(
        [
            error_envelope(504, "Request timed out"),
            httpx.Response(201, json={"success": True, "data": BRANCH_JSON}),
        ]
    )
    router.set(lambda req: next(responses))

    assert d.create_branch("work", "cp1") == BRANCH

    first, second = router.requests[-2:]
    assert first.path == second.path == "/api/disks/dsk-1/branches"
    assert first.headers["idempotency-key"] == second.headers["idempotency-key"]


def test_create_branch_uses_a_fresh_key_per_call(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: httpx.Response(201, json={"success": True, "data": BRANCH_JSON}))

    d.create_branch("a", "cp1")
    d.create_branch("b", "cp1")

    first, second = router.requests[-2:]
    assert first.headers["idempotency-key"] != second.headers["idempotency-key"]


def test_create_branch_sends_caller_supplied_idempotency_key(archil, router):
    d = _disk(archil, router)
    key = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    responses = iter(
        [
            error_envelope(504, "Request timed out"),
            httpx.Response(201, json={"success": True, "data": BRANCH_JSON}),
        ]
    )
    router.set(lambda req: next(responses))

    d.create_branch("work", "cp1", idempotency_key=key)

    assert [r.headers["idempotency-key"] for r in router.requests[-2:]] == [key, key]
    assert "idempotency_key" not in router.requests[-1].json


def test_create_branch_conflict_is_not_retried(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: error_envelope(409, 'Branch "work" already exists'))
    before = len(router.requests)

    with pytest.raises(ArchilApiError) as exc:
        d.create_branch("work", "cp1")

    assert exc.value.status == 409
    assert len(router.requests) - before == 1


def test_list_branches(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: ok_envelope([BRANCH_JSON]))

    assert d.list_branches() == [BRANCH]
    req = router.requests[-1]
    assert req.method == "GET"
    assert req.path == "/api/disks/dsk-1/branches"


def test_get_branch(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: ok_envelope(BRANCH_JSON))

    assert d.get_branch("work") == BRANCH
    req = router.requests[-1]
    assert req.method == "GET"
    assert req.path == "/api/disks/dsk-1/branches/work"


def test_get_branch_not_found(archil, router):
    d = _disk(archil, router)
    router.set(lambda req: error_envelope(404, 'Branch "missing" not found'))

    with pytest.raises(ArchilApiError) as exc:
        d.get_branch("missing")

    assert exc.value.status == 404
