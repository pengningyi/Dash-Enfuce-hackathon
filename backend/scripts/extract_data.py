"""Extract sanctions screening dataset from Excel to CSV files.

Reads hackathon_sanctions_screening_dataset.xlsx from the project root
and writes three CSV files to backend/data/:
  - sanctions_list.csv  (30 rows)
  - customers.csv       (100,000 rows)
  - answer_key.csv      (10 rows)
"""

import logging
import sys
from pathlib import Path

import pandas as pd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Resolve paths relative to this script
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = BACKEND_DIR.parent
EXCEL_PATH = PROJECT_ROOT / "hackathon_sanctions_screening_dataset.xlsx"
DATA_DIR = BACKEND_DIR / "data"

SHEETS = {
    "Sanctions_List": "sanctions_list.csv",
    "Customer_List": "customers.csv",
    "Answer_Key": "answer_key.csv",
}


def extract_sheets() -> None:
    """Read Excel sheets and write them to CSV."""
    if not EXCEL_PATH.exists():
        logger.error("Excel file not found at %s", EXCEL_PATH)
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Reading %s", EXCEL_PATH.name)

    for sheet_name, csv_name in SHEETS.items():
        df = pd.read_excel(EXCEL_PATH, sheet_name=sheet_name)
        out_path = DATA_DIR / csv_name
        df.to_csv(out_path, index=False)
        logger.info(
            "Extracted sheet %r → %s (%d rows, %d columns)",
            sheet_name,
            csv_name,
            len(df),
            len(df.columns),
        )

    logger.info("Done — all sheets extracted to %s", DATA_DIR)


if __name__ == "__main__":
    extract_sheets()
