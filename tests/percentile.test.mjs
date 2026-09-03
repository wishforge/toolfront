// percentile — the benchmark percentile shipped with every report must be
// monotonic, clamped, and honestly derived (population-corrected anchors).
// Repo convention: fully offline, worker imported directly, no dev server.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? "  " + e : ""}`); } };

const worker = (await import("../worker.js")).default;
const { benchmarkPercentile: bp, BENCHMARK_ANCHORS: A } = await import("../worker.js");

console.log("\n[A] monotonic + anchored");
ok("anchors are ascending in both coordinates", A.every((a, i) => i === 0 || (a[0] > A[i - 1][0] && a[1] > A[i - 1][1])));
let mono = true;
let prev = -1;
for (let s = 0; s <= 110; s++) {
  const p = bp(s);
  if (p < prev) mono = false;
  prev = p;
}
ok("percentile is monotonic non-decreasing over 0..110", mono);
ok("anchor scores reproduce their own percentile", A.every(([p, s]) => bp(s) === p), A.map(([p, s]) => `bp(${s})=${bp(s)}!=${p}`).join(","));

console.log("\n[B] clamps");
ok("score 0 stays >= 1 (bottom is still information)", bp(0) >= 1, String(bp(0)));
ok("score 200 caps at 99 (top of corpus earns top 1%, not a boast)", bp(200) === 99, String(bp(200)));
ok("null/NaN score -> null (blocked scans carry no percentile)", bp(null) === null && bp(NaN) === null);

console.log("\n[C] honest positions (population-corrected, not stratified-sample flattery)");
ok("example.com-like 22 sits between p10 and p25", bp(22) > 10 && bp(22) < 25, String(bp(22)));
ok("median-ish 38 lands at p50", bp(38) === 50, String(bp(38)));
ok("102 (a top scorer) stays under 100", bp(102) < 100 && bp(102) >= 95, String(bp(102)));

console.log("\n[D] wired into the payload and the page");
const src = readFileSync(ROOT + "worker.js", "utf8");
ok("report payload ships percentile + benchmark_version", src.includes("percentile: benchmarkPercentile(score), benchmark_version: BENCHMARK_VERSION"));
const page = readFileSync(ROOT + "public/report.html", "utf8");
ok("report page reads r.percentile", page.includes("r.percentile"));
ok("percentile copy exists in both locales", page.includes("report.percentile': 'Higher than {p}%") && page.includes("report.percentile': '高于我们跨行业基准中 {p}% 的网站'"));

console.log(`\npercentile 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
