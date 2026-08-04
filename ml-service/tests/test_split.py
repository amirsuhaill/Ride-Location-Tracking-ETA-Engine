import pandas as pd
import pytest

from app.ml.split import time_based_split


def _make_df(n: int) -> pd.DataFrame:
    # Shuffled on purpose — the split function must sort internally, not assume pre-sorted input.
    timestamps = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC")
    df = pd.DataFrame({"requested_at": timestamps, "value": range(n)})
    return df.sample(frac=1, random_state=1).reset_index(drop=True)


def test_split_produces_the_requested_proportions():
    df = _make_df(1000)
    train, test = time_based_split(df, test_size=0.2)
    assert len(train) == 800
    assert len(test) == 200


def test_split_never_leaks_future_rows_into_training():
    df = _make_df(500)
    train, test = time_based_split(df, test_size=0.3)
    # The core no-leak guarantee: every train timestamp is <= every test timestamp.
    assert train["requested_at"].max() <= test["requested_at"].min()


def test_split_is_deterministic_given_the_same_input():
    df = _make_df(200)
    train1, test1 = time_based_split(df)
    train2, test2 = time_based_split(df)
    pd.testing.assert_frame_equal(train1, train2)
    pd.testing.assert_frame_equal(test1, test2)


def test_split_rejects_an_out_of_range_test_size():
    df = _make_df(10)
    with pytest.raises(ValueError):
        time_based_split(df, test_size=0.0)
    with pytest.raises(ValueError):
        time_based_split(df, test_size=1.0)
