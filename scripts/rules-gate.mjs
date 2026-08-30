// rules-gate.mjs — the mechanical gates a community rule PR must pass before
// a human ever looks at it (spec §4). Deliberately does NOT import worker.js:
// the gate must validate rules independently, so a worker.js bug can't hide
// a rules bug. Fail-closed on any violation.
//
// Usage: node scripts/rules-gate.mjs [--rules <path>]  (default: rules/poisoning.json)

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { probePattern } from "../tests/redos-probe.mjs";

const args = process.argv.slice(2);
const rulesPath = args.includes("--rules") ? args[args.indexOf("--rules") + 1] : "rules/poisoning.json";
const samplesPath = new URL("../tests/rules-samples.json", import.meta.url);

let failures = 0;
const bad = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const good = (msg) => console.log(`  ✓ ${msg}`);

/* ── Load ─────────────────────────────────────────────────────────────── */
let ruleset;
try {
  ruleset = JSON.parse(readFileSync(rulesPath, "utf8")); // JSON.parse accepts no code
} catch (e) {
  console.log(`✗ ${rulesPath} is not parseable JSON: ${e.message}`);
  process.exit(1);
}
const { benign, malicious } = JSON.parse(readFileSync(samplesPath, "utf8"));
const X600 = "x".repeat(600); // runtime expansion of the "__X600__" sample placeholder

/* ── Gate 1: JSON schema ──────────────────────────────────────────────── */
const ALLOWED_FIELDS = new Set(["id", "severity", "type", "pattern", "flags", "executor", "limit", "applies", "source", "added", "note"]);
const ALLOWED_TYPES = new Set(["regex", "length-over", "executor"]);
const ALLOWED_APPLIES = new Set(["name", "description", "raw", "exposedTo"]);

console.log("[Gate 1] JSON schema");
if (typeof ruleset.version !== "string" || !/^\d+\.\d+\.\d+$/.test(ruleset.version))
  bad(`ruleset.version must be semver, got "${ruleset.version}"`);
if (!Array.isArray(ruleset.rules)) { console.log("✗ ruleset.rules must be an array"); process.exit(1); }

const ids = new Set();
for (const [i, r] of ruleset.rules.entries()) {
  const at = `rules[${i}]${r && r.id ? ` (${r.id})` : ""}`;
  if (!r || typeof r !== "object") { bad(`${at} is not an object`); continue; }
  for (const k of Object.keys(r)) if (!ALLOWED_FIELDS.has(k)) bad(`${at} unknown field "${k}"`);
  if (typeof r.id !== "string" || !/^[a-z0-9-]{3,40}$/.test(r.id)) bad(`${at} bad id (kebab-case, 3-40 chars)`);
  if (ids.has(r.id)) bad(`${at} duplicate id`); ids.add(r.id);
  if (!Number.isInteger(r.severity) || r.severity < 1 || r.severity > 3) bad(`${at} severity must be 1..3`);
  if (!ALLOWED_TYPES.has(r.type)) { bad(`${at} type "${r.type}" not in whitelist`); continue; }
  if (!Array.isArray(r.applies) || !r.applies.length || !r.applies.every(a => ALLOWED_APPLIES.has(a)))
    bad(`${at} applies must be a non-empty subset of name/description/raw/exposedTo`);
  if (r.type === "regex" && (typeof r.pattern !== "string" || !r.pattern)) bad(`${at} regex missing pattern`);
  if (r.type === "length-over" && !Number.isInteger(r.limit)) bad(`${at} length-over missing integer limit`);
  if (r.type === "executor" && typeof r.executor !== "string") bad(`${at} executor missing name`);
}
failures === 0 ? good("schema clean") : console.log(`  (schema: ${failures} error(s))`);

/* ── Gate 2: compile-time whitelist (mirrors worker.js compileRules) ──── */
console.log("[Gate 2] compile whitelist");
const ALLOWED_FLAGS = /^[iu]*$/;
const EXECUTORS = Object.create(null);
EXECUTORS.decodeFindings = (text) => {
  const INSTRUCTION_RE = /ignore\s+(all\s+)?(previous|prior|above)|disregard\s+(the\s+)?(previous|prior|above)|do\s+not\s+(tell|inform|reveal)|exfiltrat/i;
  for (const b64 of text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) || []) {
    try { if (INSTRUCTION_RE.test(atob(b64.replace(/=+$/, "") + "===".slice((b64.length + 3) % 4)))) return true; } catch (_) {}
  }
  for (const hex of text.match(/[0-9a-fA-F]{16,}/g) || []) {
    try {
      if (hex.length % 2) continue;
      let d = ""; for (let i = 0; i < hex.length; i += 2) d += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      if (INSTRUCTION_RE.test(d)) return true;
    } catch (_) {}
  }
  return false;
};
const ALLOWED_EXECUTORS = new Set(["decodeFindings"]);
const REDOS_HINTS = [
  { name: "nested quantifier (x+)+", re: /\([^)]*[+*][^)]*\)\s*[+*]/ },
  { name: "adjacent quantifiers a+*", re: /[+*]\s*[+*]/ },
  { name: "repeated group (x{n,})+", re: /\([^)]*\{[^}]*,[^}]*\}[^)]*\)\s*[+*]/ },
  { name: "alternation branch (a|aa)+", re: /\([^)]*\|[^)]*\)\s*[+*]/ },
];

const compiled = [];
for (const r of ruleset.rules) {
  if (!r || typeof r !== "object") continue;
  if (r.type === "regex") {
    const flags = r.flags || "";
    if (!ALLOWED_FLAGS.test(flags)) { bad(`${r.id}: flags "${flags}" not allowed (i/u only)`); continue; }
    const hints = REDOS_HINTS.filter(h => h.re.test(r.pattern)).map(h => h.name);
    if (hints.length) { bad(`${r.id}: static ReDoS hint (${hints.join("; ")})`); continue; }
    try { compiled.push({ ...r, re: new RegExp(r.pattern, flags) }); }
    catch (e) { bad(`${r.id}: pattern does not compile (${e.message})`); }
  } else if (r.type === "executor") {
    if (!ALLOWED_EXECUTORS.has(r.executor) || typeof EXECUTORS[r.executor] !== "function")
      bad(`${r.id}: executor "${r.executor}" not whitelisted`);
    else compiled.push({ ...r, fn: EXECUTORS[r.executor] });
  } else compiled.push({ ...r });
}
if (failures === 0) good("all rules compile through the whitelist");

/* ── Gate 3: dynamic ReDoS probe (empirical timing, spec §4) ──────────── */
console.log("[Gate 3] dynamic ReDoS probe");
for (const r of compiled) {
  if (r.type !== "regex") continue;
  const { rejected } = probePattern(r.pattern, r.flags || "");
  if (rejected) bad(`${r.id}: ${rejected}`);
}
if (failures === 0) good("no super-linear behavior above budget");

/* ── Gate 4: differential samples (semgrep TP/TN mandate) ─────────────── */
console.log("[Gate 4] differential samples");
const evaluate = (rule, tool) => {
  for (const field of rule.applies) {
    let v = tool[field];
    if (typeof v !== "string" || !v.length) continue;
    if (v === "__X600__") v = X600;
    let hit = false;
    if (rule.type === "regex") hit = rule.re.test(v);
    else if (rule.type === "length-over") hit = v.length > rule.limit;
    else if (rule.type === "executor") hit = rule.fn(v) === true;
    if (hit) return true;
  }
  return false;
};

for (const r of compiled) {
  const tp = malicious[r.id] || [];
  if (!tp.length) bad(`${r.id}: no true-positive samples declared (a rule must prove what it catches)`);
  for (const [i, tool] of tp.entries()) {
    if (!evaluate(r, tool)) bad(`${r.id}: missed malicious sample #${i + 1}`);
  }
}
for (const r of compiled) {
  for (const [i, tool] of benign.entries()) {
    if (evaluate(r, tool)) bad(`${r.id}: FALSE POSITIVE on benign sample #${i + 1} (${tool.name})`);
  }
}
if (failures === 0) good(`differential clean (${benign.length} benign zero-hit, all malicious samples caught)`);

/* ── Verdict ──────────────────────────────────────────────────────────── */
console.log(failures === 0
  ? `\nRULES GATE PASSED (${ruleset.rules.length} rules, v${ruleset.version})`
  : `\nRULES GATE FAILED — ${failures} error(s)`);
process.exit(failures === 0 ? 0 : 1);
