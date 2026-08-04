import json
import logging

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sklearn.dummy import DummyRegressor

import app.main as main_module
from app.logger import JsonFormatter
from app.ml.features import FEATURE_COLUMNS


def _make_record(msg="hello", level=logging.INFO, fields=None) -> logging.LogRecord:
    record = logging.LogRecord(
        name="ml-service",
        level=level,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=None,
        exc_info=None,
    )
    if fields is not None:
        record.fields = fields
    return record


def test_json_formatter_produces_valid_json_with_the_expected_fields():
    record = _make_record()
    parsed = json.loads(JsonFormatter().format(record))

    assert parsed["level"] == "info"
    assert parsed["msg"] == "hello"
    assert parsed["logger"] == "ml-service"
    assert isinstance(parsed["time"], int)  # epoch ms, matching core's pino convention


def test_json_formatter_merges_extra_fields_into_the_payload():
    record = _make_record(fields={"method": "GET", "path": "/health", "statusCode": 200})
    parsed = json.loads(JsonFormatter().format(record))

    assert parsed["method"] == "GET"
    assert parsed["path"] == "/health"
    assert parsed["statusCode"] == 200


def test_json_formatter_lowercases_the_level_name():
    record = _make_record(level=logging.WARNING)
    parsed = json.loads(JsonFormatter().format(record))
    assert parsed["level"] == "warning"


@pytest.fixture
def client_with_model(monkeypatch):
    model = DummyRegressor(strategy="constant", constant=555.0)
    dummy_x = pd.DataFrame([[0.0] * len(FEATURE_COLUMNS)], columns=FEATURE_COLUMNS)
    model.fit(dummy_x, [555.0])
    monkeypatch.setattr(main_module, "_model", model)
    monkeypatch.setattr(main_module, "_model_metadata", {"version": "test-version"})
    return TestClient(main_module.app)


def test_request_logging_middleware_emits_one_structured_record_per_request(
    client_with_model, caplog
):
    """Same field names as core's src/plugins/request-logging.ts
    (method/path/statusCode/latencyMs) — a real request through the real middleware, not a
    hand-constructed record."""
    with caplog.at_level(logging.INFO, logger="ml-service"):
        res = client_with_model.get("/health")
    assert res.status_code == 200

    matching = [
        r
        for r in caplog.records
        if r.name == "ml-service" and r.getMessage() == "request completed"
    ]
    assert len(matching) == 1

    fields = matching[0].fields
    assert fields["method"] == "GET"
    assert fields["path"] == "/health"
    assert fields["statusCode"] == 200
    assert isinstance(fields["latencyMs"], float)
    assert fields["latencyMs"] >= 0
