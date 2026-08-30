function assignmentId(row) {
  return Number(row.assignment_file_id);
}

export function indexAssignmentFileDetails({
  sectionRows = [],
  mobilePhotoRows = [],
  mobileSketchRows = [],
} = {}) {
  const sectionsByFile = new Map();
  const photosByFile = new Map();
  const sketchesByFile = new Map();

  for (const section of sectionRows) {
    const fileId = assignmentId(section);
    let sections = sectionsByFile.get(fileId);
    if (!sections) {
      sections = {};
      sectionsByFile.set(fileId, sections);
    }
    sections[section.section_key] = {
      value: section.section_value,
      revision: Number(section.revision),
      last_applied_session_id: section.last_applied_session_id,
      updated_at: section.updated_at,
    };
  }

  for (const photo of mobilePhotoRows) {
    const fileId = assignmentId(photo);
    let photos = photosByFile.get(fileId);
    if (!photos) {
      photos = [];
      photosByFile.set(fileId, photos);
    }
    photos.push({
      id: photo.id,
      client_photo_id: photo.client_photo_id || photo.id,
      origin_channel: photo.origin_channel || "mobile",
      category: photo.category,
      room_ref: photo.room_ref,
      room_label: photo.room_label,
      caption: photo.caption,
      position: Number(photo.position),
      captured_at: photo.captured_at || null,
      status: photo.status || "verified",
      revision: Number(photo.revision || 1),
      verified_at: photo.verified_at,
      retention_until: photo.retention_until,
      required_retention_years: Number(photo.required_retention_years),
      view_url: photo.view_url || null,
      view_url_expires_in_seconds: photo.view_url_expires_in_seconds == null
        ? null
        : Number(photo.view_url_expires_in_seconds),
    });
  }

  for (const sketch of mobileSketchRows) {
    const fileId = assignmentId(sketch);
    if (sketchesByFile.has(fileId)) continue;
    sketchesByFile.set(fileId, {
      id: sketch.id,
      revision: Number(sketch.revision),
      document: sketch.document,
      summary: sketch.summary,
      measurement_standard: sketch.measurement_standard,
      measurement_method: sketch.measurement_method,
      review_status: sketch.review_status,
      confirmed_at: sketch.confirmed_at,
      updated_at: sketch.updated_at,
    });
  }

  return { sectionsByFile, photosByFile, sketchesByFile };
}
