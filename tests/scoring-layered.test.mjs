import { layeredScores } from "../worker.js";

const PB = { essential: 86, surface: 14, emerging: 8 };
const chk = (pool, points, max) => ({ pool, points, max, status: points === null ? "na" : "pass" });

console.log("\n[SL] layered scoring");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log("  ✗ " + n); } };

// Full rubric, everything passes: mastery 86/86 = A, capability 108/108 = 100
{
  const checks = [
    chk("essential", 20, 20), chk("essential", 18, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 10, 10), chk("essential", 8, 8),
    chk("surface", 8, 8), chk("surface", 6, 6), chk("emerging", 8, 8),
  ];
  const L = layeredScores(checks, PB);
  ok("full rubric: masteryEarned=86", L.masteryEarned === 86 && L.masteryMax === 86);
  ok("full rubric: masteryPct=100 grade=A", L.masteryPct === 100 && L.grade === "A");
  ok("full rubric: capPct=100 capMax=108", L.capPct === 100 && L.capMax === 108);
}
// No tool surface (surface+emerging n/a): mastery still out of 86, capability caps at 79
{
  const checks = [
    chk("essential", 20, 20), chk("essential", 18, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 10, 10), chk("essential", 8, 8),
    chk("surface", null, 8), chk("surface", null, 6), chk("emerging", null, 8),
  ];
  const L = layeredScores(checks, PB);
  ok("narrow site: masteryPct=100 grade=A", L.masteryPct === 100 && L.grade === "A");
  ok("narrow site: capPct=80 (86/108)", L.capPct === 80 && L.capMax === 108);
}
// Partial mastery: 74/86 = 86% → A threshold
{
  const checks = [chk("essential", 20, 20), chk("essential", 18, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 6, 10), chk("essential", 0, 8)];
  const L = layeredScores(checks, PB);
  ok("74/86 = 86% grade=A", L.masteryEarned === 74 && L.masteryPct === 86 && L.grade === "A");
}
// Essential blocked by bot protection: masteryMax shrinks (warn banner covers it)
{
  const checks = [chk("essential", 20, 20), chk("essential", null, 18), chk("essential", 18, 18),
    chk("essential", 12, 12), chk("essential", 10, 10), chk("essential", 8, 8)];
  const L = layeredScores(checks, PB);
  ok("blocked essential: masteryMax=68", L.masteryMax === 68);
}
console.log(`[SL] ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
