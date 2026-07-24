-- Verified account-level classifications for MLS transactions that were
-- retained from an older import but omitted from the revised style export.
-- These rows preserve source URLs and never invent a missing architectural
-- style.

INSERT INTO core.account_housing_profiles (
    account_id,
    structural_style,
    housing_type,
    attachment_type,
    architectural_style,
    source_name,
    source_url,
    source_record_reference,
    observed_at,
    confidence,
    notes
) VALUES
    (
        '26262500020080000',
        'Condo/Townhome',
        'Condo/Townhome',
        'attached',
        'Traditional',
        'NTREIS MLS via Compass',
        'https://www.compass.com/homedetails/1808-Greenspring-Cir-Garland-TX-75044/1AU7HS_pid/',
        'NTREIS 21189337',
        '2026-02-24 00:00:00+00',
        1.000,
        'MLS detail identifies Structural Style Condo/Townhome and Architectural Style Traditional.'
    ),
    (
        '26262500010210000',
        'Condo/Townhome',
        'Condo/Townhome',
        'attached',
        NULL,
        'NTREIS MLS via Trulia',
        'https://www.trulia.com/home/1827-highbrook-ct-garland-tx-75044-248828505',
        'NTREIS 20821251',
        '2025-01-21 00:00:00+00',
        1.000,
        'MLS detail identifies the property subtype as Townhouse; no architectural style was supplied.'
    )
ON CONFLICT (account_id) DO UPDATE SET
    structural_style = EXCLUDED.structural_style,
    housing_type = EXCLUDED.housing_type,
    attachment_type = EXCLUDED.attachment_type,
    architectural_style = EXCLUDED.architectural_style,
    source_name = EXCLUDED.source_name,
    source_url = EXCLUDED.source_url,
    source_record_reference = EXCLUDED.source_record_reference,
    observed_at = EXCLUDED.observed_at,
    confidence = EXCLUDED.confidence,
    notes = EXCLUDED.notes,
    updated_at = now()
WHERE core.account_housing_profiles.source_name <> 'HomeNode manual comparable review';
