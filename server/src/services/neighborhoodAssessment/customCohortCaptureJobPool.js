/** Pool settings for the bounded maintenance worker. URL query options are
 * parsed and stripped before pg can override TLS or the checkout bounds.
 * Only loopback development databases may use plaintext. Remote certificates
 * must validate against the runtime trust store; there is no insecure fallback.
 */
export function customCohortCaptureJobPoolOptions(databaseUrl) {
  const invalid = () => { throw new TypeError('custom_cohort_job_database_configuration_invalid'); };
  if (typeof databaseUrl !== 'string' || !databaseUrl || databaseUrl.length > 16_384) invalid();
  let url;
  try { url = new URL(databaseUrl); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) invalid();
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'ssl'].includes(key) || url.searchParams.getAll(key).length !== 1) invalid();
  }
  const mode = url.searchParams.get('sslmode'), ssl = url.searchParams.get('ssl');
  if (mode !== null && !['disable', 'require', 'verify-full'].includes(mode)) invalid();
  if (ssl !== null && !['true', 'false', '1', '0'].includes(ssl)) invalid();
  const disabled = mode === 'disable' || ssl === 'false' || ssl === '0';
  const required = mode === 'require' || mode === 'verify-full' || ssl === 'true' || ssl === '1';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((disabled && required) || (disabled && !loopback)) invalid();
  url.searchParams.delete('sslmode'); url.searchParams.delete('ssl');
  return {
    connectionString: url.href,
    ssl: !loopback || required ? { rejectUnauthorized: true } : false,
    max: 3, connectionTimeoutMillis: 5_000,
    application_name: 'homenode-custom-cohort-capture-jobs',
  };
}
