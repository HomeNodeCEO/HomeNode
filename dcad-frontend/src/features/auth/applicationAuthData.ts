type JsonRecord = Record<string, unknown>;

export type Organization = {
  organization_id: string;
  display_name: string | null;
  roles: string[];
  permissions: Record<string, { read: boolean; write: boolean; sign: boolean }>;
};

export type Session = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  organizations: Organization[];
};

export type ReadinessBlocker = {
  code: string;
  count: number;
  group: string;
  organization_id?: string;
};

export type AuthReadiness = {
  checked_at: string;
  activation_ready: boolean;
  blockers: ReadinessBlocker[];
  organizations: Array<{
    organization_id: string;
    legal_name: string | null;
    display_name: string | null;
    active: boolean;
    active_memberships: number;
    mapped_identities: number;
    active_appraiser_profiles: number;
    valid_appraiser_licenses: number;
    custom_assignment_files: number;
    uad_workfiles: number;
    property_tax_files: number;
  }>;
};

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredText(value: unknown): string | null {
  const candidate = text(value)?.trim();
  return candidate || null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function permissionMap(value: unknown): Organization['permissions'] {
  const source = record(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source).flatMap(([workflow, candidate]) => {
      const permission = record(candidate);
      if (!permission) return [];
      return [[workflow, {
        read: permission.read === true,
        write: permission.write === true,
        sign: permission.sign === true,
      }]];
    }),
  );
}

function organization(value: unknown): Organization | null {
  const source = record(value);
  const organizationId = requiredText(source?.organization_id);
  if (!source || !organizationId) return null;
  return {
    organization_id: organizationId,
    display_name: text(source.display_name),
    roles: stringArray(source.roles),
    permissions: permissionMap(source.permissions),
  };
}

export function authStatusFromResponse(value: unknown): {
  configured: boolean;
  required: boolean;
} {
  const source = record(value);
  const configured = source?.configured === true;
  return {
    configured,
    required: configured && source?.required === true,
  };
}

export function sessionFromResponse(value: unknown): Session | null {
  const source = record(record(value)?.session);
  const userId = requiredText(source?.user_id);
  if (!source || !userId) return null;
  const organizations = Array.isArray(source.organizations)
    ? source.organizations.flatMap((candidate) => {
        const normalized = organization(candidate);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    user_id: userId,
    email: text(source.email),
    display_name: text(source.display_name),
    organizations,
  };
}

function blocker(value: unknown): ReadinessBlocker | null {
  const source = record(value);
  const code = requiredText(source?.code);
  const group = requiredText(source?.group);
  if (!source || !code || !group) return null;
  const organizationId = requiredText(source.organization_id);
  return {
    code,
    count: count(source.count),
    group,
    ...(organizationId ? { organization_id: organizationId } : {}),
  };
}

function readinessOrganization(value: unknown): AuthReadiness['organizations'][number] | null {
  const source = record(value);
  const organizationId = requiredText(source?.organization_id);
  if (!source || !organizationId) return null;
  return {
    organization_id: organizationId,
    legal_name: text(source.legal_name),
    display_name: text(source.display_name),
    active: source.active === true,
    active_memberships: count(source.active_memberships),
    mapped_identities: count(source.mapped_identities),
    active_appraiser_profiles: count(source.active_appraiser_profiles),
    valid_appraiser_licenses: count(source.valid_appraiser_licenses),
    custom_assignment_files: count(source.custom_assignment_files),
    uad_workfiles: count(source.uad_workfiles),
    property_tax_files: count(source.property_tax_files),
  };
}

export function readinessFromResponse(value: unknown): AuthReadiness | null {
  const source = record(record(value)?.readiness);
  const checkedAt = requiredText(source?.checked_at);
  if (!source || !checkedAt) return null;
  return {
    checked_at: checkedAt,
    activation_ready: source.activation_ready === true,
    blockers: Array.isArray(source.blockers)
      ? source.blockers.flatMap((candidate) => {
          const normalized = blocker(candidate);
          return normalized ? [normalized] : [];
        })
      : [],
    organizations: Array.isArray(source.organizations)
      ? source.organizations.flatMap((candidate) => {
          const normalized = readinessOrganization(candidate);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}
