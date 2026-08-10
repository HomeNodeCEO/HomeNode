from scraper.dcad.owner_recovery import recover_complete_owner_name


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
