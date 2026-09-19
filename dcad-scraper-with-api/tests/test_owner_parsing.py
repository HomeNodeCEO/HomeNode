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


def test_multi_owner_grid_recovers_owner_name_when_heading_text_is_unavailable():
    soup = BeautifulSoup(
        """
        <span id="lblOwner" class="DtlSectionHdr">Owner (Current 2027)</span>
        <table id="MultiOwner1_dgmultiOwner">
          <tr><td>Owner Name</td><td>Ownership %</td></tr>
          <tr><td>LAM DUNG LY</td><td>100%</td></tr>
        </table>
        """,
        "html.parser",
    )

    owner = parse_owner(soup)

    assert owner["owner_name"] == "LAM DUNG LY"
    assert owner["multi_owner"] == [
        {"owner_name": "LAM DUNG LY", "ownership_pct": "100%"},
    ]


def test_malformed_br_keeps_owner_and_mailing_before_nested_multi_owner_section():
    # Match the live DCAD tree: the first <br> wraps every following line,
    # including the Multi-Owner section, until the closing </br>.
    soup = BeautifulSoup(
        """
        <div class="HalfCol">
          <span class="DtlSectionHdr">Property Location</span>UNRELATED LOCATION
          <a name="Owner"></a>
          <span class="DtlSectionHdr" id="lblOwner">Owner (Current 2027)</span>
          HART ELLEN M &amp;<br>CHRIS P<br/>
          6201 SAMPLE DR<br/>DALLAS, TEXAS&nbsp;752382535<br/>
          <a name="MultiOwner"></a><p align="center">
          <span class="DtlSectionHdr" id="lblMultiOwner">Multi-Owner (Current 2027)</span>
          <table id="MultiOwner1_dgmultiOwner">
            <tr><td><b>Owner Name</b></td><td><b>Ownership %</b></td></tr>
            <tr class="Data"><td>HART ELLEN M &amp;</td><td>100%</td></tr>
          </table><p></p></p></br>
        </div>
        """,
        "html.parser",
    )

    assert parse_owner(soup) == {
        "owner_name": "HART ELLEN M & CHRIS P",
        "mailing_address": "6201 SAMPLE DR, DALLAS, TEXAS 752382535",
        "multi_owner": [
            {"owner_name": "HART ELLEN M & CHRIS P", "ownership_pct": "100%"}
        ],
    }


def test_owner_inline_markup_is_not_split_into_separate_address_lines():
    soup = BeautifulSoup(
        """
        <span id="lblOwner" class="DtlSectionHdr">Owner (Current 2027)</span>
        <b>HART ELLEN M</b> &amp; <span>CHRIS P</span><br/>
        <span>6201 SAMPLE DR</span><br/><span>DALLAS, TEXAS 752382535</span><br/>
        <span class="DtlSectionHdr">Legal Description</span>NOT AN OWNER ADDRESS
        """,
        "html.parser",
    )

    owner = parse_owner(soup)
    assert owner["owner_name"] == "HART ELLEN M & CHRIS P"
    assert owner["mailing_address"] == "6201 SAMPLE DR, DALLAS, TEXAS 752382535"
    assert owner["multi_owner"] == []


def test_missing_owner_percentage_is_not_inferred_from_complete_heading():
    soup = BeautifulSoup(
        """
        <span id="lblOwner" class="DtlSectionHdr">Owner (Current 2027)</span>
        HART ELLEN M &amp;<br>CHRIS P<br/>6201 SAMPLE DR<br/>
        DALLAS, TEXAS 752382535<br/>
        <table id="MultiOwner1_dgmultiOwner">
          <tr><td>Owner Name</td><td>Ownership %</td></tr>
          <tr><td>HART ELLEN M &amp;</td><td></td></tr>
        </table></br>
        """,
        "html.parser",
    )

    owner = parse_owner(soup)
    assert owner["owner_name"] == "HART ELLEN M & CHRIS P"
    assert owner["multi_owner"] == [
        {"owner_name": "HART ELLEN M &", "ownership_pct": "N/A"}
    ]
