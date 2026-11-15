"""Shared pytest fixtures for sanctions screening tests."""

from pathlib import Path

import pandas as pd
import pytest

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture(scope="session")
def sanctions_df() -> pd.DataFrame:
    """Load sanctions_list.csv as a DataFrame."""
    return pd.read_csv(DATA_DIR / "sanctions_list.csv")


@pytest.fixture(scope="session")
def customers_df() -> pd.DataFrame:
    """Load customers.csv as a DataFrame."""
    return pd.read_csv(DATA_DIR / "customers.csv")


@pytest.fixture(scope="session")
def answer_key_df() -> pd.DataFrame:
    """Load answer_key.csv as a DataFrame."""
    return pd.read_csv(DATA_DIR / "answer_key.csv")
