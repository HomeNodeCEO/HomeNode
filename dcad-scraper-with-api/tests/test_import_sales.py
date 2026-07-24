from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad.import_sales import (  # noqa: E402
    BASE_HEADERS,
    _classify_structural_style,
    _stable_hash,
    _typed_values,
)


def source_row(**overrides: str) -> dict[str, str]:
    row = {header: "" for header in BASE_HEADERS}
    row.update(
        {
            "BedroomsTotal": "3",
            "BathroomsTotalInteger": "2",
            "BathroomsFull": "2",
            "BathroomsHalf": "0",
            "LivingArea": "1800",
            "LotSizeArea": "0.2",
            "CurrentPrice": "350000",
            "DaysOnMarket": "12",
            "YearBuilt": "1985",
            "MlsStatus": "Closed",
            "CloseDate": "07/01/2026",
            "SellerContributions": "0",
            "GarageSpaces": "2",
            "GarageYN": "TRUE",
            "PoolYN": "FALSE",
            "ListingContractDate": "06/01/2026",
            "ParcelNumber": "26272500060150000",
            "BuyerFinancing": "Conventional",
            "StructuralStyle": "Single Detached",
            "ArchitecturalStyle": "Traditional",
        }
    )
    row.update(overrides)
    return row


class StructuralStyleTests(unittest.TestCase):
    def test_detached_single_family(self) -> None:
        self.assertEqual(
            _classify_structural_style("Single Detached"),
            ("Single Family", "detached"),
        )

    def test_attached_and_conflicting_styles_are_distinct(self) -> None:
        self.assertEqual(
            _classify_structural_style("Attached or 1/2 Duplex"),
            ("Attached/Duplex", "attached"),
        )
        self.assertEqual(
            _classify_structural_style(
                "Attached or 1/2 Duplex, Single Detached"
            ),
            ("Mixed/Review", "mixed"),
        )


class RecordTypeTests(unittest.TestCase):
    def test_closed_sale_requires_closed_sale_fields(self) -> None:
        typed, flags = _typed_values(source_row())
        self.assertEqual(typed["record_type"], "closed_sale")
        self.assertEqual(typed["attachment_type"], "detached")
        self.assertNotIn("missing_close_date", flags)

    def test_listing_does_not_get_closed_sale_missing_field_flags(self) -> None:
        typed, flags = _typed_values(
            source_row(
                MlsStatus="Active",
                CloseDate="",
                SellerContributions="",
                BuyerFinancing="",
            )
        )
        self.assertEqual(typed["record_type"], "listing")
        self.assertNotIn("missing_close_date", flags)
        self.assertNotIn("missing_seller_contributions", flags)
        self.assertNotIn("missing_buyer_financing", flags)

    def test_new_style_columns_do_not_change_legacy_row_identity(self) -> None:
        first = source_row(
            StructuralStyle="Single Detached",
            ArchitecturalStyle="Traditional",
        )
        revised = source_row(
            StructuralStyle="Attached or 1/2 Duplex",
            ArchitecturalStyle="Ranch",
        )
        first_hash = _stable_hash(
            {header: first[header] for header in BASE_HEADERS}
        )
        revised_hash = _stable_hash(
            {header: revised[header] for header in BASE_HEADERS}
        )
        self.assertEqual(first_hash, revised_hash)


if __name__ == "__main__":
    unittest.main()
