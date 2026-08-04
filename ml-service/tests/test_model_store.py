from sklearn.dummy import DummyRegressor

from app.ml.model_store import load_latest_model, save_model


def _fit_dummy(constant: float) -> DummyRegressor:
    model = DummyRegressor(strategy="constant", constant=constant)
    model.fit([[0.0]], [constant])
    return model


def test_load_latest_model_returns_none_when_nothing_has_been_trained_yet(tmp_path):
    model, metadata = load_latest_model(models_dir=tmp_path)
    assert model is None
    assert metadata is None


def test_save_then_load_round_trips_the_model_and_metadata(tmp_path):
    model = _fit_dummy(123.0)
    save_model(
        model,
        feature_names=["a", "b"],
        metrics={"random_forest": {"mae": 1.0, "rmse": 2.0}},
        training_row_count=80,
        test_row_count=20,
        date_range_min="2026-01-01",
        date_range_max="2026-01-30",
        models_dir=tmp_path,
    )

    loaded_model, metadata = load_latest_model(models_dir=tmp_path)
    assert loaded_model is not None
    assert loaded_model.predict([[0.0]])[0] == 123.0
    assert metadata["feature_names"] == ["a", "b"]
    assert metadata["training_row_count"] == 80
    assert metadata["test_row_count"] == 20
    assert metadata["date_range"] == {"min": "2026-01-01", "max": "2026-01-30"}
    assert "version" in metadata and "trained_at" in metadata


def test_two_consecutive_saves_produce_distinct_files_and_latest_points_at_the_newest(tmp_path):
    save_model(
        _fit_dummy(1.0),
        feature_names=["a"],
        metrics={},
        training_row_count=1,
        test_row_count=1,
        date_range_min="2026-01-01",
        date_range_max="2026-01-01",
        models_dir=tmp_path,
    )
    _, first_metadata = load_latest_model(models_dir=tmp_path)

    save_model(
        _fit_dummy(2.0),
        feature_names=["a"],
        metrics={},
        training_row_count=1,
        test_row_count=1,
        date_range_min="2026-01-02",
        date_range_max="2026-01-02",
        models_dir=tmp_path,
    )
    second_model, second_metadata = load_latest_model(models_dir=tmp_path)

    assert first_metadata["filename"] != second_metadata["filename"]
    # Both artifact files still exist on disk — a retrain never destroys the prior version.
    assert (tmp_path / first_metadata["filename"]).exists()
    assert (tmp_path / second_metadata["filename"]).exists()
    # latest.json now points at the second (newer) run's model.
    assert second_model.predict([[0.0]])[0] == 2.0
