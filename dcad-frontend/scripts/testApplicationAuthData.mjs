import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  authStatusFromResponse,
  readinessFromResponse,
  sessionFromResponse,
} from '../src/features/auth/applicationAuthData.ts';

test('authentication status requires literal booleans', () => {
  assert.deepEqual(authStatusFromResponse({ configured: true, required: true }), {
    configured: true,
    required: true,
  });
  assert.deepEqual(authStatusFromResponse({ configured: 'true', required: true }), {
    configured: false,
    required: false,
  });
});

test('session normalization contains malformed organizations and permissions', () => {
  const session = sessionFromResponse({ session: {
    user_id: ' user-1 ',
    email: 'appraiser@example.com',
    organizations: [
      null,
      { organization_id: '', roles: ['admin'] },
      {
        organization_id: 'org-1',
        display_name: 'Example Appraisal',
        roles: ['organization_admin', 7],
        permissions: {
          custom_appraisal: { read: true, write: true, sign: false },
          malformed: 'yes',
        },
      },
    ],
  } });

  assert.equal(session?.user_id, 'user-1');
  assert.equal(session?.organizations.length, 1);
  assert.deepEqual(session?.organizations[0].roles, ['organization_admin']);
  assert.deepEqual(session?.organizations[0].permissions.custom_appraisal, {
    read: true,
    write: true,
    sign: false,
  });
  assert.equal(session?.organizations[0].permissions.malformed, undefined);
  assert.equal(sessionFromResponse({ session: { organizations: [] } }), null);
});

test('readiness normalization preserves bounded audit counts', () => {
  const readiness = readinessFromResponse({ readiness: {
    checked_at: '2026-09-02T12:00:00Z',
    activation_ready: true,
    blockers: [
      { code: 'missing_owner', group: 'ownership', count: 2, organization_id: 'org-1' },
      { code: {}, group: 'invalid' },
    ],
    organizations: [{
      organization_id: 'org-1',
      active: true,
      active_memberships: 4,
      mapped_identities: -1,
    }],
  } });
  assert.equal(readiness?.activation_ready, true);
  assert.equal(readiness?.blockers.length, 1);
  assert.equal(readiness?.organizations[0].active_memberships, 4);
  assert.equal(readiness?.organizations[0].mapped_identities, 0);
  assert.equal(readinessFromResponse({ readiness: { activation_ready: true } }), null);
});

test('the application authentication provider uses checked response boundaries', async () => {
  const source = await readFile(
    new URL('../src/features/auth/ApplicationAuth.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /authStatusFromResponse/);
  assert.match(source, /sessionFromResponse/);
  assert.match(source, /readinessFromResponse/);
  assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/);
});
