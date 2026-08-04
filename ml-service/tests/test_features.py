import numpy as np
import pandas as pd
import pytest

from app.ml.features import FEATURE_COLUMNS, build_features, haversine_distance_meters

JFK = (40.6413, -73.7781)
LAX = (33.9416, -118.4085)


def test_haversine_matches_known_distance_within_one_percent():
    distance_km = haversine_distance_meters(JFK[0], JFK[1], LAX[0], LAX[1]) / 1000
    assert distance_km == pytest.approx(3983, rel=0.01)


def test_haversine_is_zero_for_the_same_point():
    assert haversine_distance_meters(37.7749, -122.4194, 37.7749, -122.4194) == pytest.approx(0)


def test_haversine_is_symmetric():
    a_to_b = haversine_distance_meters(JFK[0], JFK[1], LAX[0], LAX[1])
    b_to_a = haversine_distance_meters(LAX[0], LAX[1], JFK[0], JFK[1])
    assert a_to_b == pytest.approx(b_to_a)


def _sample_df(requested_at_utc: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "pickup_lat": 37.7749,
                "pickup_lng": -122.4194,
                "dropoff_lat": 37.8044,
                "dropoff_lng": -122.2712,
                "requested_at": pd.Timestamp(requested_at_utc, tz="UTC"),
            }
        ]
    )


def test_build_features_returns_exactly_the_documented_columns_in_order():
    df = _sample_df("2026-01-15T16:00:00Z")  # noon Pacific (UTC-8 in January)
    features = build_features(df)
    assert list(features.columns) == FEATURE_COLUMNS
    assert len(features) == 1


def test_build_features_does_not_require_any_ground_truth_construction_columns():
    # No time_of_day_multiplier / zone_density_factor / noise_factor / actual_* columns at all —
    # proves build_features can never accidentally depend on them.
    df = _sample_df("2026-01-15T16:00:00Z")
    assert "zone_density_factor" not in df.columns
    features = build_features(df)
    assert not features.isna().any().any()


def test_cyclical_hour_encoding_is_bounded_and_midnight_noon_are_maximally_different():
    midnight = build_features(_sample_df("2026-01-15T08:00:00Z"))  # 00:00 Pacific
    noon = build_features(_sample_df("2026-01-15T20:00:00Z"))  # 12:00 Pacific

    for col in ["hour_sin", "hour_cos", "dow_sin", "dow_cos"]:
        assert -1.0 <= midnight[col].iloc[0] <= 1.0

    # Midnight and noon are exactly half a day apart — maximally far apart on the 24h cycle,
    # so their (sin, cos) points should be near-antipodal (dot product close to -1).
    dot = (
        midnight["hour_sin"].iloc[0] * noon["hour_sin"].iloc[0]
        + midnight["hour_cos"].iloc[0] * noon["hour_cos"].iloc[0]
    )
    assert dot == pytest.approx(-1.0, abs=1e-6)


def test_cyclical_hour_encoding_treats_2359_and_0001_as_nearly_identical():
    just_before_midnight = build_features(_sample_df("2026-01-16T07:59:00Z"))  # 23:59 Pacific
    just_after_midnight = build_features(_sample_df("2026-01-15T08:01:00Z"))  # 00:01 Pacific

    distance = np.hypot(
        just_before_midnight["hour_sin"].iloc[0] - just_after_midnight["hour_sin"].iloc[0],
        just_before_midnight["hour_cos"].iloc[0] - just_after_midnight["hour_cos"].iloc[0],
    )
    assert distance < 0.05  # near-zero — a raw integer hour feature would instead jump 23 -> 0


def test_density_proxy_is_highest_at_city_center_and_decays_outward():
    from app.ml.constants import CITY_CENTER

    at_center = pd.DataFrame(
        [
            {
                "pickup_lat": CITY_CENTER["lat"],
                "pickup_lng": CITY_CENTER["lng"],
                "dropoff_lat": CITY_CENTER["lat"],
                "dropoff_lng": CITY_CENTER["lng"],
                "requested_at": pd.Timestamp("2026-01-15T16:00:00Z"),
            }
        ]
    )
    far_away = pd.DataFrame(
        [
            {
                "pickup_lat": 37.708,
                "pickup_lng": -122.514,
                "dropoff_lat": 37.708,
                "dropoff_lng": -122.514,
                "requested_at": pd.Timestamp("2026-01-15T16:00:00Z"),
            }
        ]
    )

    center_value = build_features(at_center)["midpoint_distance_from_center_km"].iloc[0]
    far_value = build_features(far_away)["midpoint_distance_from_center_km"].iloc[0]

    assert center_value == pytest.approx(0.0, abs=1e-6)
    assert far_value > center_value
