// rules-guard.test.mjs — a hostile rules/poisoning.json must never reach production.
// Each vector is a rule array that compileRules() must REJECT (throw).
// Permanent regression for the four fail-closed gates (spec §5).
import assert from "node:assert";
import { compileRules } from "../worker.js";

const ATTACKS = [
  ["unknown type",        [{ id: "evil-rule-1", severity: 1, type: "eval", applies: ["description"] }]],
  ["stateful flag g",     [{ id: "evil-rule-2", severity: 1, type: "regex", pattern: "a", flags: "g", applies: ["description"] }]],
  ["stateful flag y",     [{ id: "evil-rule-3", severity: 1, type: "regex", pattern: "a", flags: "y", applies: ["description"] }]],
  ["exponential regex",   [{ id: "evil-rule-4", severity: 1, type: "regex", pattern: "(a+)+$", flags: "", applies: ["description"] }]],
  ["alternation ReDoS",   [{ id: "evil-rule-5", severity: 1, type: "regex", pattern: "(a|aa)+$", flags: "", applies: ["description"] }]],
  ["prototype executor",  [{ id: "evil-rule-6", severity: 1, type: "executor", executor: "constructor", applies: ["description"] }]],
  ["unknown executor",    [{ id: "evil-rule-7", severity: 1, type: "executor", executor: "fetch", applies: ["description"] }]],
  ["duplicate id",        [{ id: "dup", severity: 1, type: "length-over", limit: 10, applies: ["description"] },
                           { id: "dup", severity: 1, type: "length-over", limit: 20, applies: ["description"] }]],
  ["bad id charset",      [{ id: "EVIL RULE!", severity: 1, type: "length-over", limit: 10, applies: ["description"] }]],
  ["non-object rule",     ["drop table rules"]],
];

let fail = 0;
for (const [name, rules] of ATTACKS) {
  try { compileRules(rules); fail++; console.log(`  ✗ NOT rejected: ${name}`); }
  catch (e) { console.log(`  ✓ rejected: ${name.padEnd(20)} (${e.message.slice(0, 60)})`); }
}

// The shipped ruleset must compile cleanly and keep all 6 rule ids.
const { default: ruleset } = await import("../rules/poisoning.mjs");
const compiled = compileRules(ruleset.rules);
assert.equal(compiled.length, 6);
assert.deepEqual(compiled.map(r => r.id).sort(),
  ["encoded-instruction", "instruction-pattern", "name-charset", "over-budget", "wildcard-exposure", "zero-width"]);
console.log("  ✓ shipped ruleset compiles (6 rules, ids intact)");

console.log(fail === 0 ? "\nALL ATTACKS BLOCKED" : `\n${fail} ATTACKS LEAKED`);
process.exit(fail ? 1 : 0);
