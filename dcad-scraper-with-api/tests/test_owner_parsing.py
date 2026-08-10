from bs4 import BeautifulSoup

from scraper.dcad.parse_detail import parse_owner


def test_complete_owner_heading_repairs_truncated_sole_owner_party():
    soup = BeautifulSoup(
        """
        <span id="lblOwner" class="DtlSectionHdr">Owner (Current 2026)</span>
        PATTERSON GREGORY SCOTT &amp;<br>GINA R<br>
        1909 SNOWMASS LN<br>GARLAND, TEXAS 750446751<br>
        <table id="MultiOwner1_dgmultiOwner">
          <tr><td>Owner Name</td><td>Ownership %</td></tr>
          <tr><td>PATTERSON GREGORY SCOTT &amp;</td><td>100%</td></tr>
        </table>
        """,
        "html.parser",
    )

    owner = parse_owner(soup)

    assert owner["owner_name"] == "PATTERSON GREGORY SCOTT & GINA R"
    assert owner["multi_owner"] == [
        {
            "owner_name": "PATTERSON GREGORY SCOTT & GINA R",
            "ownership_pct": "100%",
        }
    ]


def test_fractional_owner_parties_remain_separate():
    soup = BeautifulSoup(
        """
        <span id="lblOwner" class="DtlSectionHdr">Owner (Current 2026)</span>
        PRIMARY OWNER<br>100 MAIN ST<br>DALLAS, TEXAS 75201<br>
        <table id="MultiOwner1_dgmultiOwner">
          <tr><td>Owner Name</td><td>Ownership %</td></tr>
          <tr><td>PRIMARY OWNER</td><td>34%</td></tr>
          <tr><td>SECOND OWNER</td><td>33%</td></tr>
          <tr><td>THIRD OWNER</td><td>33%</td></tr>
        </table>
        """,
        "html.parser",
    )

    owner = parse_owner(soup)

    assert owner["multi_owner"] == [
        {"owner_name": "PRIMARY OWNER", "ownership_pct": "34%"},
        {"owner_name": "SECOND OWNER", "ownership_pct": "33%"},
        {"owner_name": "THIRD OWNER", "ownership_pct": "33%"},
    ]
