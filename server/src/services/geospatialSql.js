export function greatCircleDistanceMilesSql({
  subjectLatitude,
  subjectLongitude,
  comparableLatitude,
  comparableLongitude,
}) {
  return `3958.7613 * ACOS(
    LEAST(1, GREATEST(-1,
      COS(RADIANS(${subjectLatitude})) *
      COS(RADIANS(${comparableLatitude})) *
      COS(RADIANS(${comparableLongitude}) - RADIANS(${subjectLongitude})) +
      SIN(RADIANS(${subjectLatitude})) *
      SIN(RADIANS(${comparableLatitude}))
    ))
  )`;
}
