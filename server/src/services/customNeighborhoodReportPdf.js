// Read-only PDF presentation of the real catalog projector's normalized result.
// No source queries, selection, pooled metrics, legacy aliases or authority checks.
const LEFT = 42, WIDTH = 528, TOP = 88, BOTTOM = 738;
const label = {
  property_count: "Property count", transaction_count: "Transaction count", allocated_property_sale_count: "Allocated property sale count",
  listing_count: "Listing count", unique_property_count: "Unique property count", recorded_sale_price: "Recorded sale price",
  allocated_sale_price: "Package-allocated property sale price (not a recorded transaction price)",
  assessed_market_value: "CAD assessed market value (not a sale price)", predominant_sale_price: "Predominant sale price",
  sale_price_per_square_foot: "Sale price per square foot", assessed_value_per_square_foot: "CAD assessed value per square foot (not a sale price)",
  gla: "Gross living area", site_area: "Site area", age_at_effective_date: "Age at effective date", age_at_sale: "Age at sale",
  year_built: "Year built", days_on_market: "Days on market", sale_coverage_percent: "Sale coverage", data_coverage_percent: "Data coverage",
  cod_percent: "Coefficient of dispersion (COD)", underlying_market_change_percent: "Underlying market change",
};
const estimators = { count: "Count", exact_median: "Median", exact_quantile: "Quantile (type 7)", arithmetic_mean: "Arithmetic mean",
  ratio: "Ratio", modal_interval: "Predominant modal interval [lower, upper)", coefficient_of_dispersion: "Coefficient of dispersion", unsupported: "Unsupported estimator" };
const roles = { geographic_stock: "Geographic stock", competitive_stock: "Competitive stock", transactions: "Transactions", listings: "Listings" };
const units = { property: "Properties", canonical_transaction: "Canonical transactions", allocated_property_sale: "Allocated property sales", listing: "Listings" };
const basis = { closing_date: "closing date", contract_date: "contract date", status_as_of: "status as of", effective_date: "effective date" };
const supplied = value => value === null || value === undefined ? "Unavailable" : String(value);
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const currencyPerSf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatNumber = (value, unit) => unit === "USD" ? currency.format(value) : unit === "USD/ft2" ? currencyPerSf.format(value)
  : unit === "year" ? String(value) : decimal.format(value);
const displayCount = value => value === null || value === undefined ? "Unavailable" : decimal.format(value);
// Helvetica cannot represent arbitrary Unicode. Preserve unsupported characters
// as explicit escapes rather than silently dropping characters from stored IDs.
const ascii = value => Array.from(String(value)).map(char => char >= " " && char <= "~" ? char : `\\u{${char.codePointAt(0).toString(16)}}`).join("");
const period = value => `${value.start_date} through ${value.end_date}; date basis: ${basis[value.date_basis]}`;
const references = values => values.length ? JSON.stringify(values) : "Unavailable - no sources supplied";

function wrap(doc, value, width, font, size) {
  doc.font(font).fontSize(size);
  const words = ascii(value).split(/ +/), lines = [];
  let line = "";
  for (let word of words) {
    if (line && doc.widthOfString(`${line} ${word}`) <= width) { line += ` ${word}`; continue; }
    if (line) { lines.push(line); line = ""; }
    while (doc.widthOfString(word) > width) {
      let low = 1, high = word.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (doc.widthOfString(word.slice(0, middle)) <= width) low = middle;
        else high = middle - 1;
      }
      lines.push(word.slice(0, low)); word = word.slice(low);
    }
    line = word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Plan every supplied line before rendering so headers and photo offsets have
 * exact page counts. Long definitions, IDs and reasons continue without ellipsis.
 */
export function prepareCustomNeighborhoodPdfAppendix(doc, projected) {
  const assessment = projected.assessment, pages = [[]];
  let y = TOP;
  const paragraph = (value, heading = false) => {
    const font = heading ? "Helvetica-Bold" : "Helvetica", size = heading ? 9 : 8;
    const lines = wrap(doc, value, WIDTH, font, size);
    for (const text of lines) {
      if (y + 12 > BOTTOM) { pages.push([]); y = TOP; }
      pages.at(-1).push({ text, font, size, y, heading }); y += 12;
    }
    y += heading ? 3 : 4;
  };
  paragraph("Accepted neighborhood - complete supplied evidence", true);
  paragraph(`Assessment: ${assessment.id}; revision: ${assessment.revision}; evidence SHA-256: ${assessment.evidence_digest_sha256}.`);
  paragraph(`Operation: ${projected.operation_id}; accepted editor revision: ${projected.accepted_editor_revision}. Effective date: ${assessment.effective_date}; data cutoff: ${assessment.data_cutoff}.`);
  paragraph(`Study observation period: ${period(assessment.observation_period)}.`);
  paragraph("Values and statuses are producer-supplied, not recalculated. COD is dispersion, not reliability. Non-ASCII characters are preserved as Unicode escapes.");
  paragraph("Descriptive geographic boundaries (not competitive pocket selection)", true);
  const geography = assessment.geographic_neighborhood;
  paragraph(`Geography revision: ${geography.revision}; coordinate reference: ${geography.crs}; status: ${geography.status}.`);
  for (const direction of ["north", "east", "south", "west"]) paragraph(`${direction.toUpperCase()}: ${supplied(geography.cardinal_summaries[direction])}`);
  for (const edge of geography.perimeter) paragraph(`Perimeter edge ${edge.edge_id}: ${supplied(edge.name)}; from ${edge.from_node} to ${edge.to_node}; sources: ${references(edge.source_refs)}.`);
  paragraph("Selected competitive pocket IDs", true);
  paragraph(assessment.selection.pocket_ids.length ? JSON.stringify(assessment.selection.pocket_ids) : "No competitive pockets selected (0 supplied IDs).");
  paragraph(`Selection revision: ${assessment.selection.revision}; housing eligibility: ${supplied(assessment.selection.housing_eligibility)}; overrides: ${JSON.stringify(assessment.selection.overrides)}.`);
  for (const population of assessment.populations) {
    paragraph(`Population ${population.id} - ${roles[population.kind]}`, true);
    paragraph(`Definition: ${population.definition}`);
    paragraph(`Member count: ${displayCount(population.member_count)} (${units[population.member_unit]}); unique property count: ${displayCount(population.unique_property_count)}; property link count: ${displayCount(population.property_link_count)}.`);
    paragraph(`Completeness: ${population.completeness}; reasons: ${population.reasons.length ? JSON.stringify(population.reasons) : "none"}. Observation period: ${period(population.observation_period)}.`);
    paragraph(`Pocket IDs: ${JSON.stringify(population.pocket_ids)}; sources: ${references(population.source_refs)}.`);
    paragraph(`Members resource: ${population.members_resource_id}; member-set SHA-256: ${supplied(population.member_set_sha256)}.`);
    const statistics = assessment.statistics.filter(statistic => statistic.population_id === population.id);
    if (!statistics.length) paragraph("Unavailable - no statistics supplied for this population.");
    for (const statistic of statistics) {
      let title = label[statistic.measurement];
      if (population.member_unit === "allocated_property_sale" && ["predominant_sale_price", "sale_price_per_square_foot"].includes(statistic.measurement)) title = `Package-allocated ${title.toLowerCase()}`;
      if (statistic.measurement.startsWith("assessed_")) title += `; tax year: ${supplied(statistic.assessment_tax_year)}`;
      paragraph(`Statistic ${statistic.id} - ${title}`, true);
      let value = statistic.status === "ready" ? `${formatNumber(statistic.value, statistic.unit)} ${statistic.unit}` : `Unavailable - ${statistic.reason || statistic.status}`;
      if (statistic.status === "ready" && statistic.estimator === "modal_interval") {
        const parameters = statistic.estimator_parameters;
        value = `[${formatNumber(parameters.lower_bound, statistic.unit)}, ${formatNumber(parameters.upper_bound, statistic.unit)}) ${statistic.unit}; supplied value ${formatNumber(statistic.value, statistic.unit)} ${statistic.unit}`;
      }
      paragraph(`Estimator: ${estimators[statistic.estimator]}; status: ${statistic.status}; value: ${value}.`);
      paragraph(`Observed: ${displayCount(statistic.observed_count)}; missing: ${displayCount(statistic.missing_count)}; denominator: ${displayCount(statistic.denominator_count)}; denominator basis: ${statistic.denominator_basis === "unique_properties" ? "unique properties" : "population members"}.`);
      paragraph(`Observation period: ${period(statistic.observation_period)}. Sources: ${references(statistic.source_refs)}.`);
      paragraph(`Estimator metadata: ${JSON.stringify(statistic.estimator_parameters)}; uncertainty: ${JSON.stringify(statistic.uncertainty)}.`);
    }
  }
  paragraph("Source snapshots", true);
  for (const source of assessment.source_snapshots) {
    paragraph(`Source ${source.id} - ${source.provider}`, true);
    paragraph(`Revision: ${source.revision}; observed at: ${source.observed_at}; historical availability: ${source.historical_availability}.`);
    paragraph(`Valid from: ${supplied(source.valid_from)}; valid through: ${supplied(source.valid_to)}; visibility: ${source.visibility}; scope: ${source.scope === null ? "public" : JSON.stringify(source.scope)}.`);
    paragraph(`Content SHA-256: ${source.content_sha256}.`);
  }
  return pages;
}

/** Shared north-up display frame, but a separate closed path for EVERY supplied
 * ring. Even-odd fill preserves holes; disconnected rings are never connected.
 * This is a coordinate schematic, not a basemap or a topology assertion.
 */
export function drawCustomNeighborhoodOutline(doc, geometry, frame) {
  const rings = geometry.coordinates;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const scale = Math.min((frame.width - 24) / Math.max(maxX - minX, 0.000001), (frame.height - 24) / Math.max(maxY - minY, 0.000001));
  const left = frame.x + (frame.width - (maxX - minX) * scale) / 2;
  const top = frame.y + (frame.height - (maxY - minY) * scale) / 2;
  doc.roundedRect(frame.x, frame.y, frame.width, frame.height, 5).fillAndStroke("#f8fafc", "#cbd5e1");
  doc.save().lineWidth(1).fillOpacity(0.12).strokeOpacity(1);
  for (const ring of rings) {
    ring.forEach(([x, y], index) => doc[index === 0 ? "moveTo" : "lineTo"](left + (x - minX) * scale, top + (maxY - y) * scale));
    doc.closePath();
  }
  doc.fillAndStroke("#7c3aed", "#5b21b6", "even-odd").restore();
}

export function renderCustomNeighborhoodPdfSummary(doc, projected, appendix) {
  const assessment = projected.assessment;
  const write = (value, x, y, width = WIDTH, size = 8, bold = false, height = undefined) => doc.font(bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(size).fillColor("#0f172a").text(ascii(value), x, y, { width, ...(height ? { height, ellipsis: true } : {}) });
  write("ACCEPTED NEIGHBORHOOD GROUP", LEFT, 90, WIDTH, 9, true);
  write(`Assessment ${assessment.id} / revision ${assessment.revision}`, LEFT, 108);
  write(`Accepted operation ${projected.operation_id} / editor revision ${projected.accepted_editor_revision}`, LEFT, 124);
  write(`Effective date ${assessment.effective_date} / data cutoff ${assessment.data_cutoff}`, LEFT, 140);
  write(`Study period: ${period(assessment.observation_period)}`, LEFT, 156);
  drawCustomNeighborhoodOutline(doc, assessment.geographic_neighborhood.geometry, { x: LEFT, y: 184, width: 300, height: 202 });
  write("Descriptive geography", 355, 190, 210, 9, true);
  write("Stored geographic boundary only. The outline is a north-up longitude/latitude schematic, without a basemap. It does not depict competitive pocket shapes or measure distances.", 355, 210, 210);
  write(`Selected competitive pockets: ${displayCount(assessment.selection.pocket_ids.length)}. Exact IDs and complete boundary descriptions are retained in the appendix. Population membership is separate from descriptive geography.`, 355, 282, 210);
  const short = value => {
    const result = ascii(value);
    return result.length <= 125 ? result : `${result.slice(0, 125)} [full text in appendix]`;
  };
  ["north", "east", "south", "west"].forEach((direction, index) => {
    const x = LEFT + (index % 2) * 270, y = 410 + Math.floor(index / 2) * 76;
    write(direction.toUpperCase(), x, y, 250, 8, true);
    write(short(assessment.geographic_neighborhood.cardinal_summaries[direction]), x, y + 16, 250, 8, false, 52);
  });
  write("COMPLETE ACCEPTED EVIDENCE", LEFT, 574, WIDTH, 9, true);
  write(`All ${displayCount(assessment.populations.length)} supplied populations, ${displayCount(assessment.statistics.length)} statistics and ${displayCount(assessment.source_snapshots.length)} source snapshots appear on appendix pages ${appendix.firstPage}-${appendix.firstPage + appendix.pageCount - 1}. No populations are pooled or limited to the first 30 sales.`, LEFT, 594);
  write("Recorded sale prices, package-allocated prices and CAD assessed values are distinct. Median is not predominant. Age at sale is not age at the effective date. Unsupported and incomplete statistics remain unavailable with their supplied reasons.", LEFT, 630);
  write("COD measures dispersion, not reliability. Legacy neighborhood form values are not mixed into this accepted group. Land use and other legacy-only judgments are unavailable in this catalog unless supplied as typed accepted evidence.", LEFT, 675);
}

export function renderCustomNeighborhoodPdfAppendix(doc, pages, addPage) {
  pages.forEach((lines, index) => {
    addPage(index);
    for (const line of lines) doc.font(line.font).fontSize(line.size).fillColor(line.heading ? "#4c1d95" : "#0f172a")
      .text(line.text, LEFT, line.y, { lineBreak: false });
  });
}
