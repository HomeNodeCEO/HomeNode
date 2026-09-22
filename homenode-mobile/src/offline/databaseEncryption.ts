export type OfflineDatabaseSnapshot = Readonly<{
  autoVacuum: number;
  schema: readonly Readonly<{
    type: string;
    name: string;
    tableName: string;
    sql: string | null;
  }>[];
  sequences: Readonly<Record<string, number>>;
  tableCounts: Readonly<Record<string, number>>;
  userVersion: number;
}>;

export function sqliteStringLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqliteIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("mobile_offline_database_schema_invalid");
  }
  return `"${value}"`;
}

const IOS_MIGRATION_DATABASE_PATTERN = /^(homenode-field-ios-v3-migration-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db)(?:-(?:wal|shm|journal))?$/;

export function staleIosMigrationDatabaseNames(fileNames: string[], activeDatabaseName: string | null) {
  const names = new Set<string>();
  for (const fileName of fileNames) {
    const migration = IOS_MIGRATION_DATABASE_PATTERN.exec(fileName);
    const databaseName = migration?.[1];
    if (databaseName && databaseName !== activeDatabaseName) names.add(databaseName);
  }
  return [...names].sort();
}

export function legacyDatabaseNamesForRemoval(
  selectedDatabaseName: string,
  canonicalDatabaseName: string | null,
) {
  return [...new Set([selectedDatabaseName, canonicalDatabaseName].filter(
    (value): value is string => Boolean(value),
  ))];
}

export function assertDatabaseSnapshotsEqual(
  source: OfflineDatabaseSnapshot,
  destination: OfflineDatabaseSnapshot,
) {
  if (source.autoVacuum !== destination.autoVacuum) {
    throw new Error("mobile_offline_database_migration_verification_failed");
  }
  if (source.userVersion !== destination.userVersion) {
    throw new Error("mobile_offline_database_migration_verification_failed");
  }
  if (JSON.stringify(source.schema) !== JSON.stringify(destination.schema)) {
    throw new Error("mobile_offline_database_migration_verification_failed");
  }
  if (JSON.stringify(source.sequences) !== JSON.stringify(destination.sequences)) {
    throw new Error("mobile_offline_database_migration_verification_failed");
  }
  if (JSON.stringify(source.tableCounts) !== JSON.stringify(destination.tableCounts)) {
    throw new Error("mobile_offline_database_migration_verification_failed");
  }
}
