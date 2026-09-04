type TelemetryEnvironment = {
  VITE_API_URL?: string;
  VITE_API_BASE?: string;
};

type ReportOptions = {
  fetchImpl?: typeof fetch;
  pathname?: string;
};

const moduleEnvironment = (import.meta as ImportMeta & { env?: TelemetryEnvironment }).env || {};
const API_BASE = String(
  moduleEnvironment.VITE_API_URL || moduleEnvironment.VITE_API_BASE || '',
).replace(/\/+$/, '');

const routeRules: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/$/, 'property_search'],
  [/^\/property\/[^/]+(?:\/[^/]+)?\/?$/, 'property_details'],
  [/^\/report\/[^/]+\/?$/, 'property_report'],
  [/^\/ComparableSalesAnalysis\/?$/, 'comparable_sales_analysis'],
  [/^\/AppraisalReport\/?$/, 'appraisal_report'],
  [/^\/CostApproach\/?$/, 'cost_approach'],
  [/^\/IncomeApproach\/?$/, 'income_approach'],
  [/^\/FinalReconciliation\/?$/, 'final_reconciliation'],
  [/^\/PropertyTaxProtest\/?$/, 'property_tax_protest'],
  [/^\/uad-3\.6\/[^/]+\/?$/, 'uad_workspace'],
  [/^\/signup\/?$/, 'signup'],
];

const errorTypes: Readonly<Record<string, string>> = {
  AggregateError: 'aggregate_error',
  Error: 'generic_error',
  RangeError: 'range_error',
  ReferenceError: 'reference_error',
  SyntaxError: 'syntax_error',
  TypeError: 'type_error',
  URIError: 'uri_error',
};

export function applicationRouteCode(pathname: string): string {
  const path = String(pathname || '/').split(/[?#]/, 1)[0];
  return routeRules.find(([pattern]) => pattern.test(path))?.[1] || 'unknown';
}

export function applicationErrorType(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'ChunkLoadError'
        || /dynamically imported module|loading (?:css )?chunk/i.test(error.message)) {
      return 'chunk_load_error';
    }
    return errorTypes[error.name] || 'generic_error';
  }
  return 'generic_error';
}

export async function reportApplicationRenderFailure(
  error: unknown,
  {
    fetchImpl = globalThis.fetch,
    pathname = globalThis.location?.pathname || '/',
  }: ReportOptions = {},
): Promise<boolean> {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(`${API_BASE}/api/system/client-errors`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3_000) : undefined,
      body: JSON.stringify({
        source: 'root_error_boundary',
        route_code: applicationRouteCode(pathname),
        error_type: applicationErrorType(error),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
