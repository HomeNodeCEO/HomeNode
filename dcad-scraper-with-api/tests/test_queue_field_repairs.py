from tools.queue_field_repairs import CANDIDATES_SQL


def test_candidate_sql_avoids_literal_percent_wildcards() -> None:
    """Literal LIKE wildcards collide with psycopg2 named parameters."""

    assert "LIKE '%VACANT%'" not in CANDIDATES_SQL
    assert "NOT LIKE '%VACANT%'" not in CANDIDATES_SQL
    assert "position('VACANT' in upper(state_code)) > 0" in CANDIDATES_SQL
    assert "position('VACANT' in upper(state_code)) = 0" in CANDIDATES_SQL

