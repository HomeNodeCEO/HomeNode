// Portable synthetic contract replay. No services, credentials, network or writes.
import { buildNeighborhoodAssessment, buildNeighborhoodAttachment } from "../src/services/neighborhoodAssessment/contract.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "../test/fixtures/neighborhoodAssessmentFixture.js";

const input = neighborhoodAssessmentFixture();
const assessment = buildNeighborhoodAssessment(input);
process.stdout.write(`${JSON.stringify({
  fixture_version: 1,
  assessment_input: input,
  assessment,
  custom_attachment: buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture("custom_appraisal")),
  uad_only_attachment: buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture()),
}, null, 2)}\n`);
