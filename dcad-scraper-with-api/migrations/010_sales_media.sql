CREATE SCHEMA IF NOT EXISTS core;

ALTER TABLE core.sales_source_records
    ADD COLUMN IF NOT EXISTS listing_key text,
    ADD COLUMN IF NOT EXISTS listing_id text;

CREATE INDEX IF NOT EXISTS sales_source_records_listing_key_idx
    ON core.sales_source_records (listing_key)
    WHERE NULLIF(btrim(listing_key), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sales_source_records_listing_id_idx
    ON core.sales_source_records (listing_id)
    WHERE NULLIF(btrim(listing_id), '') IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.sales_source_media (
    id                       bigserial PRIMARY KEY,
    source_record_id         bigint NOT NULL
                             REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
    media_key                text,
    media_url                text NOT NULL,
    media_category           text NOT NULL DEFAULT 'image',
    mime_type                text,
    order_number             integer,
    preferred_photo_yn       boolean NOT NULL DEFAULT false,
    short_description        text,
    permission               text,
    modification_timestamp   timestamptz,
    source_filename          text NOT NULL,
    source_sha256            text NOT NULL,
    source_row_number        integer NOT NULL,
    raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
    loaded_at                timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sales_source_media_url_check
        CHECK (media_url ~* '^https?://'),
    CONSTRAINT sales_source_media_order_check
        CHECK (order_number IS NULL OR order_number >= 0),
    CONSTRAINT sales_source_media_unique
        UNIQUE (source_record_id, media_url)
);

CREATE INDEX IF NOT EXISTS sales_source_media_record_order_idx
    ON core.sales_source_media (
        source_record_id,
        preferred_photo_yn DESC,
        order_number NULLS LAST,
        id
    );

CREATE OR REPLACE VIEW core.v_sales_media_summary AS
SELECT
    source_record_id,
    (
        array_agg(
            media_url
            ORDER BY
                preferred_photo_yn DESC,
                order_number NULLS LAST,
                id
        )
    )[1] AS primary_photo_url,
    count(*)::integer AS photo_count
FROM core.sales_source_media
WHERE media_category = 'image'
GROUP BY source_record_id;

COMMENT ON TABLE core.sales_source_media IS
    'Ordered, source-attributed MLS media attached to one imported listing or sale record. URLs are stored rather than copied so MLS permissions and source ordering remain intact.';

COMMENT ON VIEW core.v_sales_media_summary IS
    'One lightweight primary-photo URL and image count per imported listing or sale for comparable-search responses.';
