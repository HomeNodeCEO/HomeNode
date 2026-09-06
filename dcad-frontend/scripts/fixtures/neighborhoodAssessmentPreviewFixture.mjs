// Entirely synthetic display data. No cadastral, appraisal, source-authority,
// geometry-validation, scoring, report-save or historical-proof claim is made.
const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const binding = () => ({ target_key: 'fixture-target-session-A', operation_key: 'fixture-load-1', preview_key: 'fixture-candidate-1' });
const evidence = (kind, id, label, detail, support = 'supported') => ({
  key: id === null ? kind : `${kind}:${id}`, kind, id, label,
  observation_text: 'Synthetic observation; independently supplied display text.', support, detail,
});
const metric = (id, populationId, label, value, estimator, refs) => ({
  id, population_id: populationId, label, display_value: value, unit: null,
  estimator_label: estimator, status: value === null ? 'not_available' : 'available', evidence_keys: refs,
});
const field = (id, label, value, refs) => ({
  id, label, disposition: 'new', proposed: { status: 'value', text: value },
  current: { status: 'not_supplied', text: null }, explanation: 'Suggested value for whole-group review.', evidence_keys: refs,
});

/** Fresh owned data on every call. The two workflows intentionally share the
 * same display evidence; neither variant is a real workflow adapter. */
export function makeNeighborhoodAssessmentPreviewFixture({ workflow = 'custom_appraisal', variant = 'base' } = {}) {
  const current = { ...binding(), access: 'review', read_only: false, dirty: false,
    spatial_review: 'clear', actions: { refresh: true, open_review: true, edit_area: true } };
  const preview = {
    ...binding(), origin: 'synthetic_fixture', workflow, subject_label: 'Example subject at Cedar Court',
    effective_date: '2026-08-31', observation_period: { start_date: '2025-09-01', end_date: '2026-08-31' },
    data_cutoff: '2026-09-04',
    boundary: {
      neighborhood: { status: 'available', description: 'Cedar Court enclosure: six dwelling properties.', evidence_key: 'geographic_neighborhood' },
      analysis_area: { status: 'available', description: 'Cedar Court and separate Birch Place competitive pockets.', evidence_key: 'analysis_geography' },
      cardinals: Object.fromEntries(['north', 'east', 'south', 'west'].map((side, i) => [side, {
        status: 'supported', text: ['North Road', 'Creek reach and Plat edge', 'South Road', 'West Road'][i],
        evidence_keys: ['source:shared'],
      }])),
      outline_required_for_review: true,
      outline: { ...binding(), evidence_keys: ['geographic_neighborhood', 'analysis_geography'], frame: [0, 0, 240, 120],
        features: [
          { id: 'outline-subject', role: 'subject', label: 'Example subject', evidence_keys: ['source:shared'], polygons: [[ring(10, 10, 20, 20)]] },
          { id: 'outline-neighborhood', role: 'neighborhood', label: 'Cedar enclosure with park opening',
            evidence_keys: ['geographic_neighborhood'], polygons: [[ring(0, 0, 100, 100), ring(40, 40, 60, 60)]] },
          { id: 'outline-analysis', role: 'analysis_area', label: 'Two separate competitive pockets',
            evidence_keys: ['analysis_geography'], polygons: [[ring(0, 0, 100, 100)], [ring(160, 0, 220, 100)]] },
        ] },
    },
    populations: [
      { id: 'shared', role: 'geographic_stock', definition: 'Six dwelling properties inside the descriptive enclosure.',
        member_count: 6, unique_property_count: 6, coverage_text: 'One descriptive area; complete synthetic stock.',
        evidence_key: 'population:shared', metrics: [metric('stock-count', 'shared', 'Dwelling properties', '6', 'Distinct properties', ['population:shared'])] },
      { id: 'competitive', role: 'competitive_stock', definition: 'Ten eligible properties in two disconnected competitive pockets.',
        member_count: 10, unique_property_count: 10, coverage_text: 'Do not replace geographic stock with the competitive population.',
        evidence_key: 'population:competitive', metrics: [metric('competitive-count', 'competitive', 'Competitive properties', '10', 'Distinct properties', ['population:competitive'])] },
      { id: 'sales', role: 'sales_sample', definition: 'Seven observed sale events for six unique properties during the stated period.',
        member_count: 7, unique_property_count: 6, coverage_text: 'Sale events and unique property counts remain different.',
        evidence_key: 'population:sales', metrics: [
          metric('shared', 'sales', 'Median sale price', '$330,000', 'Median of admitted sale events', ['statistic:shared']),
          metric('sale-count', 'sales', 'Sales', '7', 'Count of admitted sale events', ['population:sales']),
          metric('trend', 'sales', 'Market trend', null, 'Trend unavailable from this synthetic evidence', ['source:unknown']),
        ] },
    ],
    pockets: [
      { id: 'cedar', label: 'Cedar Court', disposition: 'recommended', explanation: 'The subject pocket is separately described.', overlap_text: null, evidence_keys: ['population:shared'] },
      { id: 'birch', label: 'Birch Place', disposition: 'needs_review', explanation: 'Nearby alternative with independent evidence.',
        overlap_text: 'Shares two competitive properties with another alternative; counts are not pooled.', evidence_keys: ['population:competitive'] },
      { id: 'industrial', label: 'Industrial tract', disposition: 'excluded', explanation: 'Explicitly excluded from the competitive housing population.', overlap_text: null, evidence_keys: ['source:shared'] },
    ],
    fields: [
      field('boundary', 'Neighborhood description', 'Cedar Court enclosure', ['geographic_neighborhood']),
      field('analysis', 'Analysis area description', 'Cedar Court and Birch Place', ['analysis_geography']),
      field('period', 'Observation months', '12', ['population:sales']),
      field('sales-count', 'Total sales', '7', ['population:sales']),
      field('price-low', 'Low sale price', '$300,000', ['statistic:shared']),
      field('price-median', 'Median sale price', '$330,000', ['statistic:shared']),
      field('price-high', 'High sale price', '$360,000', ['statistic:shared']),
    ],
    evidence: [
      evidence('geographic_neighborhood', null, 'Descriptive neighborhood', 'The geographic stock uses only this enclosure.'),
      evidence('analysis_geography', null, 'Competitive analysis area', 'Two disconnected candidate pockets; no fabricated connecting geometry.'),
      evidence('population', 'shared', 'Geographic stock evidence', 'Six distinct dwelling properties.'),
      evidence('population', 'competitive', 'Competitive stock evidence', 'Ten eligible properties; alternative overlaps are not summed.'),
      evidence('population', 'sales', 'Sales sample evidence', 'Seven events involving six properties.'),
      evidence('statistic', 'shared', 'Median estimator evidence', 'A median is displayed as a median, not a predominant value.'),
      evidence('source', 'shared', 'Source document evidence', 'A separate record shares only the bare ID with other evidence categories.'),
      evidence('source', 'unknown', 'Incomplete trend evidence', 'Historical support remains unknown.', 'unknown'),
    ],
    review_items: [{ id: 'review-note', label: 'Review nearby alternatives', detail: 'Inspect pocket evidence before accepting a coherent group.',
      blocks_review: false, evidence_keys: ['population:competitive'] }],
  };
  if (variant === 'zero_sales') {
    const sales = preview.populations[2];
    sales.member_count = 0; sales.unique_property_count = 0;
    sales.definition = 'Verified synthetic empty sale sample during the observation period.';
    sales.metrics[0].display_value = null; sales.metrics[0].status = 'not_available';
    sales.metrics[1].display_value = '0';
    preview.fields[3].proposed.text = '0';
    for (const item of preview.fields.slice(4)) {
      item.disposition = 'empty_companion'; item.proposed = { status: 'not_proposed', text: null };
      item.explanation = 'Required price companion retained; zero sales produce no proposed price and no clearing write.';
    }
  } else if (variant === 'reused_conflict') {
    preview.fields[0].disposition = 'reused';
    preview.fields[0].current = { status: 'known_value', text: preview.fields[0].proposed.text };
    preview.fields[1].disposition = 'conflict';
    preview.fields[1].current = { status: 'known_value', text: 'Manual analysis area must be preserved' };
    preview.fields[1].explanation = 'The current manual value conflicts even without a separate blocking review item.';
  } else if (variant !== 'base') throw new Error('Unknown synthetic preview fixture variant');
  return { preview_version: 1, current, load: 'complete', preview };
}

export const serializeNeighborhoodAssessmentPreviewFixture = options => JSON.stringify(makeNeighborhoodAssessmentPreviewFixture(options));
