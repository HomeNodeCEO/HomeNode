import express from 'express';
import { environmentFlag } from '../util/requestPerformance.js';
import { createCustomNeighborhoodSourcePolicy } from '../security/customNeighborhoodSourcePolicy.js';
import { createCustomNeighborhoodWitness2SourcePolicy } from '../security/customNeighborhoodWitness2SourcePolicy.js';
import { authorizeCustomNeighborhoodPrivateSales } from '../security/customNeighborhoodPrivateSalesPolicy.js';
import { authorizeCustomNeighborhoodReportObservations } from '../security/customNeighborhoodReportObservationPolicy.js';
import { jsonErrorHandler } from '../security/httpSecurity.js';
import { createCustomCohortContextCapture } from '../services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomNeighborhoodSubjectEvidenceRecovery } from '../services/neighborhoodAssessment/customSubjectEvidenceRecovery.js';
import { createCustomNeighborhoodCohortRouter } from '../modules/accounts/customNeighborhoodCohortRouter.js';

export const CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_MAX_BYTES = 16_384;
const BASE = '/api/accounts/:id/neighborhood-cohort';

function invalidConfiguration() {
  return Object.assign(new TypeError('custom_neighborhood_configuration_invalid'), {
    code: 'CUSTOM_NEIGHBORHOOD_CONFIGURATION_INVALID',
  });
}

function sourceMode(value) {
  if (value === undefined) return 'cad4';
  if (value !== 'cad4' && value !== 'combined-witness2-v1') throw invalidConfiguration();
  return value;
}

/** Parse before creating application resources. These independently supplied
 * source revisions identify the approved source mix; they do not grant rights.
 * Both fixed policy constructors validate the closed profile grammar. */
export function createCustomNeighborhoodConfiguration(environment = process.env) {
  try {
    if (!environmentFlag(environment.CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED)) {
      // An unused profile must not prevent an explicitly disabled deployment.
      return Object.freeze({ enabled: false, sourceProfile: null });
    }
    const mode = environment.CUSTOM_NEIGHBORHOOD_SOURCE_MODE;
    sourceMode(mode);
    const encoded = environment.CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON;
    if (typeof encoded !== 'string' || !encoded.trim()
      || Buffer.byteLength(encoded, 'utf8') > CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_MAX_BYTES) {
      throw invalidConfiguration();
    }
    const sourceProfile = JSON.parse(encoded);
    createCustomNeighborhoodSourcePolicy(sourceProfile);
    createCustomNeighborhoodWitness2SourcePolicy(sourceProfile);
    sourceProfile.providerRevisions.forEach(Object.freeze);
    Object.freeze(sourceProfile.providerRevisions);
    return Object.freeze({ enabled: true, sourceProfile: Object.freeze(sourceProfile),
      ...(mode === undefined ? {} : { sourceMode: mode }) });
  } catch {
    // Never attach parser input, provider identifiers, driver errors or causes.
    throw invalidConfiguration();
  }
}

/** Mount once AFTER the existing application boundary and workfile routes.
 * No authentication, CSRF, global parser or limiter replacement.
 * Disabled mode creates no coordinator/policy and never touches the cohort pool.
 */
export function createCustomNeighborhoodApplicationRouter({ pool, configuration } = {}) {
  if (typeof configuration?.enabled !== 'boolean'
    || (configuration.enabled === false && configuration.sourceProfile !== null)) throw invalidConfiguration();
  const enabled = configuration.enabled;
  let cohortService;
  if (enabled) {
    let authorizeMarketData, mode;
    try {
      mode = sourceMode(configuration.sourceMode);
      const encoded = JSON.stringify(configuration.sourceProfile);
      if (typeof encoded !== 'string'
        || Buffer.byteLength(encoded, 'utf8') > CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_MAX_BYTES) throw invalidConfiguration();
      const legacy = createCustomNeighborhoodSourcePolicy(configuration.sourceProfile);
      const witness2 = createCustomNeighborhoodWitness2SourcePolicy(configuration.sourceProfile);
      // Replay chooses source rights from its original purpose, never from the
      // mode for NEW captures. Any projection is exclusively the fixed witness2
      // evaluator's responsibility; malformed/older projections cannot fall
      // back to the narrower legacy grant.
      authorizeMarketData = (client, auth, context, purpose, requested) =>
        (Object.hasOwn(purpose ?? {}, 'source_projection') ? witness2 : legacy)(client, auth, context, purpose, requested);
    } catch { throw invalidConfiguration(); }
    // The absent mode preserves the installed CAD4 producer. This switch does
    // not install source grants or change how existing retained purposes route.
    cohortService = createCustomCohortContextCapture({ pool, authorizeMarketData, sourceMode: mode,
      authorizePrivateSales: authorizeCustomNeighborhoodPrivateSales,
      authorizeReportedObservations: authorizeCustomNeighborhoodReportObservations });
    cohortService = createCustomNeighborhoodSubjectEvidenceRecovery({ pool, cohortService });
  }
  const router = express.Router();
  // Global JSON errors precede authentication by existing application design.
  // Preserve their existing status/body (including unsupported encodings),
  // rather than letting the route-local parser reinterpret an upstream error.
  router.use(BASE, jsonErrorHandler);
  router.use(BASE, (req, res, next) => {
    res.set('cache-control', 'no-store');
    if (typeof req.mobileAuth?.userId !== 'string' || !req.mobileAuth.userId.trim()) {
      return res.status(401).json({ error: 'authentication_required' });
    }
    if (!enabled) {
      return res.status(503).json({ error: 'custom_neighborhood_workspace_disabled' });
    }
    return next();
  });
  if (cohortService) router.use(createCustomNeighborhoodCohortRouter({ cohortService }));
  return router;
}
