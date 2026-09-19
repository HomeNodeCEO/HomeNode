"""Synthetic replicas of the public improvement/land layout; no owner data."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))
from dcad.parse_detail import (parse_detail_html, parse_main_improvement,
    parse_additional_improvements, _resolve_main_improvement_table,
    _resolve_additional_improvements_table)
from dcad.primary_cleanup import vacant_zero_cleanup_year
import test_primary_cleanup as cleanup_fixtures


MAIN_HEADER = '<span id="lblMainImp" class="DtlSectionHdr">Main Improvement (Current 2027)</span>'
ADDITIONAL_HEADER = '<span id="lblAddImp" class="DtlSectionHdr">Additional Improvements</span>'
NO_MAIN = '<span id="MainImpRes1_lblMsg">No Main Improvement.</span>'
NO_ADDITIONAL = '<span id="ResImp1_lblMessage">No Additional Improvements.</span>'
LAND = '''<span id="lblLand" class="DtlSectionHdr">Land</span>
<table id="Land1_dgLand"><tr><th>#</th><th>State Code</th><th>Zoning</th>
<th>Frontage</th><th>Depth</th><th>Area</th><th>Pricing</th><th>Unit Price</th>
<th>Market Adjustment</th><th>Adjusted Price</th><th>Ag Land</th></tr>
<tr><td>1</td><td>SFR - VACANT LOTS/TRACTS</td><td>Residential</td><td>0</td><td>0</td>
<td>1 ACRES</td><td>FLAT</td><td>100</td><td>0</td><td>100</td><td>NO</td></tr></table>'''
VALUES = '''<table id="tblValueSum"><tr><td>
<span id="ValueSummary1_lblApprYr">2026 Certified Values</span>
<span id="ValueSummary1_lblImpVal">$0</span><span id="ValueSummary1_lblLandVal">$100</span>
<span id="ValueSummary1_lblTotalVal">$100</span><span id="ValueSummary1_lblRevalYr">2025</span>
</td></tr></table>'''
MAIN = '''<table id="main-data"><tr><th>Building Class</th><td>14</td></tr>
<tr><th><strong>Year Built</strong></th><td>1989</td></tr>
<tr><th>Living Area</th><td>1,331</td></tr><tr><th>Foundation</th><td>SLAB</td></tr>
<tr><th>Bedrooms</th><td>3</td></tr></table>'''
ADDITIONAL = '''<table id="ResImp1_dgImp"><tr><th>Imp #</th><th>Type</th>
<th>Year Built</th><th>Area</th><th>Value</th></tr>
<tr><td>1</td><td>DETACHED GARAGE</td><td>1995</td><td>440</td><td>5500</td></tr></table>'''


def page(main=NO_MAIN, additional=NO_ADDITIONAL):
    return VALUES + MAIN_HEADER + main + ADDITIONAL_HEADER + additional + LAND


class ImprovementSectionBoundaryTests(unittest.TestCase):
    def test_explicit_absence_keeps_land_out_of_both_improvement_groups(self):
        detail = parse_detail_html(page())
        for alias in ("primary_improvements", "main_improvement", "main_improvements"):
            self.assertEqual(detail[alias], {})
        for alias in ("secondary_improvements", "additional_improvements"):
            self.assertEqual(detail[alias], [])
        self.assertEqual(detail["improvement_sections"], {
            "main": "explicitly_absent", "additional": "explicitly_absent"})
        self.assertEqual(detail["land_detail"][0]["state_code"], "SFR - VACANT LOTS/TRACTS")
        self.assertEqual(detail["land_detail"][0]["area_sqft"], 43560)
        self.assertEqual(vacant_zero_cleanup_year(detail), 2025)

    def test_label_only_sections_are_unknown_not_source_confirmed_absence(self):
        for main, additional in (("", NO_ADDITIONAL), (NO_MAIN, ""), ("", "")):
            with self.subTest(main=main, additional=additional):
                detail = parse_detail_html(page(main, additional))
                self.assertEqual(detail["primary_improvements"], {})
                self.assertEqual(detail["secondary_improvements"], [])
                self.assertIn("unresolved", detail["improvement_sections"].values())
                self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_absence_requires_exact_marker_id_and_text(self):
        for absent, section in ((NO_MAIN, "main"), (NO_ADDITIONAL, "additional")):
            for altered in (absent.replace("No ", "Unknown "), absent.replace(".</span>", "?</span>"),
                            absent.replace("id=", "data-id="), absent.replace("No ", "")):
                with self.subTest(section=section, altered=altered):
                    detail = parse_detail_html(page(**{section: altered}))
                    self.assertEqual(detail["improvement_sections"][section], "unresolved")
                    self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_main_is_not_taken_from_additional_year_built_column(self):
        detail = parse_detail_html(page(NO_MAIN, ADDITIONAL))
        self.assertEqual(detail["primary_improvements"], {})
        self.assertEqual(detail["secondary_improvements"][0]["year_built"], 1995)
        self.assertEqual(detail["improvement_sections"]["additional"], "present")
        self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_complete_main_and_additional_fields_remain_exact(self):
        detail = parse_detail_html(page(MAIN, ADDITIONAL))
        main = detail["primary_improvements"]
        self.assertEqual({key: main[key] for key in ("building_class", "year_built", "living_area_sqft",
            "foundation", "bedroom_count")}, {"building_class": "14", "year_built": 1989,
            "living_area_sqft": 1331, "foundation": "SLAB", "bedroom_count": 3})
        self.assertEqual(detail["secondary_improvements"][0], {
            "imp_num": "1", "imp_type": "DETACHED GARAGE", "imp_desc": None, "year_built": 1995,
            "construction": "N/A", "floor_type": "N/A", "ext_wall": "N/A", "num_stories": None,
            "area_size": 440, "value": "5500", "depreciation": None})
        self.assertEqual(detail["improvement_sections"], {"main": "present", "additional": "present"})
        self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_real_tables_win_over_contradictory_absence_marker(self):
        detail = parse_detail_html(page(NO_MAIN + MAIN, NO_ADDITIONAL + ADDITIONAL))
        self.assertEqual(detail["primary_improvements"]["year_built"], 1989)
        self.assertEqual(len(detail["secondary_improvements"]), 1)
        self.assertEqual(detail["improvement_sections"], {"main": "present", "additional": "present"})
        self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_headerless_tables_also_block_contradictory_absence_authorization(self):
        for main, additional, expected in (
            (NO_MAIN + MAIN, NO_ADDITIONAL, {"main": "present", "additional": "explicitly_absent"}),
            (NO_MAIN, NO_ADDITIONAL + ADDITIONAL.replace(' id="ResImp1_dgImp"', ''),
             {"main": "explicitly_absent", "additional": "present"}),
        ):
            with self.subTest(expected=expected):
                html = page(main, additional).replace(MAIN_HEADER, '').replace(ADDITIONAL_HEADER, '')
                detail = parse_detail_html(html)
                self.assertEqual(detail["improvement_sections"], expected)
                self.assertIsNone(vacant_zero_cleanup_year(detail))
                if expected["main"] == "present":
                    self.assertEqual(detail["primary_improvements"]["year_built"], 1989)
                else:
                    self.assertEqual(detail["secondary_improvements"][0]["year_built"], 1995)

    def test_wrapper_table_cannot_blend_sections(self):
        html = MAIN_HEADER + '<table><tr><td>' + NO_MAIN + ADDITIONAL_HEADER + ADDITIONAL + LAND + '</td></tr></table>'
        detail = parse_detail_html(html)
        self.assertEqual(detail["primary_improvements"], {})
        self.assertEqual(len(detail["secondary_improvements"]), 1)

    def test_land_grid_is_rejected_even_without_any_headers(self):
        soup = BeautifulSoup(LAND.split('</span>', 1)[1], "html.parser")
        self.assertIsNone(_resolve_main_improvement_table(soup))
        self.assertIsNone(_resolve_additional_improvements_table(soup))
        self.assertEqual(parse_additional_improvements(soup.find("table")), [])

    def test_old_headerless_main_content_recovery_is_preserved(self):
        soup = BeautifulSoup(MAIN, "html.parser")
        self.assertEqual(parse_main_improvement(soup)["year_built"], 1989)
        # A partial but genuine old key/value section is still useful evidence;
        # it need not meet the stronger multi-field fallback's score threshold.
        soup = BeautifulSoup('<table><tr><th>Year Built</th><td>1989</td></tr></table>', "html.parser")
        self.assertEqual(parse_main_improvement(soup)["year_built"], 1989)

    def test_old_heading_spellings_and_generic_additional_grid_are_preserved(self):
        for header in ('<strong>Main Building</strong>', '<h3>Primary Building</h3>',
                       '<span class="DtlSectionHdr">MAIN IMPROVEMENT (Current 2027)</span>'):
            soup = BeautifulSoup(header + MAIN + '<h3>Outbuildings</h3>' +
                ADDITIONAL.replace(' id="ResImp1_dgImp"', '') + LAND, "html.parser")
            self.assertEqual(parse_main_improvement(soup)["year_built"], 1989)
            self.assertEqual(len(parse_additional_improvements(_resolve_additional_improvements_table(soup))), 1)

    def test_navigation_and_layout_wrappers_do_not_hide_real_improvement_table(self):
        navigation = '<table><tr><td>Navigation</td><td>Property Map</td></tr></table>'
        wrapped = '<div><table><tr><td>' + MAIN + '</td></tr></table></div>'
        detail = parse_detail_html(page(navigation + wrapped, ADDITIONAL))
        self.assertEqual(detail["primary_improvements"]["year_built"], 1989)
        self.assertEqual(detail["primary_improvements"]["living_area_sqft"], 1331)
        self.assertEqual(len(detail["secondary_improvements"]), 1)

    def test_inline_main_heading_selects_its_table_instead_of_headerless_fallback(self):
        unrelated = '<table><tr><th>Year Built</th><td>1800</td></tr></table>'
        heading = '<span class="DtlSectionHdr">Main <a>Improvement</a> (Current 2027)</span>'
        soup = BeautifulSoup(unrelated + heading + MAIN + ADDITIONAL_HEADER + NO_ADDITIONAL + LAND,
                             "html.parser")
        self.assertEqual(parse_main_improvement(soup)["year_built"], 1989)

    def test_inline_additional_heading_selects_its_own_generic_grid(self):
        generic = ADDITIONAL.replace(' id="ResImp1_dgImp"', '')
        unrelated = generic.replace('<td>1</td>', '<td>9</td>')
        heading = '<strong>Additional <a>Improvements</a> (Current 2027)</strong>'
        soup = BeautifulSoup(unrelated + heading + generic + LAND, "html.parser")
        rows = parse_additional_improvements(_resolve_additional_improvements_table(soup))
        self.assertEqual([row["imp_num"] for row in rows], ["1"])

    def test_inline_next_section_titles_still_prevent_borrowing_their_grid(self):
        for tag in ("b", "strong", "label"):
            with self.subTest(tag=tag):
                heading = f'<{tag}>Additional <a>Improvements</a> (Current 2027)</{tag}>'
                detail = parse_detail_html(MAIN_HEADER + NO_MAIN + heading + ADDITIONAL + LAND)
                self.assertEqual(detail["primary_improvements"], {})
                self.assertEqual(detail["improvement_sections"]["main"], "explicitly_absent")
                self.assertEqual(detail["secondary_improvements"][0]["year_built"], 1995)

    def test_new_evidence_does_not_bypass_other_cleanup_gates_or_clear_genuine_data(self):
        detail = parse_detail_html(page())
        calls = cleanup_fixtures.CleanupPersistenceTests().capture_upsert(detail)
        updates = [c for c in calls if c[0].startswith("UPDATE core.primary_improvements AS p")]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0][1]["vacant_revaluation_year"], 2025)
        for values in ({"market_value": 0}, {"land_value": 99}, {"improvement_value": 1},
                       {"revaluation_year": 2027}, {"certified_year": 2025}):
            changed = deepcopy(detail)
            changed["value_summary"].update(values)
            self.assertIsNone(vacant_zero_cleanup_year(changed))
        calls = cleanup_fixtures.CleanupPersistenceTests().capture_upsert(parse_detail_html(page(MAIN)))
        self.assertFalse(any(sql.startswith("UPDATE core.primary_improvements AS p") for sql, _ in calls))
        self.assertTrue(any("INSERT INTO core.primary_improvements" in sql for sql, _ in calls))

    def test_legacy_evidence_unchanged_but_new_partial_evidence_fails_closed(self):
        original = cleanup_fixtures.vacant_detail()
        self.assertEqual(vacant_zero_cleanup_year(original), 2025)
        for sections in (None, [], {}, {"main": "explicitly_absent"},
                         {"main": "explicitly_absent", "additional": "unresolved"},
                         {"main": "unresolved", "additional": "explicitly_absent"},
                         {"main": "present", "additional": "explicitly_absent"}):
            detail = dict(original, improvement_sections=sections)
            self.assertIsNone(vacant_zero_cleanup_year(detail))
        self.assertNotIn("improvement_sections", original)


if __name__ == "__main__":
    unittest.main()
