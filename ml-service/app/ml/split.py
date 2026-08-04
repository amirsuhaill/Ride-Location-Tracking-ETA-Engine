"""Chronological (not random) train/test split — see docs/eta-model.md for the full "why a
time-based split is more honest here" rationale. Short version: this is time-series-flavored
data (real trip/traffic patterns drift over time — new neighborhoods, changing driver behavior,
seasonal effects), so a random split would let the model implicitly see patterns from the *same
period* it's tested on, silently overstating how well it'd perform predicting genuinely unseen
future trips. Holding out the chronologically *last* slice simulates the actual deployment
scenario: train on the past, evaluate on data that came after it.
"""

import pandas as pd

DEFAULT_TEST_SIZE = 0.2


def time_based_split(
    df: pd.DataFrame, test_size: float = DEFAULT_TEST_SIZE
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Sorts `df` by `requested_at` ascending and splits it into a chronologically-earlier train
    set and a chronologically-later test set. The split index is never overlapping in time —
    every train row's timestamp is <= every test row's timestamp — verified explicitly in
    test/test_split.py, not just assumed from the sort."""
    if not 0 < test_size < 1:
        raise ValueError(f"test_size must be between 0 and 1, got {test_size}")

    sorted_df = df.sort_values("requested_at", kind="mergesort").reset_index(drop=True)
    split_idx = int(len(sorted_df) * (1 - test_size))

    train_df = sorted_df.iloc[:split_idx].reset_index(drop=True)
    test_df = sorted_df.iloc[split_idx:].reset_index(drop=True)
    return train_df, test_df
