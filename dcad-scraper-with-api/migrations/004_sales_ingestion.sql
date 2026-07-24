CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.sales_source_records (
    id                                      bigserial PRIMARY KEY,
    source_name                             text NOT NULL,
    source_filename                         text NOT NULL,
    source_files                            text[] NOT NULL DEFAULT ARRAY[]::text[],
    source_sha256                           text NOT NULL,
    source_row_number                       integer NOT NULL,
    source_record_hash                      text NOT NULL,
    transaction_fingerprint                 text NOT NULL,

    bedrooms_total                          integer,
    bathrooms_total_integer                 integer,
    bathrooms_full                          integer,
    bathrooms_half                          integer,
    living_area                             numeric,
    lot_size_area                           numeric,
    current_price                           numeric,
    ratio_current_price_by_living_area      numeric,
    ratio_close_price_by_list_price         numeric,
    ratio_close_price_by_original_list_price numeric,
    ratio_close_price_by_living_area        numeric,
    days_on_market                          integer,
    year_built                              integer,
    close_date                              date,
    seller_contributions                    numeric,
    mls_status                              text,
    record_type                             text NOT NULL DEFAULT 'closed_sale',
    structural_style                        text,
    housing_type                            text,
    attachment_type                         text NOT NULL DEFAULT 'unknown',
    architectural_style                     text,
    garage_spaces                           numeric,
    garage_yn                               boolean,
    pool_yn                                 boolean,
    listing_contract_date                   date,
    parcel_number_raw                       text,
    parcel_number2_raw                      text,
    buyer_financing                         text,

    primary_account_id                      text REFERENCES core.accounts(account_id),
    match_status                            text NOT NULL,
    has_multiple_parcel_numbers             boolean NOT NULL DEFAULT false,
    multi_parcel_status                     text NOT NULL DEFAULT 'single',
    has_unresolved_parcel                   boolean NOT NULL DEFAULT false,
    requires_additional_review              boolean NOT NULL DEFAULT false,
    data_quality_flags                      jsonb NOT NULL DEFAULT '[]'::jsonb,
    raw_payload                             jsonb NOT NULL,
    loaded_at                               timestamptz NOT NULL DEFAULT now(),
    updated_at                              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sales_source_records_hash_unique UNIQUE (source_record_hash),
    CONSTRAINT sales_source_records_source_row_unique
        UNIQUE (source_sha256, source_row_number),
    CONSTRAINT sales_source_records_match_status_check
        CHECK (match_status IN ('exact', 'normalized', 'secondary', 'multiple', 'unmatched')),
    CONSTRAINT sales_source_records_multi_status_check
        CHECK (multi_parcel_status IN ('single', 'possible', 'confirmed')),
    CONSTRAINT sales_source_records_record_type_check
        CHECK (record_type IN ('closed_sale', 'listing')),
    CONSTRAINT sales_source_records_attachment_type_check
        CHECK (attachment_type IN ('detached', 'attached', 'mixed', 'unknown')),
    CONSTRAINT sales_source_records_flags_array_check
        CHECK (jsonb_typeof(data_quality_flags) = 'array')
);

ALTER TABLE core.sales_source_records
    ADD COLUMN IF NOT EXISTS record_type text NOT NULL DEFAULT 'closed_sale',
    ADD COLUMN IF NOT EXISTS structural_style text,
    ADD COLUMN IF NOT EXISTS housing_type text,
    ADD COLUMN IF NOT EXISTS attachment_type text NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS architectural_style text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sales_source_records_record_type_check'
          AND conrelid = 'core.sales_source_records'::regclass
    ) THEN
        ALTER TABLE core.sales_source_records
            ADD CONSTRAINT sales_source_records_record_type_check
            CHECK (record_type IN ('closed_sale', 'listing'));
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sales_source_records_attachment_type_check'
          AND conrelid = 'core.sales_source_records'::regclass
    ) THEN
        ALTER TABLE core.sales_source_records
            ADD CONSTRAINT sales_source_records_attachment_type_check
            CHECK (attachment_type IN ('detached', 'attached', 'mixed', 'unknown'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS sales_source_records_primary_account_idx
    ON core.sales_source_records (primary_account_id);

CREATE INDEX IF NOT EXISTS sales_source_records_close_date_idx
    ON core.sales_source_records (close_date DESC);

CREATE INDEX IF NOT EXISTS sales_source_records_fingerprint_idx
    ON core.sales_source_records (transaction_fingerprint);

CREATE INDEX IF NOT EXISTS sales_source_records_review_idx
    ON core.sales_source_records (requires_additional_review, close_date DESC);

CREATE INDEX IF NOT EXISTS sales_source_records_record_type_idx
    ON core.sales_source_records (
        record_type,
        COALESCE(close_date, listing_contract_date) DESC
    );

CREATE INDEX IF NOT EXISTS sales_source_records_housing_idx
    ON core.sales_source_records (
        attachment_type,
        housing_type
    );

CREATE TABLE IF NOT EXISTS core.account_housing_profiles (
    account_id               text PRIMARY KEY
                             REFERENCES core.accounts(account_id) ON DELETE CASCADE,
    structural_style         text,
    housing_type             text,
    attachment_type          text NOT NULL DEFAULT 'unknown',
    architectural_style      text,
    source_name              text NOT NULL,
    source_url               text,
    source_record_reference  text,
    observed_at              timestamptz,
    confidence               numeric(4, 3) NOT NULL DEFAULT 1.000,
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT account_housing_profiles_attachment_type_check
        CHECK (attachment_type IN ('detached', 'attached', 'mixed', 'unknown')),
    CONSTRAINT account_housing_profiles_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT account_housing_profiles_value_check
        CHECK (
            NULLIF(btrim(structural_style), '') IS NOT NULL
            OR NULLIF(btrim(architectural_style), '') IS NOT NULL
        )
);

COMMENT ON TABLE core.account_housing_profiles IS
    'Curated, source-attributed account-level housing and architectural classifications. Used only as a fallback when an individual MLS source row omits the field.';

CREATE OR REPLACE VIEW core.v_account_housing_profiles AS
WITH account_ids AS (
    SELECT DISTINCT primary_account_id AS account_id
    FROM core.sales_source_records
    WHERE primary_account_id IS NOT NULL
    UNION
    SELECT account_id
    FROM core.account_housing_profiles
),
latest_structural AS (
    SELECT DISTINCT ON (primary_account_id)
        primary_account_id AS account_id,
        structural_style,
        housing_type,
        attachment_type,
        source_name,
        COALESCE(close_date, listing_contract_date)::timestamptz AS observed_at
    FROM core.sales_source_records
    WHERE primary_account_id IS NOT NULL
      AND NULLIF(btrim(structural_style), '') IS NOT NULL
    ORDER BY
        primary_account_id,
        COALESCE(close_date, listing_contract_date) DESC NULLS LAST,
        updated_at DESC,
        id DESC
),
latest_architectural AS (
    SELECT DISTINCT ON (primary_account_id)
        primary_account_id AS account_id,
        architectural_style,
        source_name,
        COALESCE(close_date, listing_contract_date)::timestamptz AS observed_at
    FROM core.sales_source_records
    WHERE primary_account_id IS NOT NULL
      AND NULLIF(btrim(architectural_style), '') IS NOT NULL
    ORDER BY
        primary_account_id,
        COALESCE(close_date, listing_contract_date) DESC NULLS LAST,
        updated_at DESC,
        id DESC
)
SELECT
    ids.account_id,
    COALESCE(
        NULLIF(btrim(curated.structural_style), ''),
        structural.structural_style
    ) AS structural_style,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
            THEN curated.housing_type
        ELSE structural.housing_type
    END AS housing_type,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
            THEN curated.attachment_type
        ELSE COALESCE(structural.attachment_type, 'unknown')
    END AS attachment_type,
    COALESCE(
        NULLIF(btrim(curated.architectural_style), ''),
        architectural.architectural_style
    ) AS architectural_style,
    COALESCE(
        CASE
            WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
              OR NULLIF(btrim(curated.architectural_style), '') IS NOT NULL
                THEN curated.source_name
        END,
        structural.source_name,
        architectural.source_name
    ) AS source_name,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
          OR NULLIF(btrim(curated.architectural_style), '') IS NOT NULL
            THEN curated.source_url
    END AS source_url,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
          OR NULLIF(btrim(curated.architectural_style), '') IS NOT NULL
            THEN curated.source_record_reference
    END AS source_record_reference,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
          OR NULLIF(btrim(curated.architectural_style), '') IS NOT NULL
            THEN curated.observed_at
        ELSE GREATEST(structural.observed_at, architectural.observed_at)
    END AS observed_at,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
          OR NULLIF(btrim(curated.architectural_style), '') IS NOT NULL
            THEN curated.confidence
        ELSE 1.000::numeric
    END AS confidence,
    CASE
        WHEN NULLIF(btrim(curated.structural_style), '') IS NOT NULL
          OR NULLIF(btrim(curated.architectural_style), '') IS NOT NULL
            THEN 'verified_override'
        ELSE 'mls_source_record'
    END AS profile_source
FROM account_ids ids
LEFT JOIN latest_structural structural
    ON structural.account_id = ids.account_id
LEFT JOIN latest_architectural architectural
    ON architectural.account_id = ids.account_id
LEFT JOIN core.account_housing_profiles curated
    ON curated.account_id = ids.account_id
WHERE COALESCE(
    NULLIF(btrim(curated.structural_style), ''),
    structural.structural_style,
    NULLIF(btrim(curated.architectural_style), ''),
    architectural.architectural_style
) IS NOT NULL;

COMMENT ON VIEW core.v_account_housing_profiles IS
    'One field-complete housing profile per account. Curated verified values take precedence; otherwise each field uses its latest nonblank MLS observation independently.';

CREATE TABLE IF NOT EXISTS core.sale_parcels (
    id                       bigserial PRIMARY KEY,
    source_record_id         bigint NOT NULL
                             REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
    source_position          smallint NOT NULL,
    parcel_sequence          smallint NOT NULL DEFAULT 1,
    parcel_role              text NOT NULL,
    parcel_number_raw        text NOT NULL,
    parcel_number_normalized text,
    account_id               text REFERENCES core.accounts(account_id),
    match_method             text NOT NULL,
    is_resolved              boolean NOT NULL,
    loaded_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sale_parcels_source_position_check
        CHECK (source_position IN (1, 2)),
    CONSTRAINT sale_parcels_sequence_check
        CHECK (parcel_sequence > 0),
    CONSTRAINT sale_parcels_role_check
        CHECK (parcel_role IN ('primary', 'additional')),
    CONSTRAINT sale_parcels_match_method_check
        CHECK (match_method IN (
            'exact', 'punctuation_normalized', 'embedded_full_id',
            'concatenated_full_ids', 'unmatched'
        )),
    CONSTRAINT sale_parcels_source_unique
        UNIQUE (source_record_id, source_position, parcel_sequence)
);

CREATE INDEX IF NOT EXISTS sale_parcels_account_idx
    ON core.sale_parcels (account_id, source_record_id);

CREATE INDEX IF NOT EXISTS sale_parcels_unresolved_idx
    ON core.sale_parcels (source_record_id)
    WHERE NOT is_resolved;

ALTER TABLE core.sales
    ADD COLUMN IF NOT EXISTS source_record_id bigint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sales_source_record_id_fkey'
          AND conrelid = 'core.sales'::regclass
    ) THEN
        ALTER TABLE core.sales
            ADD CONSTRAINT sales_source_record_id_fkey
            FOREIGN KEY (source_record_id)
            REFERENCES core.sales_source_records(id)
            ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS sales_source_record_unique_idx
    ON core.sales (source_record_id)
    WHERE source_record_id IS NOT NULL;

CREATE OR REPLACE VIEW core.v_sales_enriched AS
WITH parcel_rollup AS (
    SELECT
        source_record_id,
        count(DISTINCT source_position) AS provided_parcel_fields,
        count(DISTINCT account_id) FILTER (WHERE account_id IS NOT NULL)
            AS resolved_account_count,
        jsonb_agg(
            jsonb_build_object(
                'source_position', source_position,
                'parcel_sequence', parcel_sequence,
                'parcel_role', parcel_role,
                'parcel_number_raw', parcel_number_raw,
                'parcel_number_normalized', parcel_number_normalized,
                'account_id', account_id,
                'match_method', match_method,
                'is_resolved', is_resolved
            )
            ORDER BY source_position, parcel_sequence
        ) AS linked_parcels
    FROM core.sale_parcels
    GROUP BY source_record_id
)
SELECT
    s.id AS sale_id,
    src.id AS source_record_id,
    COALESCE(NULLIF(btrim(s.account_id), ''), src.primary_account_id)
        AS primary_account_id,
    a.county,
    COALESCE(s.address, a.address) AS address,
    s.city,
    s.state,
    s.zip,
    COALESCE(s.closing_date, src.close_date) AS closing_date,
    COALESCE(s.sale_price, src.current_price) AS sale_price,
    COALESCE(s.days_on_market, src.days_on_market) AS days_on_market,
    COALESCE(s.concessions, src.seller_contributions::text) AS concessions,
    src.seller_contributions,
    src.listing_contract_date,
    src.buyer_financing,
    src.mls_status,
    COALESCE(src.source_name, s.source) AS source,
    src.source_filename,
    src.source_files,
    src.source_row_number,
    src.source_record_hash,
    src.transaction_fingerprint,
    COALESCE(
        src.match_status,
        CASE
            WHEN NULLIF(btrim(s.account_id), '') IS NULL THEN 'unmatched'
            ELSE 'exact'
        END
    ) AS match_status,
    COALESCE(src.has_multiple_parcel_numbers, false) AS has_multiple_parcel_numbers,
    COALESCE(src.multi_parcel_status, 'single') AS multi_parcel_status,
    COALESCE(
        src.has_unresolved_parcel,
        NULLIF(btrim(s.account_id), '') IS NULL
    ) AS has_unresolved_parcel,
    COALESCE(
        src.requires_additional_review,
        NULLIF(btrim(s.account_id), '') IS NULL
    ) AS requires_additional_review,
    COALESCE(src.data_quality_flags, '[]'::jsonb) AS data_quality_flags,
    COALESCE(pr.provided_parcel_fields, 0) AS provided_parcel_fields,
    COALESCE(pr.resolved_account_count, 0) AS resolved_account_count,
    COALESCE(pr.linked_parcels, '[]'::jsonb) AS linked_parcels,

    src.bedrooms_total AS mls_bedrooms_total,
    src.bathrooms_total_integer AS mls_bathrooms_total_integer,
    src.bathrooms_full AS mls_bathrooms_full,
    src.bathrooms_half AS mls_bathrooms_half,
    src.living_area AS mls_living_area,
    src.lot_size_area AS mls_lot_size_area,
    src.year_built AS mls_year_built,
    src.garage_spaces AS mls_garage_spaces,
    src.garage_yn AS mls_garage_yn,
    src.pool_yn AS mls_pool_yn,
    src.ratio_current_price_by_living_area,
    src.ratio_close_price_by_list_price,
    src.ratio_close_price_by_original_list_price,
    src.ratio_close_price_by_living_area,

    pi.bedroom_count AS cad_bedroom_count,
    pi.bath_count AS cad_bath_count,
    pi.baths_full AS cad_baths_full,
    pi.baths_half AS cad_baths_half,
    pi.living_area_sqft AS cad_living_area_sqft,
    pi.total_area_sqft AS cad_total_area_sqft,
    pi.year_built AS cad_year_built,
    pi.effective_year_built AS cad_effective_year_built,
    pi.stories AS cad_stories,
    pi.pool AS cad_pool,
    pi.building_class AS cad_building_class,
    value_current.land_value AS cad_land_value,
    value_current.improvement_value AS cad_improvement_value,
    value_current.market_value AS cad_market_value,
    src.raw_payload,
    COALESCE(src.loaded_at, s.loaded_at) AS loaded_at,
    COALESCE(src.record_type, 'closed_sale') AS record_type,
    COALESCE(
        NULLIF(btrim(src.structural_style), ''),
        housing_profile.structural_style
    ) AS structural_style,
    CASE
        WHEN NULLIF(btrim(src.structural_style), '') IS NOT NULL
            THEN src.housing_type
        ELSE housing_profile.housing_type
    END AS housing_type,
    CASE
        WHEN NULLIF(btrim(src.structural_style), '') IS NOT NULL
            THEN COALESCE(src.attachment_type, 'unknown')
        ELSE COALESCE(housing_profile.attachment_type, 'unknown')
    END AS attachment_type,
    COALESCE(
        NULLIF(btrim(src.architectural_style), ''),
        housing_profile.architectural_style
    ) AS architectural_style
FROM core.sales s
FULL OUTER JOIN core.sales_source_records src
    ON src.id = s.source_record_id
LEFT JOIN parcel_rollup pr
    ON pr.source_record_id = src.id
LEFT JOIN core.accounts a
    ON a.account_id = COALESCE(NULLIF(btrim(s.account_id), ''), src.primary_account_id)
LEFT JOIN core.v_account_housing_profiles housing_profile
    ON housing_profile.account_id = COALESCE(
        NULLIF(btrim(s.account_id), ''),
        src.primary_account_id
    )
LEFT JOIN core.primary_improvements pi
    ON pi.account_id = COALESCE(NULLIF(btrim(s.account_id), ''), src.primary_account_id)
LEFT JOIN core.value_summary_current value_current
    ON value_current.account_id = COALESCE(
        NULLIF(btrim(s.account_id), ''),
        src.primary_account_id
    );

COMMENT ON VIEW core.v_sales_enriched IS
    'One row per closed sale or listing record. Includes legacy sales, all imported source rows, linked parcel flags, MLS snapshots, housing/architectural style, and current CAD characteristics. Multi-parcel prices remain transaction-level and must not be summed once per parcel.';
