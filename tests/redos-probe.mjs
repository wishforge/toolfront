// redos-probe.mjs — ReDoS 动态实测探针（闸门 3 的实现，被 gate.mjs 与 redos-fp.mjs 共用）
//
// 设计要点（都是被实测打脸后改的）：
// 1. 静态启发式不可能完备（上一轮自证 5/6），所以改用「喂病态输入、量时间」。
//    时间复杂度是可测的，正则长什么样是不可穷举的。
// 2. 攻击串族不能写死。ReDoS 的触发串取决于正则里的字面字符：
//    `(x+x+)+y` 要喂 x，`<(?:[a-z]+)*>` 要喂 `<`——只喂 'a' 会全部漏网。
//    所以先从正则源码里抽出字面量字母表，再据此生成攻击族。
// 3. 指数级（2^n）无论输入多长都会炸 → 一律拒绝。
//    多项式（n²) 是否可接受取决于你的真实输入上限 → 用绝对预算判，不达预算只告警。

const GENERIC_FAMILIES = [
  { name: "全同字符 a×n",   gen: n => "a".repeat(n) },
  { name: "a×n + 终止符 !", gen: n => "a".repeat(n) + "!" },
  { name: "交替 a!×n",      gen: n => "a!".repeat(Math.ceil(n / 2)) },
  { name: "大小写交替 aA×n", gen: n => "aA".repeat(Math.ceil(n / 2)) },
  { name: "空格×n + !",     gen: n => " ".repeat(n) + "!" },
  { name: "分块 aaaaA×n",   gen: n => "aaaaA".repeat(Math.ceil(n / 5)) },
  { name: "数字 1×n + !",   gen: n => "1".repeat(n) + "!" },
];

const LADDER_START = 8, LADDER_RATIO = 1.2, LADDER_CAP = 5000;
const ANCHORS = [1000, 2000, 4000];
const SAMPLE_BUDGET_MS = 60;   // 单样本硬上限：安全正则在 5000 字符上是微秒级
const RATIO = 3.0;             // 线性≈2×，平方=4×，立方=8× → 阈值 3 有清晰分界
// 绝对预算：由真实工作量倒推。toolfront 单次扫描约 50 个 tool、description 上限约 500 字符，
// 取 4000 字符（8 倍余量）作为探测点，单条规则单次匹配超过 5ms 就不该进 Worker。
const ABS_BUDGET_MS = 5;
const NOISE_FLOOR_MS = 2;

function geometric(start, ratio, cap) {
  const out = []; for (let n = start; n <= cap; n = Math.round(n * ratio)) out.push(n); return out;
}
const LADDER = geometric(LADDER_START, LADDER_RATIO, LADDER_CAP);

/* ── 从正则源码抽字面量字母表 ────────────────────────────── */
const CLASS_SAMPLE = { d: "1", D: "!", w: "a", W: "!", s: " ", S: "a", n: "\n", t: "\t", r: "\r", f: "\f", v: "\v" };
const ZERO_WIDTH_SAMPLE = { b: "", B: "" };

export function extractAlphabet(src) {
  const chars = [];
  const push = (c) => { if (typeof c === "string" && c.length === 1) chars.push(c); };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const nx = src[i + 1];
      if (nx === undefined) { i++; continue; }
      if (nx === "x" || nx === "u") { // \x41 / \u0041 → 取一个代表字符
        push(nx === "x" ? "a" : "a"); i += (nx === "x" ? 4 : 6); continue;
      }
      if (Object.prototype.hasOwnProperty.call(CLASS_SAMPLE, nx)) { push(CLASS_SAMPLE[nx]); i += 2; continue; }
      if (Object.prototype.hasOwnProperty.call(ZERO_WIDTH_SAMPLE, nx)) { i += 2; continue; }
      push(nx); i += 2; continue;
    }
    if (c === "[") { // 字符类：取类内前若干普通字符作代表
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;               // []abc] 的边界情况
      let taken = 0;
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") {
          const nx = src[j + 1];
          if (nx && Object.prototype.hasOwnProperty.call(CLASS_SAMPLE, nx)) { push(CLASS_SAMPLE[nx]); taken++; }
          else if (nx && !Object.prototype.hasOwnProperty.call(ZERO_WIDTH_SAMPLE, nx)) { push(nx); taken++; }
          j += 2; continue;
        }
        push(src[j]); taken++; j++;
        if (taken >= 6) { while (j < src.length && src[j] !== "]") j++; break; }
      }
      i = j + 1; continue;
    }
    if (c === "(") {
      if (/^\(\?:|^\(\?=|^\(\?!|^\(\?<[=!]?/.test(src.slice(i))) { // (?: (?= (?! (?<= (?<!
        i += src.startsWith("(?:", i) ? 3 : (src[i + 2] === "<" ? 4 : 3); continue;
      }
      i++; continue;
    }
    if (")|".includes(c)) { i++; continue; }
    if ("+*?".includes(c)) { i++; continue; }
    if (c === "{") { const m = /^\{\d+(,\d*)?\}/.exec(src.slice(i)); i += m ? m[0].length : 1; continue; }
    if ("^$".includes(c)) { i++; continue; }
    if (c === ".") { push("a"); i++; continue; }
    push(c); i++;
  }
  return [...new Set(chars)];
}

export function buildFamilies(pattern) {
  const fams = [...GENERIC_FAMILIES];
  let alpha = [];
  try { alpha = extractAlphabet(pattern); } catch { alpha = []; }
  if (alpha.length) {
    const a0 = alpha[0], aN = alpha[alpha.length - 1];
    const label = (s) => s.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    fams.push(
      { name: `字面量「${label(a0)}」×n`,            gen: n => a0.repeat(n) },
      { name: `字面量「${label(a0)}」×n + !`,        gen: n => a0.repeat(n) + "!" },
      { name: `「${label(a0)}」+ a×n（无闭合）`,      gen: n => a0 + "a".repeat(n) },
      { name: `「${label(a0)}」+ a×n + 「${label(aN)}」`, gen: n => a0 + "a".repeat(n) + aN },
    );
    if (alpha.length > 1)
      fams.push({ name: `字面量交替 ${label(a0)}${label(aN)}×n`, gen: n => (a0 + aN).repeat(Math.ceil(n / 2)) });
  }
  return fams;
}

function timeSample(re, fam, n) {
  const s = fam.gen(n);
  const t0 = performance.now();
  try { re.test(s); } catch (e) { return { ms: -1, err: e.message, n }; }
  return { ms: performance.now() - t0, n };
}

/**
 * @returns {{rejected:string|null, warn:string|null, worst:{n:number,ms:number,family:string}}}
 */
export function probePattern(pattern, flags = "") {
  let re;
  try { re = new RegExp(pattern, flags); }
  catch (e) { return { rejected: `正则无法编译: ${e.message}`, warn: null, worst: { n: 0, ms: 0, family: "" } }; }

  const fams = buildFamilies(pattern);
  let worst = { n: 0, ms: 0, family: "" };

  for (const fam of fams) {
    // 阶段一：指数爆炸探测（细步长，避免跨过预算悬崖）
    for (const n of LADDER) {
      const { ms, err } = timeSample(re, fam, n);
      if (err) return { rejected: `${fam.name} n=${n} 抛异常: ${err}`, warn: null, worst };
      if (ms > worst.ms) worst = { n, ms, family: fam.name };
      if (ms > SAMPLE_BUDGET_MS)
        return { rejected: `${fam.name} n=${n} 耗时 ${ms.toFixed(0)}ms > ${SAMPLE_BUDGET_MS}ms → 指数级回溯，输入稍长即打满 CPU`, warn: null, worst };
    }
    // 阶段二：多项式增长探测
    const ts = ANCHORS.map(n => timeSample(re, fam, n));
    const bad = ts.find(t => t.err);
    if (bad) return { rejected: `${fam.name} n=${bad.n} 抛异常: ${bad.err}`, warn: null, worst };
    const [t1, t2, t3] = ts.map(t => t.ms);
    const r1 = t2 / Math.max(t1, 0.005), r2 = t3 / Math.max(t2, 0.005);
    if (t3 > worst.ms) worst = { n: 4000, ms: t3, family: fam.name };
    if (r1 > RATIO && r2 > RATIO && t3 > NOISE_FLOOR_MS) {
      const detail = `${fam.name} n=1000→2000→4000 = ${t1.toFixed(2)}→${t2.toFixed(2)}→${t3.toFixed(2)}ms（×${r1.toFixed(1)}/×${r2.toFixed(1)}）`;
      // 超线性 ≠ 一定拒绝：是否可接受取决于它在真实输入上限下花多久
      if (t3 > ABS_BUDGET_MS)
        return { rejected: `${detail} → 4000 字符耗时 ${t3.toFixed(2)}ms 超 ${ABS_BUDGET_MS}ms 预算`, warn: null, worst };
      return { rejected: null, warn: `${detail} → 超线性但在预算内（${t3.toFixed(2)}ms ≤ ${ABS_BUDGET_MS}ms），需人工确认输入上限`, worst };
    }
  }
  return { rejected: null, warn: null, worst };
}

export const THRESHOLDS = { SAMPLE_BUDGET_MS, ABS_BUDGET_MS, RATIO, NOISE_FLOOR_MS, ANCHORS, LADDER_CAP };
