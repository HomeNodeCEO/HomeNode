from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CAPTURED_DETAIL = REPOSITORY_ROOT / "dcad-scraper-with-api" / "dcad-scraper" / "detail.html"


class CapturedFixtureSecurityTests(unittest.TestCase):
    def test_captured_detail_cannot_put_a_hearing_pin_in_a_url(self):
        html = CAPTURED_DETAIL.read_text(encoding="utf-8")

        self.assertNotIn("&amp;PIN=", html)
        self.assertNotIn("txtPIN.value", html)
        self.assertNotIn("window.open", html)

        for control_id in ("txtPIN", "cmdNbhdReview", "cmdVSS", "cmdAppraisalRecord"):
            self.assertRegex(
                html,
                rf'id="{control_id}"[^>]*disabled="disabled"',
            )


if __name__ == "__main__":
    unittest.main()
