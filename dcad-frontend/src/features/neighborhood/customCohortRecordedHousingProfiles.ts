// Fixed browser admission identities, not source-use permissions. Version 1
// retains the original county vocabulary; version 2 requires the server's
// retained study marker. Producer/checker tests pin every profile hash.
export const RECORDED_HOUSING_PROFILES = {
  1: {
    4: { id: 'custom-recorded-housing-v1', revision: 1,
      content_sha256: '12871b3b6251f507a19b1ac20e45df07ace43f6d10654ee513f314ad830de391' },
    5: { id: 'custom-recorded-housing-v2', revision: 2,
      content_sha256: '636415258d1f8d1e74ab1aac1f5592ea5f3d634153225bd138113a63d993f135' },
  },
  2: {
    4: { id: 'custom-recorded-housing-v3', revision: 3,
      content_sha256: '03857dd5dee53b922f4d4f540c385fb65125ff55300d409af4fe547026fa88dc' },
    5: { id: 'custom-recorded-housing-v4', revision: 4,
      content_sha256: '11db17964e872f315959b71c211f8ad6dc434b092508c32713f3928b061dd6ca' },
  },
} as const;

export type RecordedHousingMapping = {
  [Version in keyof typeof RECORDED_HOUSING_PROFILES]: {
    [Mapping in keyof typeof RECORDED_HOUSING_PROFILES[Version]]: {
      readonly housing_version: Version; readonly mapping_version: Mapping;
      readonly profile: typeof RECORDED_HOUSING_PROFILES[Version][Mapping];
    }
  }[keyof typeof RECORDED_HOUSING_PROFILES[Version]]
}[keyof typeof RECORDED_HOUSING_PROFILES];
