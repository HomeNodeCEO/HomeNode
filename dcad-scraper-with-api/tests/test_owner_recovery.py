from copy import deepcopy

from scraper.dcad.owner_recovery import (
    recover_complete_owner_name,
    repair_owner_from_history,
)


def test_recovers_name_before_matching_mailing_address():
    assert recover_complete_owner_name(
        "PATTERSON GREGORY SCOTT &",
        "1909 SNOWMASS LN, GARLAND, TEXAS 750446751",
        "PATTERSON GREGORY SCOTT & GINA R 1909 SNOWMASS LN GARLAND, TEXAS 750446751",
    ) == "PATTERSON GREGORY SCOTT & GINA R"


def test_rejects_history_without_a_clear_address_boundary():
    assert recover_complete_owner_name(
        "PATTERSON GREGORY SCOTT &",
        "1909 SNOWMASS LN, GARLAND, TEXAS 750446751",
        "PATTERSON GREGORY SCOTT & GINA R UNKNOWN ADDRESS",
    ) is None


def test_rejects_unchanged_or_non_ampersand_summary():
    assert recover_complete_owner_name(
        "PATTERSON GREGORY SCOTT &",
        "1909 SNOWMASS LN, GARLAND, TEXAS 750446751",
        "PATTERSON GREGORY SCOTT & 1909 SNOWMASS LN GARLAND TEXAS 75044",
    ) is None
    assert recover_complete_owner_name(
        "PATTERSON GREGORY SCOTT",
        "1909 SNOWMASS LN, GARLAND, TEXAS 750446751",
        "PATTERSON GREGORY SCOTT GINA R 1909 SNOWMASS LN GARLAND TEXAS 75044",
    ) is None


def test_repairs_coowner_misread_as_an_address_line():
    detail = {
        "owner": {
            "source_year": 2027, "source_heading": "Owner (Current 2027)",
            "owner_name": "LOWE ALEXANDER &",
            "mailing_address": "ROBBINS LANE, 3236 BASIL CT, DALLAS, TEXAS 752045543",
            "multi_owner": [
                {"owner_name": "LOWE ALEXANDER &", "ownership_pct": "100%"}
            ],
        }
    }
    history = {
        "owner_history": [
            {
                "observed_year": 2027,
                "owner_lines": [
                    "LOWE ALEXANDER & ROBBINS LANE 3236 BASIL CT DALLAS, TEXAS 752045543"
                ]
            }
        ]
    }

    assert repair_owner_from_history(detail, history)
    assert detail["owner"] == {
        "source_year": 2027, "source_heading": "Owner (Current 2027)",
        "history_recovery": {
            "observed_year": 2027,
            "original_owner_name": "LOWE ALEXANDER &",
            "original_mailing_address": "ROBBINS LANE, 3236 BASIL CT, DALLAS, TEXAS 752045543",
            "original_party_owner_name": "LOWE ALEXANDER &",
        },
        "owner_name": "LOWE ALEXANDER & ROBBINS LANE",
        "mailing_address": "3236 BASIL CT, DALLAS, TEXAS 752045543",
        "multi_owner": [
            {
                "owner_name": "LOWE ALEXANDER & ROBBINS LANE",
                "ownership_pct": "100%",
            }
        ],
    }

def test_recovers_from_history_when_current_mailing_address_changed():
    detail = {
        "owner": {
            "source_year": 2027, "source_heading": "Owner (Current 2027)",
            "owner_name": "PEREZ JOSE RICARDO VILLALOBOS &",
            "mailing_address": "3515 PACKARD ST, DALLAS, TEXAS 752153446",
            "multi_owner": [
                {
                    "owner_name": "PEREZ JOSE RICARDO VILLALOBOS &",
                    "ownership_pct": "100%",
                }
            ],
        }
    }
    history = {
        "owner_history": [
            {
                "observed_year": 2027,
                "owner_lines": [
                    "PEREZ JOSE RICARDO VILLALOBOS & VILLALOBOS MARTHA "
                    "2146 CEDAR VALLEY LN DALLAS, TEXAS 752322308"
                ]
            }
        ]
    }

    assert repair_owner_from_history(detail, history)
    assert detail["owner"]["owner_name"] == (
        "PEREZ JOSE RICARDO VILLALOBOS & VILLALOBOS MARTHA"
    )
    assert detail["owner"]["mailing_address"] == (
        "3515 PACKARD ST, DALLAS, TEXAS 752153446"
    )


def test_history_recovery_refuses_unknown_or_mismatched_year_without_changing_source():
    detail = {"tax_year": 2026, "owner": {
        "source_year": 2027, "source_heading": "Owner (Current 2027)",
        "owner_name": "SYNTHETIC AVERY &", "mailing_address": "100 SAMPLE LN, DALLAS TX 75201",
        "multi_owner": [{"owner_name": "SYNTHETIC AVERY &", "ownership_pct": "100%"}],
    }}
    for observed_year in (None, 2026, 2028, 2027.0, "2027", True):
        history = {"owner_history": [{"observed_year": observed_year, "owner_lines": [
            "SYNTHETIC AVERY & MORGAN 100 SAMPLE LN DALLAS TX 75201"
        ]}]}
        current = deepcopy(detail); original = deepcopy((current, history))
        assert not repair_owner_from_history(current, history)
        assert (current, history) == original
    history["owner_history"][0]["observed_year"] = 2027
    for changes in ({"source_year": None}, {"source_heading": None},
                    {"parties_source_heading": "Multi-Owner (Current 2026)"},
                    {"multi_owner": [{"owner_name": "SYNTHETIC AVERY &", "ownership_pct": None}]}):
        current = deepcopy(detail); current["owner"].update(changes)
        original = deepcopy((current, history))
        assert not repair_owner_from_history(current, history)
        assert (current, history) == original
