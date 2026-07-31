import pytest

from archil._regions import derive_s3_base_url, resolve_base_url


def test_resolve_known_region():
    assert resolve_base_url("aws-us-east-1") == "https://control.green.us-east-1.aws.prod.archil.com"


def test_resolve_unknown_region_lists_valid():
    with pytest.raises(ValueError) as exc:
        resolve_base_url("mars-1")
    assert "aws-us-east-1" in str(exc.value)


def test_derive_swaps_control_for_s3():
    assert (
        derive_s3_base_url("https://control.green.us-east-1.aws.prod.archil.com")
        == "https://s3.green.us-east-1.aws.prod.archil.com"
    )


def test_derive_preserves_port_and_strips_trailing_slash():
    # control. prefix is swapped; the port survives and the trailing slash is dropped.
    assert derive_s3_base_url("http://control.test:9000/") == "http://s3.test:9000"
    # A host without the control. prefix keeps its port unchanged.
    assert derive_s3_base_url("http://localhost:9000/") == "http://localhost:9000"


def test_derive_host_without_control_prefix_unchanged():
    assert derive_s3_base_url("https://example.com/api") == "https://example.com/api"
