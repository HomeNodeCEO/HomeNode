import { fetchWithApplicationAuthentication, makeUrl } from '@/lib/api';
import { createSfrepTransport } from './sfrepTransport';

export const sfrepApi = createSfrepTransport({ request: fetchWithApplicationAuthentication, urlFor: makeUrl });
