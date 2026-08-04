from conftest import ok_envelope


def test_list_tokens(archil, router):
    router.set(lambda req: ok_envelope({"tokens": [{"id": "t1", "name": "ci", "tokenSuffix": "abcd"}]}))
    tokens = archil.tokens.list()
    assert tokens[0].id == "t1"
    assert tokens[0].name == "ci"
    assert tokens[0].token_suffix == "abcd"


def test_list_tokens_empty(archil, router):
    router.set(lambda req: ok_envelope({}))
    assert archil.tokens.list() == []


def test_list_tokens_null_array(archil, router):
    # Go backends serialize an empty/nil slice as JSON null — must not TypeError.
    router.set(lambda req: ok_envelope({"tokens": None}))
    assert archil.tokens.list() == []


def test_create_token_returns_full_value(archil, router):
    router.set(
        lambda req: ok_envelope(
            {"id": "t1", "name": "ci", "token": "key-secret"}, status=201
        )
    )
    created = archil.tokens.create(name="ci", description="bot")
    assert created.token == "key-secret"
    assert router.requests[-1].json == {"name": "ci", "description": "bot"}


def test_delete_token(archil, router):
    router.set(lambda req: ok_envelope({"message": "Token deleted"}))
    archil.tokens.delete("t1")
    assert router.requests[-1].method == "DELETE"
    assert router.requests[-1].path == "/api/tokens/t1"
