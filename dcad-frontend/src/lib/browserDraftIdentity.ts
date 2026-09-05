export type BrowserDraftSession = {
  user_id: string;
  organizations: ReadonlyArray<{ organization_id: string }>;
};

export function browserDraftIdentityKey(
  session?: BrowserDraftSession | null,
): string | null {
  const userId = session?.user_id?.trim().toLowerCase() || '';
  const organizationIds = [...new Set(
    (session?.organizations || [])
      .map((organization) => organization.organization_id.trim().toLowerCase())
      .filter(Boolean),
  )].sort();
  if (!userId || organizationIds.length === 0) return null;
  return `${encodeURIComponent(userId)}:${organizationIds.map(encodeURIComponent).join(',')}`;
}
