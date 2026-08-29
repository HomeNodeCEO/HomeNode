from bs4 import BeautifulSoup

from scraper.dcad.parse_detail import parse_detail_html, parse_main_improvement


def test_current_residential_building_class_uses_stable_dcad_field_id():
    soup = BeautifulSoup(
        """
        <span id="lblMainImp" class="DtlSectionHdr">Main Improvement (Current 2027)</span>
        <table>
          <tr>
            <th><a href="ResBuildingClassifications.pdf">Building Classification</a></th>
            <td><span id="MainImpRes1_lblBuildClass">14</span></td>
            <th>Year Built</th><td>1989</td>
            <th>Living Area</th><td>1,331 sqft</td>
          </tr>
        </table>
        """,
        "html.parser",
    )

    improvement = parse_main_improvement(soup)

    assert improvement["building_class"] == "14"


def test_certified_tax_year_ignores_yearless_navigation_link():
    detail = parse_detail_html(
        """
        <html><body>
          <a href="CertifiedEVR.aspx">Certified Value Summaries</a>
          <span id="lblOwner" class="DtlSectionHdr">Owner (Current 2027)</span>
          LAM DUNG LY<br>1402 AARON PL<br>DUNCANVILLE, TEXAS 75137<br>
          <span id="ValueSummary1_lblApprYr">2026 Certified Values</span>
        </body></html>
        """
    )

    assert detail["tax_year"] == 2026
    assert detail["owner"]["owner_name"] == "LAM DUNG LY"
