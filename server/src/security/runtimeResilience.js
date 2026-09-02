import http from "node:http";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

export function createRuntimeResilienceConfiguration(environment = process.env) {
  const requestTimeoutMs = boundedInteger(
    environment.HTTP_REQUEST_TIMEOUT_MS,
    30_000,
    5_000,
    300_000,
  );
  const headersTimeoutMs = Math.min(
    requestTimeoutMs,
    boundedInteger(environment.HTTP_HEADERS_TIMEOUT_MS, 15_000, 5_000, 60_000),
  );
  const statementTimeoutMs = boundedInteger(
    environment.DATABASE_STATEMENT_TIMEOUT_MS,
    120_000,
    5_000,
    900_000,
  );
  const queryTimeoutMs = Math.max(
    statementTimeoutMs,
    boundedInteger(environment.DATABASE_QUERY_TIMEOUT_MS, 125_000, 5_000, 905_000),
  );

  return Object.freeze({
    http: Object.freeze({
      requestTimeoutMs,
      headersTimeoutMs,
      keepAliveTimeoutMs: boundedInteger(
        environment.HTTP_KEEP_ALIVE_TIMEOUT_MS,
        5_000,
        1_000,
        60_000,
      ),
      connectionsCheckingIntervalMs: boundedInteger(
        environment.HTTP_CONNECTIONS_CHECK_INTERVAL_MS,
        1_000,
        250,
        30_000,
      ),
      maxHeadersCount: boundedInteger(environment.HTTP_MAX_HEADERS_COUNT, 100, 20, 1_000),
      maxRequestsPerSocket: boundedInteger(
        environment.HTTP_MAX_REQUESTS_PER_SOCKET,
        500,
        10,
        10_000,
      ),
    }),
    database: Object.freeze({
      max: boundedInteger(environment.DATABASE_POOL_SIZE, 10, 1, 50),
      connectionTimeoutMillis: boundedInteger(
        environment.DATABASE_CONNECTION_TIMEOUT_MS,
        10_000,
        1_000,
        60_000,
      ),
      idleTimeoutMillis: boundedInteger(
        environment.DATABASE_IDLE_TIMEOUT_MS,
        30_000,
        1_000,
        600_000,
      ),
      statement_timeout: statementTimeoutMs,
      query_timeout: queryTimeoutMs,
      idle_in_transaction_session_timeout: boundedInteger(
        environment.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
        60_000,
        5_000,
        900_000,
      ),
    }),
    shutdownGraceMs: boundedInteger(
      environment.SHUTDOWN_GRACE_MS,
      25_000,
      5_000,
      120_000,
    ),
  });
}

export function createResilientHttpServer(
  requestListener,
  configuration,
  { httpModule = http } = {},
) {
  if (typeof requestListener !== "function") throw new Error("http_request_listener_required");
  const options = configuration?.http;
  if (!options) throw new Error("http_resilience_configuration_required");

  const server = httpModule.createServer({
    requestTimeout: options.requestTimeoutMs,
    headersTimeout: options.headersTimeoutMs,
    keepAliveTimeout: options.keepAliveTimeoutMs,
    connectionsCheckingInterval: options.connectionsCheckingIntervalMs,
  }, requestListener);
  // Set these explicitly as well as through createServer so the behavior is
  // visible to operations and remains stable across supported Node releases.
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = options.headersTimeoutMs;
  server.keepAliveTimeout = options.keepAliveTimeoutMs;
  server.maxHeadersCount = options.maxHeadersCount;
  server.maxRequestsPerSocket = options.maxRequestsPerSocket;
  return server;
}

export function installGracefulShutdown({
  server,
  pool,
  graceMs,
  processTarget = process,
  logger = console,
  onBegin = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  if (!server?.close || !pool?.end) throw new Error("shutdown_dependencies_required");
  let shuttingDown = false;
  let forced = false;
  let poolClosePromise = null;
  let forceTimer = null;
  let fatalReported = false;

  const closePool = () => {
    poolClosePromise ||= Promise.resolve().then(() => pool.end());
    return poolClosePromise;
  };
  const begin = (signal = "shutdown") => {
    if (shuttingDown) return false;
    shuttingDown = true;
    logger.info?.(`[shutdown] ${signal} received; draining connections`);
    try {
      onBegin?.(signal);
    } catch (error) {
      processTarget.exitCode = 1;
      logger.error?.("[shutdown] shutdown hook failed", error?.message || error);
    }
    server.close((error) => {
      if (forceTimer) clearTimeoutImpl(forceTimer);
      closePool()
        .catch(() => { processTarget.exitCode = 1; })
        .finally(() => {
          if (error || forced) processTarget.exitCode = 1;
        });
    });
    server.closeIdleConnections?.();
    forceTimer = setTimeoutImpl(() => {
      forced = true;
      processTarget.exitCode = 1;
      logger.error?.("[shutdown] drain deadline exceeded; closing remaining connections");
      server.closeAllConnections?.();
      void closePool().catch(() => undefined);
    }, graceMs);
    forceTimer.unref?.();
    return true;
  };
  const onSigterm = () => begin("SIGTERM");
  const onSigint = () => begin("SIGINT");
  const beginFatalShutdown = (code) => {
    if (fatalReported) return;
    fatalReported = true;
    processTarget.exitCode = 1;
    logger.error?.(`[fatal] ${code}`);
    begin(code);
  };
  const onUncaughtException = () => beginFatalShutdown("uncaught_exception");
  const onUnhandledRejection = () => beginFatalShutdown("unhandled_rejection");
  processTarget.once("SIGTERM", onSigterm);
  processTarget.once("SIGINT", onSigint);
  processTarget.once("uncaughtException", onUncaughtException);
  processTarget.once("unhandledRejection", onUnhandledRejection);

  return Object.freeze({
    begin,
    isShuttingDown: () => shuttingDown,
    dispose() {
      processTarget.removeListener("SIGTERM", onSigterm);
      processTarget.removeListener("SIGINT", onSigint);
      processTarget.removeListener("uncaughtException", onUncaughtException);
      processTarget.removeListener("unhandledRejection", onUnhandledRejection);
      if (forceTimer) clearTimeoutImpl(forceTimer);
    },
  });
}
