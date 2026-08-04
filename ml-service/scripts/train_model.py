#!/usr/bin/env python3
"""Standalone retraining script — run any time more trip data accumulates, no code changes
needed. Loads training_trips from Postgres, engineers features, does a chronological (not
random) train/test split, trains a RandomForestRegressor, evaluates it against two trivial
baselines on the held-out test set, and persists a new versioned model artifact. See
docs/eta-model.md for the full design and a real captured run's output.

Phase 15 (docs/osrm-routing.md) additionally computes each trip's real OSRM road-network
duration and trains a SECOND, comparison-only RandomForestRegressor with that duration added as
an extra feature, evaluated on the identical held-out test rows as the production model — so the
reported MAE/RMSE delta reflects only the added feature, not a different test set. That
comparison model is deliberately never persisted via save_model: /predict-eta's live feature
pipeline (app/ml/features.py) has no OSRM feature, so serving it would silently misalign the
feature vector. Only the original (OSRM-free) model is saved, exactly as Phase 9 did — matching
the standalone-module scope already established for the sharding/geohash modules on the core
side (see docs/sharding.md's scope note).

Usage (from ml-service/, with DATABASE_URL and OSRM_URL set via .env or the environment):
    python scripts/train_model.py
    python scripts/train_model.py --n-estimators 300 --max-depth 15
"""

import argparse
import concurrent.futures
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.ml.baselines import heuristic_baseline_predict, naive_baseline_predict  # noqa: E402
from app.ml.data import load_training_data  # noqa: E402
from app.ml.features import build_features  # noqa: E402
from app.ml.model_store import save_model  # noqa: E402
from app.ml.osrm_client import fetch_osrm_route  # noqa: E402
from app.ml.split import DEFAULT_TEST_SIZE, time_based_split  # noqa: E402

# Number of concurrent OSRM requests while computing the per-trip duration feature. httpx
# releases the GIL during the actual network wait, so threads (not processes) give a real
# speedup against a local OSRM container without any of the complexity of multiprocessing.
OSRM_FETCH_WORKERS = 8

# RandomForestRegressor's own internal randomness (bootstrap sampling, feature subsampling per
# split) — reproducible per-run, same seeded-reproducibility ethos as the rest of this project
# (core/scripts/seed.ts, core/scripts/lib/trip-simulator.ts). This is NOT the train/test split,
# which is chronological and has no randomness to seed.
RANDOM_STATE = 42


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n-estimators", type=int, default=200)
    parser.add_argument("--max-depth", type=int, default=12)
    parser.add_argument("--min-samples-leaf", type=int, default=5)
    parser.add_argument("--test-size", type=float, default=DEFAULT_TEST_SIZE)
    return parser.parse_args()


def evaluate(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    mae = mean_absolute_error(y_true, y_pred)
    rmse = float(np.sqrt(mean_squared_error(y_true, y_pred)))
    return {"mae": mae, "rmse": rmse}


def compute_osrm_durations(df: pd.DataFrame, osrm_url: str, timeout_seconds: float) -> pd.Series:
    """Calls a real OSRM instance once per trip (pickup -> dropoff), in parallel. Returns a
    same-indexed Series of duration in seconds, with NaN wherever OSRM explicitly reported no
    route ("no route found" — e.g. a point on this project's road-network extract's edge — is a
    real, expected outcome, not an error to crash on) or was otherwise unreachable/slow/malformed
    — the caller decides how to handle NaNs (here: drop and log, see main()), never silently
    imputed by this function.
    """

    def fetch_one(row) -> float:
        result = fetch_osrm_route(
            osrm_url,
            row.pickup_lat,
            row.pickup_lng,
            row.dropoff_lat,
            row.dropoff_lng,
            timeout_seconds,
        )
        if not result.ok:
            return float("nan")
        return result.route.duration_seconds

    rows = list(df.itertuples(index=False))
    with concurrent.futures.ThreadPoolExecutor(max_workers=OSRM_FETCH_WORKERS) as pool:
        durations = list(pool.map(fetch_one, rows))

    return pd.Series(durations, index=df.index, name="osrm_duration_seconds")


def main() -> None:
    args = parse_args()

    print("Loading training data from training_trips...")
    df = load_training_data()
    if len(df) == 0:
        print(
            "No rows in training_trips — run `npm run simulate:trips` in core/ first.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(
        f"Loaded {len(df)} rows, date range {df['requested_at'].min()} .. "
        f"{df['requested_at'].max()}"
    )

    train_df, test_df = time_based_split(df, test_size=args.test_size)
    # The split is chronological by construction, but this is exactly the kind of thing that
    # should be *verified*, not just assumed — a future refactor of time_based_split could
    # silently break it.
    assert train_df["requested_at"].max() <= test_df["requested_at"].min(), (
        "train/test split leaked future rows into training — this must never happen"
    )
    print(
        f"Train: {len(train_df)} rows ({train_df['requested_at'].min()} .. "
        f"{train_df['requested_at'].max()})"
    )
    print(
        f"Test:  {len(test_df)} rows ({test_df['requested_at'].min()} .. "
        f"{test_df['requested_at'].max()}) — chronologically after every train row"
    )

    X_train = build_features(train_df)
    X_test = build_features(test_df)
    y_train = train_df["actual_duration_seconds"].to_numpy(dtype=float)
    y_test = test_df["actual_duration_seconds"].to_numpy(dtype=float)

    model = RandomForestRegressor(
        n_estimators=args.n_estimators,
        max_depth=args.max_depth,
        min_samples_leaf=args.min_samples_leaf,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    model_pred = model.predict(X_test)
    naive_pred = naive_baseline_predict(test_df)
    heuristic_pred = heuristic_baseline_predict(test_df)

    results = {
        "naive_baseline": evaluate(y_test, naive_pred),
        "heuristic_baseline": evaluate(y_test, heuristic_pred),
        "random_forest": evaluate(y_test, model_pred),
    }

    print(f"\n=== Evaluation on held-out test set (chronologically last {args.test_size:.0%}) ===")
    print(f"{'predictor':<20}{'MAE (s)':>12}{'RMSE (s)':>12}")
    for name, m in results.items():
        print(f"{name:<20}{m['mae']:>12.1f}{m['rmse']:>12.1f}")

    naive_mae = results["naive_baseline"]["mae"]
    heuristic_mae = results["heuristic_baseline"]["mae"]
    model_mae = results["random_forest"]["mae"]

    print(
        f"\nRandom forest vs naive baseline:     "
        f"{(1 - model_mae / naive_mae) * 100:+.1f}% MAE"
    )
    print(
        f"Random forest vs heuristic baseline: "
        f"{(1 - model_mae / heuristic_mae) * 100:+.1f}% MAE"
    )

    importances = dict(zip(X_train.columns, model.feature_importances_.tolist(), strict=True))
    print("\nFeature importances:")
    for name, importance in sorted(importances.items(), key=lambda kv: -kv[1]):
        print(f"  {name:<36}{importance:.3f}")

    # --- Phase 15: OSRM road-network duration as an additional feature (docs/osrm-routing.md) ---
    # Computed on train_df/test_df exactly as split above, so the held-out test rows are
    # identical to the ones the production model (saved below) was just evaluated on — only rows
    # OSRM genuinely couldn't route are dropped (logged), never the split boundary itself.
    osrm_url = settings.osrm_url
    osrm_timeout_seconds = settings.osrm_timeout_seconds
    print(f"\nQuerying OSRM ({osrm_url}) for each trip's real road-network duration...")
    train_osrm_duration = compute_osrm_durations(train_df, osrm_url, osrm_timeout_seconds)
    test_osrm_duration = compute_osrm_durations(test_df, osrm_url, osrm_timeout_seconds)

    train_df_osrm = train_df.assign(osrm_duration_seconds=train_osrm_duration)
    test_df_osrm = test_df.assign(osrm_duration_seconds=test_osrm_duration)
    train_dropped = int(train_df_osrm["osrm_duration_seconds"].isna().sum())
    test_dropped = int(test_df_osrm["osrm_duration_seconds"].isna().sum())
    train_routable = train_df_osrm.dropna(subset=["osrm_duration_seconds"]).reset_index(drop=True)
    test_routable = test_df_osrm.dropna(subset=["osrm_duration_seconds"]).reset_index(drop=True)

    print(
        f"OSRM routed {len(train_routable)}/{len(train_df)} train rows "
        f"({train_dropped} no-route, {train_dropped / len(train_df):.1%}) and "
        f"{len(test_routable)}/{len(test_df)} test rows "
        f"({test_dropped} no-route, {test_dropped / len(test_df):.1%})"
    )

    # If OSRM was entirely unreachable, every row above would land as "no-route" — that's a
    # service outage, not a data issue, and shouldn't block saving the production (OSRM-free)
    # model below. Degrade to a clearly-labeled skip rather than fitting a model on zero rows.
    osrm_comparison_metrics: dict[str, object]
    if len(train_routable) == 0 or len(test_routable) == 0:
        print(
            f"\nSkipping the OSRM feature comparison — OSRM at {osrm_url} returned no usable "
            "routes at all (is the service running? see docs/osrm-routing.md).",
            file=sys.stderr,
        )
        osrm_comparison_metrics = {"skipped": True, "reason": "osrm_returned_no_routable_rows"}
    else:
        X_train_with_osrm = build_features(train_routable)
        X_train_with_osrm["osrm_duration_seconds"] = train_routable[
            "osrm_duration_seconds"
        ].to_numpy(dtype=float)
        X_test_with_osrm = build_features(test_routable)
        X_test_with_osrm["osrm_duration_seconds"] = test_routable[
            "osrm_duration_seconds"
        ].to_numpy(dtype=float)
        y_train_routable = train_routable["actual_duration_seconds"].to_numpy(dtype=float)
        y_test_routable = test_routable["actual_duration_seconds"].to_numpy(dtype=float)

        # Comparison-only model: trained with identical hyperparameters/random_state to the
        # production model above, differing only in the added OSRM feature — never persisted via
        # save_model. Live /predict-eta's feature pipeline (app/ml/features.py) has no OSRM
        # feature, so serving this model would silently misalign the feature vector; it exists
        # purely to produce the MAE/RMSE comparison below.
        model_with_osrm = RandomForestRegressor(
            n_estimators=args.n_estimators,
            max_depth=args.max_depth,
            min_samples_leaf=args.min_samples_leaf,
            random_state=RANDOM_STATE,
            n_jobs=-1,
        )
        model_with_osrm.fit(X_train_with_osrm, y_train_routable)
        with_osrm_pred = model_with_osrm.predict(X_test_with_osrm)

        # The production model's own predictions, restricted to the identical routable test rows
        # — not the full test_df — so the "without" side of the comparison is evaluated on
        # exactly the same rows as the "with" side, even on the rare trip OSRM couldn't route.
        without_osrm_pred = model.predict(build_features(test_routable))

        osrm_comparison = {
            "without_osrm_feature": evaluate(y_test_routable, without_osrm_pred),
            "with_osrm_feature": evaluate(y_test_routable, with_osrm_pred),
        }

        print(
            f"\n=== OSRM feature comparison — identical {len(test_routable)}-row held-out test "
            f"set (Phase 15, docs/osrm-routing.md) ==="
        )
        print(f"{'model':<24}{'MAE (s)':>12}{'RMSE (s)':>12}")
        for name, m in osrm_comparison.items():
            print(f"{name:<24}{m['mae']:>12.1f}{m['rmse']:>12.1f}")

        without_mae = osrm_comparison["without_osrm_feature"]["mae"]
        without_rmse = osrm_comparison["without_osrm_feature"]["rmse"]
        with_mae = osrm_comparison["with_osrm_feature"]["mae"]
        with_rmse = osrm_comparison["with_osrm_feature"]["rmse"]
        print(
            f"\nWith OSRM feature vs without: {(1 - with_mae / without_mae) * 100:+.1f}% MAE, "
            f"{(1 - with_rmse / without_rmse) * 100:+.1f}% RMSE"
        )

        osrm_comparison_metrics = {
            **osrm_comparison,
            "test_rows": len(test_routable),
            "train_rows_dropped_no_route": train_dropped,
            "test_rows_dropped_no_route": test_dropped,
        }

    metrics = {
        **results,
        "feature_importances": importances,
        "osrm_feature_comparison": osrm_comparison_metrics,
    }
    model_path = save_model(
        model,
        feature_names=list(X_train.columns),
        metrics=metrics,
        training_row_count=len(train_df),
        test_row_count=len(test_df),
        date_range_min=str(df["requested_at"].min()),
        date_range_max=str(df["requested_at"].max()),
    )
    print(f"\nSaved model to {model_path}")


if __name__ == "__main__":
    main()
