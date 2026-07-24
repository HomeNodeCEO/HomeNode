from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad.import_sales_media import _load_media_rows  # noqa: E402


class SalesMediaCsvTests(unittest.TestCase):
    def write_csv(self, contents: str) -> Path:
        temp = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            suffix=".csv",
            delete=False,
        )
        temp.write(contents)
        temp.close()
        self.addCleanup(lambda: Path(temp.name).unlink(missing_ok=True))
        return Path(temp.name)

    def test_reads_standard_reso_media_fields_in_order(self) -> None:
        path = self.write_csv(
            "ResourceRecordKey,MediaKey,MediaURL,Order,PreferredPhotoYN,"
            "ClassName,MIMEType,ShortDescription\n"
            "KEY-1,MEDIA-2,https://img.example.com/2.jpg,2,FALSE,"
            "Photo,image/jpeg,Rear exterior\n"
            "KEY-1,MEDIA-1,https://img.example.com/1.jpg,1,TRUE,"
            "Photo,image/jpeg,Front exterior\n"
        )
        rows = _load_media_rows(path)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1].listing_key, "KEY-1")
        self.assertTrue(rows[1].preferred_photo_yn)
        self.assertEqual(rows[1].order_number, 1)
        self.assertEqual(rows[1].media_category, "image")

    def test_rejects_rows_without_a_safe_listing_key(self) -> None:
        path = self.write_csv(
            "MediaURL,Order\nhttps://img.example.com/1.jpg,1\n"
        )
        with self.assertRaisesRegex(ValueError, "ResourceRecordKey"):
            _load_media_rows(path)

    def test_rejects_non_http_media_urls(self) -> None:
        path = self.write_csv(
            "ResourceRecordKey,MediaURL,Order\n"
            "KEY-1,javascript:alert(1),1\n"
        )
        with self.assertRaisesRegex(ValueError, "invalid MediaURL"):
            _load_media_rows(path)


if __name__ == "__main__":
    unittest.main()
