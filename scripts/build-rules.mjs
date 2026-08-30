// build-rules.mjs — rules/poisoning.json → rules/poisoning.mjs (committed).
// Any JS smuggled in a "JSON" PR dies here: JSON.parse accepts no code.
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("../rules/poisoning.json", import.meta.url), "utf8");
const data = JSON.parse(src);
writeFileSync(new URL("../rules/poisoning.mjs", import.meta.url),
  "// GENERATED from rules/poisoning.json — DO NOT EDIT. Run: npm run build:rules\n" +
  "export default " + JSON.stringify(data, null, 2) + ";\n");
console.log(`rules/poisoning.mjs generated (v${data.version}, ${data.rules.length} rules)`);
