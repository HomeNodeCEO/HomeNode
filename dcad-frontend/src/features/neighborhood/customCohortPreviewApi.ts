import { fetchWithApplicationAuthentication, makeUrl } from '@/lib/api';
import { createCustomCohortPreviewTransport } from './customCohortPreviewTransport';

// Keep the established session/token transport and API URL configuration. Do not
// use fetchJSON: its own AbortController would replace the preview owner's signal.
export const requestCustomCohortObservationPreview = createCustomCohortPreviewTransport({
  request: fetchWithApplicationAuthentication,
  urlFor: makeUrl,
});
