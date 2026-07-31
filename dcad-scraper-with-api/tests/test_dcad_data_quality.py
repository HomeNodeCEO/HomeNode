import sys
import unittest
from pathlib import Path


SCRAPER_PATH = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_PATH))

from dcad.account_recovery import (  # noqa: E402
    AddressCandidate,
    address_line,
    exact_candidates,
    normalize_address,
    normalize_city,
)
from dcad.data_quality import (  # noqa: E402
    IncompleteScrapeError,
    assess_detail_completeness,
    require_complete_detail,
)


class DetailCompletenessTests(unittest.TestCase):
    def test_complete_when_address_is_present(self):
        assessment = assess_detail_completeness(
            {
                "property_location": {"address": "510 DALLAS AVE"},
                "value_summary": {"market_value": "N/A"},
            }
        )
        self.assertTrue(assessment.complete)

    def test_complete_when_market_value_is_present(self):
        assessment = assess_detail_completeness(
            {
                "property_location": {"address": None},
                "value_summary": {"market_value": "$192,450"},
            }
        )
        self.assertTrue(assessment.complete)

    def test_rejects_missing_address_and_value(self):
        with self.assertRaises(IncompleteScrapeError):
            require_complete_detail(
                "28208500000000000",
                {
                    "property_location": {"address": None},
                    "value_summary": {"market_value": "N/A"},
                },
            )

    def test_rejects_explicit_no_data_even_if_parser_found_noise(self):
        assessment = assess_detail_completeness(
            {
                "property_location": {"address": "RETURN TO SEARCH"},
                "value_summary": {"market_value": "N/A"},
            },
            "Account Search - No Data",
        )
        self.assertFalse(assessment.complete)
        self.assertTrue(assessment.explicit_no_data)


class AddressRecoveryTests(unittest.TestCase):
    def test_removes_city_and_zip_from_source_heading(self):
        self.assertEqual(
            address_line("510 DALLAS AVE, GRAND PRAIRIE, TX 75050", "GRAND PRAIRIE"),
            "510 DALLAS AVE",
        )

    def test_normalizes_city_county_suffix(self):
        self.assertEqual(normalize_city("GRAND PRAIRIE (DALLAS CO)"), "GRAND PRAIRIE")

    def test_selects_only_unique_exact_address_and_city(self):
        candidates = [
            AddressCandidate("28208500120070000", "510 DALLAS AVE", "GRAND PRAIRIE"),
            AddressCandidate("99999999999999999", "510 DALLAS AVE", "DALLAS"),
        ]
        selected = exact_candidates(
            candidates,
            "510 Dallas Ave, Grand Prairie, TX 75050",
            "Grand Prairie",
        )
        self.assertEqual([row.account_id for row in selected], ["28208500120070000"])

    def test_address_normalization_is_case_and_punctuation_insensitive(self):
        self.assertEqual(
            normalize_address("1909 Snowmass Ln."),
            normalize_address("1909 SNOWMASS LN"),
        )


if __name__ == "__main__":
    unittest.main()
