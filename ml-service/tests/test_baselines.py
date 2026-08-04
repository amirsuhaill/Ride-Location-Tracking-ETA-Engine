import pandas as pd
import pytest

from app.ml.baselines import (
    heuristic_baseline_predict,
    naive_baseline_predict,
    rush_hour_multiplier,
)


def test_rush_hour_multiplier_matches_the_core_table_exactly():
    # Mirrors core/src/services/eta-heuristic.ts's RUSH_HOUR_TABLE — see app/ml/constants.py.
    assert rush_hour_multiplier(8) == 1.4
    assert rush_hour_multiplier(17) == 1.5
    assert rush_hour_multiplier(2) == 1.0
    assert rush_hour_multiplier(12) == 1.0


def test_rush_hour_multiplier_window_boundaries_are_start_inclusive_end_exclusive():
    assert rush_hour_multiplier(7) == 1.4  # start of morning window
    assert rush_hour_multiplier(9) == 1.0  # just past it


def test_naive_baseline_is_a_direct_passthrough_of_the_stored_column():
    df = pd.DataFrame({"naive_duration_seconds": [100.0, 250.5, 0.0]})
    result = naive_baseline_predict(df)
    assert list(result) == [100.0, 250.5, 0.0]


def test_heuristic_baseline_applies_the_rush_hour_multiplier_to_the_naive_duration():
    df = pd.DataFrame(
        {
            "naive_duration_seconds": [100.0, 100.0, 100.0],
            "requested_at": [
                pd.Timestamp("2026-01-15T16:00:00Z"),  # 08:00 Pacific -> rush hour, 1.4x
                pd.Timestamp("2026-01-15T20:00:00Z"),  # 12:00 Pacific -> off-peak, 1.0x
                pd.Timestamp("2026-01-16T01:00:00Z"),  # 17:00 Pacific -> rush hour, 1.5x
            ],
        }
    )
    result = heuristic_baseline_predict(df)
    assert result[0] == pytest.approx(140.0)
    assert result[1] == pytest.approx(100.0)
    assert result[2] == pytest.approx(150.0)
