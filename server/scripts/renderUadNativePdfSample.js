import fs from "node:fs/promises";
import path from "node:path";

import { renderUadNativePdf } from "../src/modules/uad/uadPdf.js";
import {
  uadNativePdfEditorFixture,
  uadNativePdfSignerFixture,
} from "../test/fixtures/uadNativePdfFixture.js";

const outputPath = path.resolve(
  process.argv[2] || path.join("tmp", "pdfs", "uad-native-report-sample.pdf"),
);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const rendered = await renderUadNativePdf(uadNativePdfEditorFixture(), {
  signers: [uadNativePdfSignerFixture()],
});
await fs.writeFile(outputPath, rendered.content);
console.log(JSON.stringify({
  output_path: outputPath,
  page_count: rendered.page_count,
  byte_size: rendered.byte_size,
  checksum_sha256: rendered.checksum_sha256,
}));
