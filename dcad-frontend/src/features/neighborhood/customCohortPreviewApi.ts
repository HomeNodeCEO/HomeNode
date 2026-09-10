import { fetchWithApplicationAuthentication, makeUrl } from '@/lib/api';
import { createCustomCohortJsonTransport, createCustomCohortPreviewTransport, createCustomCohortMemberTransport } from './customCohortPreviewTransport';

// Keep the established session/token transport and API URL configuration. Do not
// use fetchJSON: its own AbortController would replace the preview owner's signal.
export const requestCustomCohortObservationPreview = createCustomCohortPreviewTransport({
  request: fetchWithApplicationAuthentication,
  urlFor: makeUrl,
});

export const requestCustomCohortOperation = createCustomCohortJsonTransport({
  request: fetchWithApplicationAuthentication,
  urlFor: makeUrl,
});

export const requestCustomCohortMembers = createCustomCohortMemberTransport({
  request: fetchWithApplicationAuthentication,
  urlFor: makeUrl,
});
