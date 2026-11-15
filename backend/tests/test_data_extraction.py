"""Tests for data extraction — validates CSV structure and content."""

import pandas as pd


class TestSanctionsList:
    """Validate sanctions_list.csv shape and content."""

    def test_row_count(self, sanctions_df: pd.DataFrame) -> None:
        assert len(sanctions_df) == 30, f"Expected 30 rows, got {len(sanctions_df)}"

    def test_expected_columns(self, sanctions_df: pd.DataFrame) -> None:
        expected = {
            "Sanction_ID",
            "Full_Name",
            "Alias_1",
            "Alias_2",
            "Date_of_Birth",
            "Nationality",
            "Passport_Number",
            "Sanctions_Program",
            "Reason_for_Listing",
        }
        assert set(sanctions_df.columns) == expected

    def test_sanction_ids_unique(self, sanctions_df: pd.DataFrame) -> None:
        assert sanctions_df["Sanction_ID"].is_unique

    def test_eu0026_alias2_is_empty(self, sanctions_df: pd.DataFrame) -> None:
        """EU-0026 has no Alias_2 in the source data (None → NaN in CSV)."""
        row = sanctions_df[sanctions_df["Sanction_ID"] == "EU-0026"]
        assert len(row) == 1, "EU-0026 not found"
        assert pd.isna(row.iloc[0]["Alias_2"]), (
            f"Expected NaN for EU-0026 Alias_2, got {row.iloc[0]['Alias_2']!r}"
        )


class TestCustomerList:
    """Validate customers.csv shape."""

    def test_row_count(self, customers_df: pd.DataFrame) -> None:
        assert len(customers_df) == 100_000, f"Expected 100000 rows, got {len(customers_df)}"

    def test_expected_columns(self, customers_df: pd.DataFrame) -> None:
        expected = {
            "Row_Number",
            "Account_ID",
            "Full_Name",
            "Date_of_Birth",
            "Country",
            "City",
            "Phone",
            "Email",
            "IBAN",
            "Account_Type",
            "Risk_Score",
            "Registration_Date",
            "Is_Hidden_Target",
        }
        assert set(customers_df.columns) == expected

    def test_has_hidden_targets(self, customers_df: pd.DataFrame) -> None:
        targets = customers_df[customers_df["Is_Hidden_Target"] == "YES"]
        assert len(targets) == 10, f"Expected 10 hidden targets, got {len(targets)}"


class TestAnswerKey:
    """Validate answer_key.csv shape and content."""

    def test_row_count(self, answer_key_df: pd.DataFrame) -> None:
        assert len(answer_key_df) == 10, f"Expected 10 rows, got {len(answer_key_df)}"

    def test_expected_columns(self, answer_key_df: pd.DataFrame) -> None:
        expected = {
            "#",
            "Original_Sanction_ID",
            "Original_Full_Name",
            "Obfuscated_Name_in_Customer_List",
            "Obfuscation_Method",
            "Customer_Row_Number",
            "Date_of_Birth",
            "Country_in_Customer_List",
            "Expected_Similarity_Score",
        }
        assert set(answer_key_df.columns) == expected

    def test_all_sanction_ids_start_with_eu(self, answer_key_df: pd.DataFrame) -> None:
        for sid in answer_key_df["Original_Sanction_ID"]:
            assert str(sid).startswith("EU-"), f"Unexpected ID format: {sid}"
