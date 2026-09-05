const UAD_ASSET_APPLICABILITY_RULES = new Map([
  [7, Object.freeze({
    uid: "3300.0002",
    errorCode: "uad_sketch_asset_inapplicable",
  })],
  [20, Object.freeze({
    uid: "0600.0016",
    errorCode: "uad_sales_contract_asset_inapplicable",
  })],
  [22, Object.freeze({
    uid: "1000.0032",
    errorCode: "uad_sales_comparison_asset_inapplicable",
  })],
]);

function assetSectionNumber(asset) {
  return Number(asset?.sectionNumber ?? asset?.section_number);
}

export async function assertUadAssetsApplicable(queryable, workfileId, assets = []) {
  const rules = [...new Set(
    assets
      .map((asset) => UAD_ASSET_APPLICABILITY_RULES.get(assetSectionNumber(asset)))
      .filter(Boolean),
  )];
  if (!rules.length) return;
  const result = await queryable.query(
    `SELECT uad_uid, value
       FROM appraisal.uad_field_values
      WHERE workfile_id = $1
        AND entity_id IS NULL
        AND uad_uid = ANY($2::text[])`,
    [workfileId, rules.map((rule) => rule.uid)],
  );
  const values = new Map(result.rows.map((row) => [row.uad_uid, row.value]));
  for (const asset of assets) {
    const rule = UAD_ASSET_APPLICABILITY_RULES.get(assetSectionNumber(asset));
    if (rule && values.get(rule.uid) !== true) throw new Error(rule.errorCode);
  }
}

export async function assertUadAssetApplicable(queryable, workfileId, asset) {
  await assertUadAssetsApplicable(queryable, workfileId, [asset]);
}
