from decimal import Decimal
import sys
import unittest
from pathlib import Path


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad.upsert import collapse_owner_parties  # noqa: E402


class OwnerPartyCollapseTests(unittest.TestCase):
    def test_sums_duplicate_fractional_rows_for_the_same_owner(self) -> None:
        parties = [
            {"owner_name": "LEWIS BENNIE RUTH", "ownership_pct": "50%"},
            {"owner_name": "LEWIS  BENNIE RUTH", "ownership_pct": "50%"},
        ]
        self.assertEqual(
            collapse_owner_parties(parties, None),
            [("LEWIS BENNIE RUTH", Decimal("100"))],
        )

    def test_preserves_distinct_partial_owners(self) -> None:
        parties = [
            {"owner_name": "OWNER A", "ownership_pct": "33.33%"},
            {"owner_name": "OWNER B", "ownership_pct": "66.67%"},
        ]
        self.assertEqual(
            collapse_owner_parties(parties, None),
            [
                ("OWNER A", Decimal("33.33")),
                ("OWNER B", Decimal("66.67")),
            ],
        )


if __name__ == "__main__":
    unittest.main()
