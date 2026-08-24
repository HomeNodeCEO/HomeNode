import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createRedTeamAccessTokenFactory } from "../src/modules/uad/uadRedTeamAuthorization.js";

const API_ORIGIN = "https://homenode-api-redteam.onrender.com";
const APP_ORIGIN = "https://homenode-uad-redteam.onrender.com";
const FIXTURE_ACCOUNT_ID = "UAD-REDTEAM-SFR-0001";
const FIXTURE_FILE_NUMBER = "HN-REDTEAM-DELIVERY-A-0001";
const outputDirectory = path.resolve(process.env.UAD_REDTEAM_BROWSER_OUTPUT_DIRECTORY || "uad-redteam-browser");

function requiredRedTeamOrigin(value, expected, code) {
  const parsed = new URL(String(value || expected));
  if (parsed.origin !== expected || !parsed.hostname.includes("redteam")) throw new Error(code);
  return parsed.origin;
}

function sanitizeBrowserDiagnostic(value) {
  return String(value || "")
    .replace(/https:\/\/[^\s'\"]*\.r2\.cloudflarestorage\.com\/[^\s'\"]+/gi, "[redacted-r2-signed-url]")
    .replace(/X-Amz-[A-Za-z-]+=[^\s&'\"]+/gi, "X-Amz-[redacted]")
    .slice(0, 500);
}

const apiOrigin = requiredRedTeamOrigin(process.env.UAD_REDTEAM_BASE_URL, API_ORIGIN, "invalid_uad_redteam_api_url");
const appOrigin = requiredRedTeamOrigin(process.env.UAD_REDTEAM_APP_URL, APP_ORIGIN, "invalid_uad_redteam_app_url");
const fixtureAccountId = String(process.env.UAD_REDTEAM_FIXTURE_ACCOUNT_ID || FIXTURE_ACCOUNT_ID).trim();
if (fixtureAccountId !== FIXTURE_ACCOUNT_ID) throw new Error("invalid_uad_redteam_browser_fixture");

const getAccessToken = createRedTeamAccessTokenFactory({
  privateKeyPem: process.env.UAD_REDTEAM_JWT_PRIVATE_KEY,
  keyId: process.env.UAD_REDTEAM_JWT_KEY_ID,
  issuer: process.env.UAD_REDTEAM_OIDC_ISSUER,
  audience: process.env.UAD_REDTEAM_OIDC_AUDIENCE,
  subjectsJson: process.env.UAD_REDTEAM_OIDC_SUBJECTS_JSON,
  unprovisionedSubject: process.env.UAD_REDTEAM_UNPROVISIONED_SUBJECT,
});

await fs.mkdir(outputDirectory, { recursive: true });
const evidence = {
  ok: false,
  profile: "uad_redteam_authenticated_browser_v1",
  synthetic_only: true,
  fixture_account_id: fixtureAccountId,
  fixture_file_number: FIXTURE_FILE_NUMBER,
  checks: {},
  initial_validation: null,
  validation: null,
  storage: { required_count: 0, verified_before: 0, uploaded: 0, verified_after: 0 },
  delivery: {
    pre_signature_review: null,
    signature: null,
    pdf: null,
    xml: null,
    manifest: null,
    package: null,
  },
  api: { request_count: 0, failure_count: 0, failures: [] },
  browser: { page_errors: [], console_errors: [] },
};

let browser;
let page;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    colorScheme: "light",
    serviceWorkers: "block",
    viewport: { width: 1600, height: 1200 },
  });
  const accessToken = await getAccessToken("assigned_appraiser_a");
  const apiJson = async (pathname, options = {}) => {
    const response = await fetch(`${apiOrigin}${pathname}`, {
      ...options,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`redteam_browser_api_${response.status}:${pathname.split("?")[0]}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`redteam_browser_api_invalid_json:${pathname.split("?")[0]}`);
    }
  };
  const artifactObject = async (artifact, label) => {
    if (!artifact?.ready_for_download || !artifact.download?.url) {
      throw new Error(`redteam_${label}_download_not_ready`);
    }
    const response = await fetch(artifact.download.url);
    if (!response.ok) throw new Error(`redteam_${label}_download_${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const checksum = createHash("sha256").update(body).digest("hex");
    if (checksum !== artifact.checksum_sha256) throw new Error(`redteam_${label}_checksum_mismatch`);
    if (body.length !== Number(artifact.byte_size)) throw new Error(`redteam_${label}_size_mismatch`);
    return body;
  };
  await context.addInitScript((token) => {
    Object.defineProperty(window, "homenodeAuth", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ getAccessToken: async () => token }),
      writable: false,
    });
  }, accessToken);
  page = await context.newPage();
  page.on("pageerror", (error) => {
    evidence.browser.page_errors.push(sanitizeBrowserDiagnostic(error?.message || error));
  });
  page.on("console", (message) => {
    if (message.type() === "error") evidence.browser.console_errors.push(sanitizeBrowserDiagnostic(message.text()));
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== apiOrigin) return;
    evidence.api.request_count += 1;
    if (response.status() >= 400) {
      evidence.api.failure_count += 1;
      evidence.api.failures.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
      });
    }
  });

  await page.goto(`${appOrigin}/uad-3.6/${encodeURIComponent(fixtureAccountId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.getByRole("heading", { name: "UAD 3.6 Workspace" }).waitFor({ timeout: 30_000 });
  const workfileCard = page.locator("article").filter({ hasText: FIXTURE_FILE_NUMBER }).first();
  await workfileCard.getByText(FIXTURE_FILE_NUMBER, { exact: true }).waitFor({ timeout: 30_000 });
  evidence.checks.authenticated_workspace_loaded = !(await page.getByText("invalid_access_token", { exact: true }).count());

  await workfileCard.getByRole("button", { name: "Open Assignment & Subject" }).click();
  await page.getByRole("heading", { name: FIXTURE_FILE_NUMBER, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Appraiser signature and credential snapshot" }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Native Uniform Residential Appraisal Report" }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "MISMO 3.6 XML and official subschema gate" }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Revision-bound UAD delivery package" }).waitFor({ timeout: 30_000 });
  evidence.checks.editor_loaded = true;
  evidence.checks.signature_ui_present = true;

  await page.getByRole("button", { name: /^Section 22: Sales Comparison Approach/ }).click();
  await page.getByText("Section 22O subject Summary redisplays", { exact: true }).waitFor({ timeout: 15_000 }).catch(() => {});
  const salesSection = await page.locator("main").innerText();
  const comparableLabels = salesSection.match(/Sales Comparable\s+\d+/g) || [];
  evidence.checks.sales_comparison_section_loaded = salesSection.includes("Sections 22A–22Q");
  evidence.checks.sales_comparable_count = new Set(comparableLabels).size;
  evidence.checks.sales_rich_fixture = evidence.checks.sales_comparable_count >= 3;

  await page.getByRole("button", { name: /^Section 26: Reconciliation/ }).click();
  await page.getByText("Canonical values redisplayed in Section 26", { exact: true }).waitFor({ timeout: 15_000 });
  const reconciliationText = await page.locator("main").innerText();
  evidence.checks.reconciliation_section_loaded = reconciliationText.includes("Canonical values redisplayed in Section 26");
  evidence.checks.sales_conclusion_present = /Sales Comparison[\s\S]*\$[0-9]/.test(reconciliationText);

  const validationPanel = page.getByRole("heading", {
    name: "Whole-workfile UAD readiness",
    exact: true,
  }).locator("..").locator("..").locator("..");
  const validationResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === apiOrigin
      && url.pathname.endsWith("/validation")
      && response.request().method() === "POST";
  }, { timeout: 60_000 });
  await validationPanel.getByRole("button", { name: /Run (?:full UAD validation|validation again)/ }).click();
  const validationResponse = await validationResponsePromise;
  const validationPayload = await validationResponse.json();
  const validation = validationPayload?.validation;
  const findings = Array.isArray(validation?.findings) ? validation.findings : [];
  const countBy = (selectedFindings, selector) => Object.fromEntries(
    [...selectedFindings.reduce((counts, finding) => {
      const key = String(selector(finding) || "unspecified").slice(0, 120);
      counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  const summarizeValidation = (result) => {
    const selectedFindings = Array.isArray(result?.findings) ? result.findings : [];
    return result ? {
      status: result.status,
      revision_number: result.revision_number,
      fatal_count: result.fatal_count,
      warning_count: result.warning_count,
      ready_for_export: result.ready_for_export,
      finding_count: selectedFindings.length,
      section_counts: countBy(selectedFindings, (finding) => finding.metadata?.section),
      code_counts: countBy(selectedFindings, (finding) => finding.metadata?.code),
    } : null;
  };
  evidence.initial_validation = summarizeValidation(validation);
  evidence.validation = validation ? {
    status: validation.status,
    revision_number: validation.revision_number,
    fatal_count: validation.fatal_count,
    warning_count: validation.warning_count,
    ready_for_export: validation.ready_for_export,
    finding_count: findings.length,
    section_counts: countBy(findings, (finding) => finding.metadata?.section),
    code_counts: countBy(findings, (finding) => finding.metadata?.code),
  } : null;
  await validationPanel.getByText(/Revision \d+ (?:has \d+ blocking finding|passed every current local UAD rule)/).waitFor({ timeout: 60_000 });
  const validationText = await validationPanel.innerText();
  const fatalFindingCount = findings.filter((finding) => finding.severity === "fatal").length;
  const warningFindingCount = findings.filter((finding) => finding.severity === "warning").length;
  evidence.checks.local_validation_completed = validationResponse.ok() && Boolean(validation);
  evidence.checks.local_validation_result_rendered = validation?.status === "passed"
    ? validationText.includes(`Revision ${validation.revision_number} passed every current local UAD rule`)
    : validationText.includes(`Revision ${validation?.revision_number} has ${validation?.fatal_count} blocking finding`);
  evidence.checks.local_validation_counts_consistent = validation?.fatal_count === fatalFindingCount
    && validation?.warning_count === warningFindingCount
    && findings.length === fatalFindingCount + warningFindingCount;

  const workfiles = await apiJson(`/api/uad/accounts/${encodeURIComponent(fixtureAccountId)}/workfiles`);
  const workfile = workfiles.workfiles?.find((candidate) => candidate.file_number === FIXTURE_FILE_NUMBER);
  if (!workfile?.id) throw new Error("redteam_browser_delivery_workfile_missing");
  const editor = await apiJson(`/api/uad/workfiles/${encodeURIComponent(workfile.id)}/editor`);
  const valueByEntityAndUid = new Map(editor.values.map((value) => [
    `${value.entity_id || "root"}:${value.uid}`,
    value.value,
  ]));
  const requiredAssets = [{
    entity_id: null,
    asset_kind: "sketch",
    section_number: 7,
    caption_type: "SubjectPropertyImprovementSketch",
  }];
  for (const entity of editor.entities) {
    if (entity.entity_type === "dwelling") {
      requiredAssets.push({ entity_id: entity.id, asset_kind: "photo", section_number: 8, caption_type: "DwellingFront" });
    }
    if (entity.entity_type === "outbuilding") {
      requiredAssets.push(
        { entity_id: entity.id, asset_kind: "photo", section_number: 12, caption_type: "OutbuildingFront" },
        { entity_id: entity.id, asset_kind: "photo", section_number: 12, caption_type: "OutbuildingInterior" },
      );
    }
    if (entity.entity_type === "unit_room") {
      const captionType = valueByEntityAndUid.get(`${entity.id}:0700.0035`);
      if (typeof captionType !== "string" || !captionType) throw new Error("redteam_browser_room_caption_missing");
      requiredAssets.push({ entity_id: entity.id, asset_kind: "photo", section_number: 10, caption_type: captionType });
    }
    if (entity.entity_type === "sales_comparable") {
      requiredAssets.push({ entity_id: entity.id, asset_kind: "photo", section_number: 22, caption_type: "PropertyPhoto" });
    }
  }
  const assetKey = (asset) => `${asset.entity_id || "root"}:${asset.section_number}:${asset.caption_type}`;
  const expectedAssetFindingCodes = new Set([
    "dwelling_front_photo_required",
    "outbuilding_photo_required",
    "sales_comparable_photo_required",
    "sketch_asset_required",
    "unit_room_photo_required",
  ]);
  evidence.storage.required_count = requiredAssets.length;
  evidence.checks.only_expected_asset_findings = findings.every((finding) => (
    finding.severity === "fatal" && expectedAssetFindingCodes.has(finding.metadata?.code)
  ));
  evidence.checks.required_asset_plan_complete = requiredAssets.length === 13
    && new Set(requiredAssets.map(assetKey)).size === requiredAssets.length;

  const initialAssets = await apiJson(`/api/uad/workfiles/${encodeURIComponent(workfile.id)}/assets`);
  const verifiedAssetKeys = new Set((initialAssets.assets || [])
    .filter((asset) => asset.status === "verified")
    .map(assetKey));
  evidence.storage.verified_before = requiredAssets.filter((asset) => verifiedAssetKeys.has(assetKey(asset))).length;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  for (const [index, asset] of requiredAssets.entries()) {
    if (verifiedAssetKeys.has(assetKey(asset))) continue;
    const fileStem = `${asset.section_number}-${asset.caption_type}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const created = await apiJson(`/api/uad/workfiles/${encodeURIComponent(workfile.id)}/assets/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...asset,
        entity_id: asset.entity_id || undefined,
        file_name: `synthetic-redteam-${fileStem}-${index + 1}.png`,
        content_type: "image/png",
        byte_size: png.length,
        caption: `Synthetic red-team ${asset.caption_type}`.slice(0, 100),
        capture_metadata: { synthetic: true, environment: "redteam", source: "authenticated_browser" },
      }),
    });
    let uploaded;
    try {
      uploaded = await page.evaluate(async ({ upload, bytes }) => {
        const response = await fetch(upload.url, {
          method: upload.method,
          headers: { ...upload.headers, "content-type": "image/png" },
          body: Uint8Array.from(bytes),
        });
        return { ok: response.ok, status: response.status };
      }, { upload: created.upload, bytes: [...png] });
    } catch {
      throw new Error("redteam_r2_browser_upload_failed");
    }
    if (!uploaded.ok) throw new Error(`redteam_r2_browser_upload_${uploaded.status}`);
    const verified = await apiJson(
      `/api/uad/workfiles/${encodeURIComponent(workfile.id)}/assets/${encodeURIComponent(created.asset_id)}/verify`,
      { method: "POST" },
    );
    if (verified.asset?.status !== "verified") throw new Error("redteam_r2_asset_not_verified");
    evidence.storage.uploaded += 1;
  }
  const finalAssets = await apiJson(`/api/uad/workfiles/${encodeURIComponent(workfile.id)}/assets`);
  const finalVerifiedKeys = new Set((finalAssets.assets || [])
    .filter((asset) => asset.status === "verified")
    .map(assetKey));
  evidence.storage.verified_after = requiredAssets.filter((asset) => finalVerifiedKeys.has(assetKey(asset))).length;
  evidence.checks.required_assets_verified = evidence.storage.verified_after === requiredAssets.length;

  const postAssetValidationResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === apiOrigin
      && url.pathname.endsWith("/validation")
      && response.request().method() === "POST";
  }, { timeout: 60_000 });
  await validationPanel.getByRole("button", { name: "Run validation again", exact: true }).click();
  const postAssetValidationResponse = await postAssetValidationResponsePromise;
  const postAssetValidationPayload = await postAssetValidationResponse.json();
  const postAssetValidation = postAssetValidationPayload?.validation;
  const postAssetFindings = Array.isArray(postAssetValidation?.findings) ? postAssetValidation.findings : [];
  evidence.validation = summarizeValidation(postAssetValidation);
  await validationPanel.getByText(
    `Revision ${postAssetValidation?.revision_number} passed every current local UAD rule and is ready for the next generation step.`,
    { exact: true },
  ).waitFor({ timeout: 60_000 });
  evidence.checks.post_asset_validation_completed = postAssetValidationResponse.ok() && Boolean(postAssetValidation);
  evidence.checks.post_asset_validation_counts_consistent = postAssetValidation?.fatal_count === 0
    && postAssetValidation?.warning_count === 0
    && postAssetFindings.length === 0;
  evidence.checks.workfile_ready_for_export = postAssetValidation?.status === "passed"
    && postAssetValidation?.ready_for_export === true;

  const artifactPanel = (heading) => page.getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::section[1]");
  const triggerArtifactGeneration = async ({ heading, button, route, timeout }) => {
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === apiOrigin
        && url.pathname.endsWith(route)
        && response.request().method() === "POST";
    }, { timeout });
    await artifactPanel(heading).getByRole("button", { name: button }).click({ timeout: 60_000 });
    const response = await responsePromise;
    const payload = await response.json();
    if (!response.ok()) throw new Error(`redteam_artifact_generation_${response.status()}:${route}`);
    return payload;
  };
  const generatePdfThroughUi = () => triggerArtifactGeneration({
    heading: "Native Uniform Residential Appraisal Report",
    button: /^(?:Generate PDF|Regenerate PDF)$/,
    route: "/artifacts/pdf",
    timeout: 180_000,
  });
  const generateXmlThroughUi = () => triggerArtifactGeneration({
    heading: "MISMO 3.6 XML and official subschema gate",
    button: /^(?:Generate and validate XML|Regenerate XML)$/,
    route: "/artifacts/xml",
    timeout: 120_000,
  });

  const validatedEditor = await apiJson(`/api/uad/workfiles/${encodeURIComponent(workfile.id)}/editor`);
  const signedStatuses = new Set(["signed", "exported", "submitted"]);
  if (!signedStatuses.has(validatedEditor.workfile?.status)) {
    if (validatedEditor.workfile?.status !== "ready") throw new Error("redteam_delivery_workfile_not_ready");
    const reviewPdf = await generatePdfThroughUi();
    const reviewXml = await generateXmlThroughUi();
    evidence.delivery.pre_signature_review = {
      revision_number: reviewPdf.artifact?.revision_number,
      pdf_status: reviewPdf.artifact?.generation_status,
      pdf_signer_count: Number(reviewPdf.artifact?.metadata?.signer_count || 0),
      xml_status: reviewXml.artifact?.generation_status,
      xml_schema_status: reviewXml.schema_validation?.status,
      xml_schema_fatal_count: reviewXml.schema_validation?.fatal_count,
      xml_signer_count: Number(reviewXml.artifact?.metadata?.signer_count || 0),
    };
    evidence.checks.pre_signature_review_artifacts_ready = reviewPdf.artifact?.generation_status === "ready"
      && reviewPdf.artifact?.ready_for_download === true
      && reviewXml.artifact?.generation_status === "ready"
      && reviewXml.artifact?.ready_for_download === true
      && reviewXml.schema_validation?.status === "passed"
      && reviewXml.schema_validation?.fatal_count === 0;

    const signaturePanel = artifactPanel("Appraiser signature and credential snapshot");
    const attestation = signaturePanel.getByLabel(/I reviewed the current PDF, schema-valid XML/);
    await attestation.waitFor({ timeout: 60_000 });
    await attestation.check();
    const signatureResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === apiOrigin
        && url.pathname.endsWith("/signatures")
        && response.request().method() === "POST";
    }, { timeout: 60_000 });
    await signaturePanel.getByRole("button", { name: "Sign current revision", exact: true }).click({ timeout: 60_000 });
    const signatureResponse = await signatureResponsePromise;
    const signature = await signatureResponse.json();
    if (!signatureResponse.ok()) throw new Error(`redteam_signature_${signatureResponse.status()}`);
    evidence.delivery.signature = {
      reused: false,
      revision_number: signature.signature?.revision_number,
      signer_role: signature.signature?.signer_role,
      workfile_status: signature.workfile_status,
      input_digest_sha256: signature.signature?.workfile_input_digest_sha256,
      credential_snapshot_sha256: signature.signature?.credential_snapshot_sha256,
    };
  } else {
    evidence.checks.pre_signature_review_artifacts_ready = true;
    evidence.delivery.signature = {
      reused: true,
      revision_number: validatedEditor.workfile.current_revision,
      workfile_status: validatedEditor.workfile.status,
    };
  }
  evidence.checks.signature_sealed = signedStatuses.has(evidence.delivery.signature?.workfile_status)
    && Number(evidence.delivery.signature?.revision_number) === Number(validatedEditor.workfile?.current_revision);

  const finalPdfResult = await generatePdfThroughUi();
  const finalXmlResult = await generateXmlThroughUi();
  const finalPdf = finalPdfResult.artifact;
  const finalXml = finalXmlResult.artifact;
  const pdfBody = await artifactObject(finalPdf, "pdf");
  const xmlBody = await artifactObject(finalXml, "xml");
  const xmlText = xmlBody.toString("utf8");
  evidence.delivery.pdf = {
    status: finalPdf?.generation_status,
    revision_number: finalPdf?.revision_number,
    byte_size: finalPdf?.byte_size,
    checksum_sha256: finalPdf?.checksum_sha256,
    page_count: finalPdf?.metadata?.page_count,
    rendered_asset_count: finalPdf?.metadata?.rendered_asset_count,
    signer_count: finalPdf?.metadata?.signer_count,
  };
  evidence.delivery.xml = {
    status: finalXml?.generation_status,
    revision_number: finalXml?.revision_number,
    byte_size: finalXml?.byte_size,
    checksum_sha256: finalXml?.checksum_sha256,
    schema_status: finalXmlResult.schema_validation?.status,
    schema_fatal_count: finalXmlResult.schema_validation?.fatal_count,
    schema_warning_count: finalXmlResult.schema_validation?.warning_count,
    signer_count: finalXml?.metadata?.signer_count,
    image_reference_count: finalXml?.metadata?.image_reference_count,
    sales_comparable_count: (xmlText.match(/ValuationUseType="SalesComparable"/g) || []).length,
    adjustment_count: (xmlText.match(/<ComparableAdjustmentAmount>/g) || []).length,
    reconciliation_count: (xmlText.match(/<SalesComparisonCommentDescription>/g) || []).length,
  };
  evidence.checks.signed_pdf_verified = pdfBody.subarray(0, 5).toString("ascii") === "%PDF-"
    && finalPdf?.generation_status === "ready"
    && Number(finalPdf?.metadata?.page_count || 0) > 0
    && Number(finalPdf?.metadata?.rendered_asset_count || 0) === requiredAssets.length
    && Number(finalPdf?.metadata?.signer_count || 0) >= 1;
  evidence.checks.signed_xml_verified = xmlText.startsWith("<?xml")
    && finalXml?.generation_status === "ready"
    && finalXmlResult.schema_validation?.status === "passed"
    && finalXmlResult.schema_validation?.fatal_count === 0
    && Number(finalXml?.metadata?.signer_count || 0) >= 1
    && Number(finalXml?.metadata?.image_reference_count || 0) === requiredAssets.length
    && evidence.delivery.xml.sales_comparable_count >= 3
    && evidence.delivery.xml.adjustment_count >= 1
    && evidence.delivery.xml.reconciliation_count >= 1;

  const packageResult = await triggerArtifactGeneration({
    heading: "Revision-bound UAD delivery package",
    button: /^(?:Generate package|Regenerate package)$/,
    route: "/artifacts/submission-package",
    timeout: 180_000,
  });
  const manifestBody = await artifactObject(packageResult.manifest, "manifest");
  const packageBody = await artifactObject(packageResult.package, "package");
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  const endOfCentralDirectory = packageBody.subarray(-22);
  const zipEntryCount = endOfCentralDirectory.length === 22
    && endOfCentralDirectory.readUInt32LE(0) === 0x06054b50
    ? endOfCentralDirectory.readUInt16LE(10)
    : 0;
  evidence.delivery.manifest = {
    status: packageResult.manifest?.generation_status,
    byte_size: packageResult.manifest?.byte_size,
    checksum_sha256: packageResult.manifest?.checksum_sha256,
    image_count: manifest.image_count,
  };
  evidence.delivery.package = {
    status: packageResult.package?.generation_status,
    byte_size: packageResult.package?.byte_size,
    checksum_sha256: packageResult.package?.checksum_sha256,
    entry_count: packageResult.package?.metadata?.entry_count,
    parsed_zip_entry_count: zipEntryCount,
    image_count: packageResult.package?.metadata?.image_count,
    source_pdf_checksum_sha256: packageResult.package?.metadata?.source_pdf_checksum_sha256,
    source_xml_checksum_sha256: packageResult.package?.metadata?.source_xml_checksum_sha256,
  };
  evidence.checks.delivery_manifest_verified = manifest.manifest_version === "1.0"
    && manifest.revision_number === Number(finalPdf.revision_number)
    && manifest.input_digest_sha256 === finalPdf.metadata?.input_digest_sha256
    && manifest.image_count === requiredAssets.length
    && Array.isArray(manifest.images)
    && manifest.images.length === requiredAssets.length;
  evidence.checks.delivery_zip_verified = packageBody.readUInt32LE(0) === 0x04034b50
    && packageResult.package?.generation_status === "ready"
    && Number(packageResult.package?.metadata?.image_count || 0) === requiredAssets.length
    && Number(packageResult.package?.metadata?.entry_count || 0) === requiredAssets.length + 2
    && zipEntryCount === requiredAssets.length + 2
    && packageResult.package?.metadata?.source_pdf_checksum_sha256 === finalPdf.checksum_sha256
    && packageResult.package?.metadata?.source_xml_checksum_sha256 === finalXml.checksum_sha256;

  await page.screenshot({ fullPage: true, path: path.join(outputDirectory, "signed-delivery-workfile.png") });
  evidence.browser.page_errors = evidence.browser.page_errors.slice(0, 20);
  evidence.browser.console_errors = evidence.browser.console_errors.slice(0, 20);
  evidence.api.failures = evidence.api.failures.slice(0, 30);
  evidence.checks.no_browser_errors = evidence.browser.page_errors.length === 0;
  evidence.checks.no_api_failures = evidence.api.failure_count === 0;
  evidence.ok = Object.entries(evidence.checks).every(([key, value]) => (
    key === "sales_comparable_count" ? Number(value) >= 3 : value === true
  ));
} catch (error) {
  evidence.error = sanitizeBrowserDiagnostic(error?.message || error);
  if (page) {
    await page.screenshot({ fullPage: true, path: path.join(outputDirectory, "browser-failure.png") }).catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {});
  await fs.writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) process.exitCode = 1;
