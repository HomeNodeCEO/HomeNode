import {
  createResilientHttpServer,
  installGracefulShutdown,
} from "../security/runtimeResilience.js";

export function resolveApplicationPort(environment = process.env) {
  return parseInt(environment.PORT || "4000", 10);
}

export function startApplicationHttpLifecycle({
  app,
  pool,
  runtimeResilience,
  finalErrorHandler,
  artifactRecoveryMonitor,
  closeArtifactExecution,
  requestPerformance,
  environment = process.env,
  logger = console,
  createHttpServer = createResilientHttpServer,
  installShutdown = installGracefulShutdown,
} = {}) {
  if (!app || typeof app.use !== "function") {
    throw new TypeError("application_http_app_required");
  }
  if (!pool || typeof pool.end !== "function") {
    throw new TypeError("application_http_pool_required");
  }
  if (!runtimeResilience?.http || !Number.isInteger(runtimeResilience.shutdownGraceMs)) {
    throw new TypeError("application_http_resilience_required");
  }
  if (typeof finalErrorHandler !== "function") {
    throw new TypeError("application_http_error_handler_required");
  }
  if (!artifactRecoveryMonitor || typeof artifactRecoveryMonitor.dispose !== "function") {
    throw new TypeError("application_artifact_recovery_monitor_required");
  }
  if (typeof closeArtifactExecution !== "function") {
    throw new TypeError("application_artifact_execution_closer_required");
  }
  if (!requestPerformance || typeof requestPerformance.dispose !== "function") {
    throw new TypeError("application_request_performance_monitor_required");
  }

  const port = resolveApplicationPort(environment);
  app.use(finalErrorHandler);
  const server = createHttpServer(app, runtimeResilience);
  server.listen(port, () => logger.log?.(`API listening on http://localhost:${port}`));
  const gracefulShutdown = installShutdown({
    server,
    pool,
    graceMs: runtimeResilience.shutdownGraceMs,
    logger,
    onBegin: () => {
      requestPerformance.dispose();
      artifactRecoveryMonitor.dispose();
      closeArtifactExecution();
    },
  });

  return Object.freeze({
    port,
    server,
    gracefulShutdown,
  });
}
