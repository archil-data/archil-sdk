from archil._s3xml import parse_error, parse_list_objects

NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'


def test_parse_list_objects_contents_and_prefixes():
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult {NS}>
      <Prefix>reports/</Prefix>
      <KeyCount>2</KeyCount>
      <IsTruncated>false</IsTruncated>
      <Contents>
        <Key>reports/a.txt</Key>
        <Size>11</Size>
        <ETag>"abc"</ETag>
        <LastModified>2026-01-02T03:04:05.000Z</LastModified>
      </Contents>
      <Contents>
        <Key>reports/b.txt</Key>
        <Size>0</Size>
      </Contents>
      <CommonPrefixes><Prefix>reports/sub/</Prefix></CommonPrefixes>
    </ListBucketResult>"""
    result = parse_list_objects(xml)
    assert result["prefix"] == "reports/"
    assert result["key_count"] == 2
    assert result["is_truncated"] is False
    assert [o["key"] for o in result["objects"]] == ["reports/a.txt", "reports/b.txt"]
    assert result["objects"][0]["size"] == 11
    assert result["objects"][0]["etag"] == '"abc"'
    assert result["objects"][0]["last_modified"] is not None
    assert result["objects"][0]["last_modified"].year == 2026
    assert result["common_prefixes"] == ["reports/sub/"]


def test_parse_list_objects_truncated_with_token():
    xml = f"""<ListBucketResult {NS}>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>TOKEN123</NextContinuationToken>
      <Contents><Key>k</Key><Size>1</Size></Contents>
    </ListBucketResult>"""
    result = parse_list_objects(xml)
    assert result["is_truncated"] is True
    assert result["next_continuation_token"] == "TOKEN123"
    # KeyCount absent → falls back to len(objects).
    assert result["key_count"] == 1


def test_parse_list_objects_non_numeric_numbers_degrade():
    # Well-formed XML but garbage Size/KeyCount must not raise ValueError.
    xml = f"""<ListBucketResult {NS}>
      <KeyCount>lots</KeyCount>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>k</Key><Size>huge</Size></Contents>
    </ListBucketResult>"""
    result = parse_list_objects(xml)
    assert result["objects"][0]["size"] == 0  # non-numeric Size → 0
    assert result["key_count"] == 1           # non-numeric KeyCount → len(objects)


def test_parse_list_objects_empty_body():
    result = parse_list_objects("")
    assert result["objects"] == []
    assert result["is_truncated"] is False


def test_parse_error_fields():
    xml = "<Error><Code>NoSuchKey</Code><Message>nope</Message><RequestId>r1</RequestId></Error>"
    fields = parse_error(xml)
    assert fields == {"code": "NoSuchKey", "message": "nope", "request_id": "r1"}


def test_parse_error_non_xml_is_safe():
    assert parse_error("502 Bad Gateway") == {"code": None, "message": None, "request_id": None}
    assert parse_error("") == {"code": None, "message": None, "request_id": None}
