import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateXML } from "xmllint-wasm";

const [samplePath, schemaDirectory] = process.argv.slice(2);
if (!samplePath || !schemaDirectory) {
  throw new Error("Usage: node scripts/verifyOfficialUadSample.js <sample.xml> <combined-schema-directory>");
}

const files = {
  xml: resolve(samplePath),
  schema: resolve(schemaDirectory, "GSE_UAD_3.6.0_v1.3.xsd"),
  xlink: resolve(schemaDirectory, "GSE_UAD_3.6.0_xlink_v1.3.xsd"),
  xmlNamespace: resolve(schemaDirectory, "xml.xsd"),
};
const [xml, schema, xlink, xmlNamespace] = await Promise.all([
  readFile(files.xml, "utf8"),
  readFile(files.schema, "utf8"),
  readFile(files.xlink, "utf8"),
  readFile(files.xmlNamespace, "utf8"),
]);
const result = await validateXML({
  xml: [{ fileName: "official-sample.xml", contents: xml }],
  schema: [{ fileName: "GSE_UAD_3.6.0_v1.3.xsd", contents: schema }],
  preload: [
    { fileName: "GSE_UAD_3.6.0_xlink_v1.3.xsd", contents: xlink },
    { fileName: "xml.xsd", contents: xmlNamespace },
  ],
  initialMemoryPages: 512,
  maxMemoryPages: 4096,
});

console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 1;
