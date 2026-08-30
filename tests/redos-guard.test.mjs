// redos-guard.test.mjs — the ReDoS gate must not false-kill normal regexes
// and must catch all known-bad ones. Three cohorts (spec §4).
import { probePattern } from "./redos-probe.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) pass++; else fail++; console.log(`${c ? "  ✓" : "  ✗"} ${n}${c ? "" : "  ← " + x}`); };

const SAFE = [
  ["zero-width",   "[\\u200B\\u200C\\u200D\\u200E\\u200F\\u180E\\u202A-\\u202E\\u2060-\\u2064\\u3164\\u115F\\uFEFF\\u00AD]", ""],
  ["instruction-pattern", "ignore\\s+(all\\s+)?(previous|prior|above)|disregard\\s+(the\\s+)?(previous|prior|above)|do\\s+not\\s+(tell|inform|reveal)|exfiltrat|send\\s+.{0,40}\\b(?:to|at)\\b\\s+https?:|post\\s+.{0,40}\\bto\\b\\s+https?:", "i"],
  ["name-charset", "[^a-zA-Z0-9._-]", ""],
  ["wildcard-exposure", "\\*|[^\\x20-\\x7E]", ""],
  ["URL",          "^https?://[a-z0-9.-]+\\.[a-z]{2,}(/|$)", "i"],
  ["ISO date",     "\\b\\d{4}-\\d{2}-\\d{2}\\b", ""],
  ["money",        "\\$[0-9]{1,3}(,[0-9]{3})*(\\.[0-9]{2})?", ""],
  ["subdomain",    "^[a-z][a-z0-9-]{2,62}$", "i"],
  ["script tag",   "<(script|iframe)[^>]*>", "i"],
  ["action verbs", "(?:add|remove|update|delete)_[a-z0-9_]+", "i"],
  ["bearer",       "bearer\\s+[a-z0-9._-]{20,}", "i"],
  ["repeated word","\\b(\\w+)\\s+\\1\\b", "i"],
  ["UUID",         "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "i"],
  ["HTML entity",  "&(?:amp|lt|gt|quot|#\\d+);", "i"],
  ["semver",       "^v?\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]+)?$", "i"],
];
const EVIL = [
  ["(a+)+$", "(a+)+$"], ["(a|aa)+$", "(a|aa)+$"],
  ["classic email form", "^(([a-z])+.)+[A-Z]([a-z])+$"],
  ["(a*)*$", "(a*)*$"], ["^(\\s*\\w+)*$", "^(\\s*\\w+)*$"],
  ["^\\s*(\\w+\\s*)*$", "^\\s*(\\w+\\s*)*$"], ["([a-zA-Z]+)*$", "([a-zA-Z]+)*$"],
  ["^(\\d+)*$", "^(\\d+)*$"], ["(x+x+)+y", "(x+x+)+y"],
  ["<(?:[a-zA-Z]+)*>", "<(?:[a-zA-Z]+)*\\s*>"], ["^(a+)+://", "^(a+)+://"],
  ["java classname", "^((\\w+\\.)*\\w+)+$"],
].map(([n, p]) => [n, p, ""]);
const QUADRATIC = [["email (OWASP-known quadratic)", "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", "i"]];

let fp = 0;
for (const [name, p, f] of SAFE) {
  const { rejected } = probePattern(p, f);
  if (rejected) { fp++; console.log(`  ✗ false-kill: ${name} — ${rejected}`); }
}
ok(`cohort A: 0 false kills on ${SAFE.length} normal patterns`, fp === 0, `${fp} killed`);

let missed = [];
for (const [name, p, f] of EVIL) {
  const { rejected } = probePattern(p, f);
  if (!rejected) missed.push(name);
}
ok(`cohort B: all ${EVIL.length} known ReDoS blocked`, missed.length === 0, "missed: " + missed.join(", "));

let quad = 0;
for (const [name, p, f] of QUADRATIC) {
  const { rejected, warn } = probePattern(p, f);
  if (rejected || warn) quad++;
}
ok(`cohort C: industry-known quadratic flagged (true positive)`, quad === QUADRATIC.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
