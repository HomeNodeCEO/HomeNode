import {
  runApplicationAuthPublicPreflight,
  runApplicationAuthStagingMatrix,
} from "../src/security/applicationAuthStagingMatrix.js";

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((item) => item.startsWith(prefix))?.slice(prefix.length) || null;
}

const publicOnly = process.argv.includes("--public-only");

function environment(name) {
  return String(process.env[name] || "").trim() || null;
}

async function main() {
  const baseUrl = option("base-url") || environment("APPLICATION_AUTH_STAGING_BASE_URL");
  const timeoutMs = option("timeout-ms") || environment("APPLICATION_AUTH_STAGING_TIMEOUT_MS");
  const result = publicOnly
    ? await runApplicationAuthPublicPreflight({ baseUrl, timeoutMs })
    : await runApplicationAuthStagingMatrix({
      baseUrl,
      timeoutMs,
      organizationAId: environment("APPLICATION_AUTH_STAGING_ORG_A_ID"),
      organizationBId: environment("APPLICATION_AUTH_STAGING_ORG_B_ID"),
      organizationAToken: environment("APPLICATION_AUTH_STAGING_ORG_A_TOKEN"),
      organizationBToken: environment("APPLICATION_AUTH_STAGING_ORG_B_TOKEN"),
      accountId: environment("APPLICATION_AUTH_STAGING_ACCOUNT_ID"),
      customAssignmentFileId: environment("APPLICATION_AUTH_STAGING_CUSTOM_ASSIGNMENT_FILE_ID"),
      uadWorkfileId: environment("APPLICATION_AUTH_STAGING_UAD_WORKFILE_ID"),
      propertyTaxFileId: environment("APPLICATION_AUTH_STAGING_PROPERTY_TAX_FILE_ID"),
    });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const code = /^[a-z0-9_:-]{1,100}$/i.test(String(error?.code || error?.message || ""))
    ? String(error.code || error.message)
    : "application_auth_staging_matrix_failed";
  console.error(JSON.stringify({
    ok: false,
    mode: publicOnly ? "public_preflight" : "two_organization_matrix",
    error: code,
  }, null, 2));
  process.exitCode = 1;
}
