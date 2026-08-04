import pytest

from archil import ArchilApiError, ArchilError, ArchilS3Error
from archil.errors import parse_s3_error


def test_error_hierarchy():
    assert issubclass(ArchilApiError, ArchilError)
    assert issubclass(ArchilS3Error, ArchilError)


def test_parse_s3_error_extracts_fields():
    body = "<Error><Code>NoSuchKey</Code><Message>missing</Message><RequestId>r9</RequestId></Error>"
    err = parse_s3_error("GetObject", 404, "Not Found", body)
    assert err.status == 404
    assert err.code == "NoSuchKey"
    assert err.request_id == "r9"
    assert err.raw == body
    assert "GetObject" in str(err) and "NoSuchKey" in str(err) and "missing" in str(err)


def test_parse_s3_error_non_xml_body():
    err = parse_s3_error("PutObject", 502, "Bad Gateway", "<html>oops</html>")
    assert err.status == 502
    assert err.code is None
    # Falls back to the status text in the message.
    assert "Bad Gateway" in str(err)


def test_archil_error_is_catchable_as_base():
    with pytest.raises(ArchilError):
        raise ArchilS3Error(operation="GetObject", status_code=403, code="AccessDenied")
