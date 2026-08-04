"""Versioned model persistence — trained once by scripts/train_model.py, loaded once at
serving-process startup (app/main.py), never retrained in-process on a request. Each training run
writes a new timestamp-versioned .joblib file (never overwrites a prior one) plus a `latest.json`
pointer recording which file is current and the metadata (feature list, metrics, row counts, date
range) it was trained with — so an old model artifact is never silently overwritten, and the
metadata needed to sanity-check *which* model is currently serving is available without having to
unpickle it.
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import joblib

DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[2] / "models"
LATEST_POINTER_FILENAME = "latest.json"


def save_model(
    model: Any,
    *,
    feature_names: list[str],
    metrics: dict[str, Any],
    training_row_count: int,
    test_row_count: int,
    date_range_min: str,
    date_range_max: str,
    models_dir: Path = DEFAULT_MODELS_DIR,
) -> Path:
    models_dir.mkdir(parents=True, exist_ok=True)

    version = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"eta_model_{version}.joblib"
    model_path = models_dir / filename
    joblib.dump(model, model_path)

    metadata = {
        "version": version,
        "filename": filename,
        "trained_at": datetime.now(UTC).isoformat(),
        "feature_names": feature_names,
        "metrics": metrics,
        "training_row_count": training_row_count,
        "test_row_count": test_row_count,
        "date_range": {"min": date_range_min, "max": date_range_max},
    }
    pointer_path = models_dir / LATEST_POINTER_FILENAME
    pointer_path.write_text(json.dumps(metadata, indent=2))

    return model_path


def load_latest_model(
    models_dir: Path = DEFAULT_MODELS_DIR,
) -> tuple[Any | None, dict[str, Any] | None]:
    """Returns (model, metadata), or (None, None) if no model has ever been trained yet — callers
    (app/main.py's /predict-eta) must handle that case explicitly (503, not a crash)."""
    pointer_path = models_dir / LATEST_POINTER_FILENAME
    if not pointer_path.exists():
        return None, None

    metadata = json.loads(pointer_path.read_text())
    model_path = models_dir / metadata["filename"]
    model = joblib.load(model_path)
    return model, metadata
