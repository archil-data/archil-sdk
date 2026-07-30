import httpx

from archil import AwsStsUser, Delegation, ExecMountSpec, TokenUser
from conftest import ok_envelope

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
    assert router.requests[-1].extensions["timeout"]["read"] is None

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
    assert router.requests[-1].extensions["timeout"]["read"] is None

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
    assert router.requests[-1].extensions["timeout"]["read"] is None
