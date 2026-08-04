import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sklearn.dummy import DummyRegressor

import app.main as main_module
from app.ml.features import FEATURE_COLUMNS

VALID_PAYLOAD = {
    "pickup": {"lat": 37.7749, "lng": -122.4194},
    "dropoff": {"lat": 37.8044, "lng": -122.2712},
    "timestamp": "2026-01-15T16:00:00Z",
}


@pytest.fixture
def client_with_model(monkeypatch):
    # A constant-output dummy model isolates endpoint plumbing/validation from anything about
    # real model quality (that's what scripts/train_model.py's own evaluation output covers).
    model = DummyRegressor(strategy="constant", constant=555.0)
    dummy_x = pd.DataFrame([[0.0] * len(FEATURE_COLUMNS)], columns=FEATURE_COLUMNS)
    model.fit(dummy_x, [555.0])

    monkeypatch.setattr(main_module, "_model", model)
    monkeypatch.setattr(main_module, "_model_metadata", {"version": "test-version"})
    return TestClient(main_module.app)


@pytest.fixture
def client_without_model(monkeypatch):
    monkeypatch.setattr(main_module, "_model", None)
    monkeypatch.setattr(main_module, "_model_metadata", None)
    return TestClient(main_module.app)


def test_predict_eta_returns_503_when_no_model_has_been_trained_yet(client_without_model):
    res = client_without_model.post("/predict-eta", json=VALID_PAYLOAD)
    assert res.status_code == 503
    assert "train_model.py" in res.json()["detail"]


def test_predict_eta_happy_path_returns_prediction_and_model_version(client_with_model):
    res = client_with_model.post("/predict-eta", json=VALID_PAYLOAD)
    assert res.status_code == 200
    body = res.json()
    assert body["predicted_duration_seconds"] == 555.0
    assert body["model_version"] == "test-version"
    assert body["distance_meters"] > 0


def test_predict_eta_accepts_a_naive_timestamp_and_treats_it_as_utc(client_with_model):
    payload = {**VALID_PAYLOAD, "timestamp": "2026-01-15T16:00:00"}  # no offset
    res = client_with_model.post("/predict-eta", json=payload)
    assert res.status_code == 200


@pytest.mark.parametrize(
    "bad_pickup",
    [
        {"lat": 200, "lng": -122.4194},  # lat out of range
        {"lat": 37.7749, "lng": -200},  # lng out of range
        {"lat": -91, "lng": 0},
        {"lat": 0, "lng": 181},
    ],
)
def test_predict_eta_rejects_out_of_range_coordinates_with_4xx_not_a_crash(
    client_with_model, bad_pickup
):
    payload = {**VALID_PAYLOAD, "pickup": bad_pickup}
    res = client_with_model.post("/predict-eta", json=payload)
    assert 400 <= res.status_code < 500
    assert res.json()["detail"]  # a real, structured error body, not an empty crash response


def test_predict_eta_rejects_a_malformed_timestamp_with_4xx(client_with_model):
    payload = {**VALID_PAYLOAD, "timestamp": "not-a-real-timestamp"}
    res = client_with_model.post("/predict-eta", json=payload)
    assert 400 <= res.status_code < 500


def test_predict_eta_rejects_a_missing_required_field_with_4xx(client_with_model):
    payload = {"pickup": VALID_PAYLOAD["pickup"], "timestamp": VALID_PAYLOAD["timestamp"]}
    res = client_with_model.post("/predict-eta", json=payload)  # dropoff missing
    assert 400 <= res.status_code < 500
