// Round 30 — web-red-blue-audit skill run: deep-nesting JSON, proto pollution, resend/F1 abuse matrix
import zlib from 'zlib';
const BASE = 'https://toolfront.dev';
let pass = 0, fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? ' — ' + d : '')); c ? pass++ : fail++; };

console.log('═══ A. 深嵌套 JSON（4KB 门内的栈溢出面）═══');
{
  // ~3900 chars of `[[[[[...]]]]]` — maximal nesting depth inside the 4KB body gate
  const half = '['.repeat(1950);
  const deep = half + half.replace(/\[/g, ']');
  for (const ep of ['/api/waitlist', '/api/resend']) {
    const r = await fetch(BASE + ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: deep });
    const t = await r.text();
    // [[[...]]] is VALID JSON (no stack overflow at this depth in V8) — the body
    // therefore flows into email validation and fails there. 400, no 5xx, no crash.
    ok('A ' + ep + ' 深嵌套(' + deep.length + 'B) → 400（合法 JSON 走邮箱校验）', r.status === 400 && /invalid_email|bad_json/.test(t), 'HTTP ' + r.status + ' — ' + (t.match(/"\w+"\s*:/) || [''])[0]);
  }
  // 深嵌套对象 `{"a":{"a":...` (unterminated to also stress the parser)
  const deepObj = '{"a":'.repeat(700) + '1' + '}'.repeat(700); // 4201B > 4096 gate
  const r2 = await fetch(BASE + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: deepObj });
  ok('A 深嵌套对象 4201B 超门 → 413（门正确拦截）', r2.status === 413, 'HTTP ' + r2.status);
  // nesting that FITS inside the gate: ~780 levels is the max achievable in 4KB,
  // far below V8's JSON.parse stack limit — structurally impossible to overflow.
  const deepFit = '{"a":'.repeat(600) + '1' + '}'.repeat(600);
  const r3 = await fetch(BASE + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: deepFit });
  const t3 = await r3.text();
  ok('A 门内最大嵌套(' + deepFit.length + 'B, 600 层) → 正常校验路径', r3.status === 400 && /invalid_email/.test(t3), 'HTTP ' + r3.status);
  // 服务仍然活着
  const alive = await fetch(BASE + '/');
  ok('A 轰炸后服务仍 200', alive.status === 200, 'HTTP ' + alive.status);
}

console.log('═══ B. __proto__ / 原型污染（body 通道）═══');
{
  const r = await fetch(BASE + '/api/waitlist', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'proto-test@example.com', __proto__: { admin: true }, constructor: { prototype: { x: 1 } } })
  });
  const t = await r.text();
  ok('B __proto__ body → 正常 400（无 5xx）', r.status === 400, 'HTTP ' + r.status);
  ok('B 响应无污染痕迹', !/admin|__proto__|prototype/i.test(t), '');
  // JSON.stringify 会丢 __proto__（自有属性），手工构造 raw body 真正带 __proto__ 键
  const raw = '{"email":"proto2@example.com","__proto__":{"polluted":"yes"}}';
  const r2 = await fetch(BASE + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
  const t2 = await r2.text();
  ok('B raw __proto__ 键 → 正常处理（400，无外泄）', r2.status === 400 && !/polluted/.test(t2), 'HTTP ' + r2.status);
}

console.log('═══ C. resend 滥用矩阵 ═══');
{
  // C1 无效邮箱格式
  let r = await fetch(BASE + '/api/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email' }) });
  ok('C1 无效邮箱 → 400 invalid_email', r.status === 400, 'HTTP ' + r.status);
  // C2 不存在的 pending 邮箱 → 统一 200（不暴露存在性）
  const E = 'r30-never-signed-up@example.com';
  r = await fetch(BASE + '/api/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: E }) });
  const t1 = await r.text();
  ok('C2 无 pending 邮箱 → 统一 200（防枚举）', r.status === 200, t1.replace(/\s+/g, ' ').slice(0, 30));
  // C3 同一邮箱连续 4 次 resend → 第 4 次起 silent cap（计数 >=3）
  const E2 = 'r30-cap@example.com';
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const rr = await fetch(BASE + '/api/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: E2 }) });
    codes.push(rr.status);
    await rr.text();
  }
  ok('C3 resend ×5 → 全部统一 200（cap 静默，无差异响应）', codes.every(c => c === 200), codes.join(','));
  // C4 跨源 Origin → 403
  r = await fetch(BASE + '/api/resend', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example' }, body: JSON.stringify({ email: 'x@example.com' }) });
  ok('C4 跨源 Origin → 403', r.status === 403, 'HTTP ' + r.status);
  // C5 GET 方法 → 405
  r = await fetch(BASE + '/api/resend');
  ok('C5 GET /api/resend → 405', r.status === 405, 'HTTP ' + r.status);
}

console.log('═══ D. F1 回滚滥用（故意失败循环不锁死、不崩）═══');
{
  const E = 'r30-rollback-loop@example.com';
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const rr = await fetch(BASE + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: E }) });
    codes.push(rr.status);
  }
  ok('D 同一故意失败邮箱 ×6 → 全 400（可重试、无 5xx）', codes.every(c => c === 400), codes.join(','));
  // 服务仍健康
  const a = await fetch(BASE + '/api/scan?domain=example.com');
  ok('D 循环后扫描 API 仍正常', a.status === 200, 'HTTP ' + a.status);
}

console.log('═══ E. 性能（三原则精简版）═══');
{
  const r = await fetch(BASE + '/');
  const h = await r.text();
  const br = zlib.brotliCompressSync(Buffer.from(h)).length;
  ok('E1 Brotli < 25KB', br < 25 * 1024, (br / 1024).toFixed(1) + 'KB');
  const tf = [], cf = [];
  for (let i = 0; i < 6; i++) {
    let t = Date.now(); const a = await fetch(BASE + '/'); tf.push(Date.now() - t); await a.arrayBuffer();
    t = Date.now(); const b = await fetch('https://example.com/'); cf.push(Date.now() - t); await b.arrayBuffer();
  }
  tf.sort((a, b) => a - b); cf.sort((a, b) => a - b);
  ok('E2 真 TTFB 中位数与对照同量级', tf[3] <= Math.max(450, cf[3] * 1.8), tf[3] + 'ms (对照 ' + cf[3] + 'ms)');
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(BASE + '/api/scan?domain=r30-' + i + '.example.com')));
  ok('E3 10 并发无 5xx', rs.every(x => x.status < 500), rs.filter(x => x.status >= 500).length + ' 个 5xx');
}

console.log('════════ ' + pass + ' passed, ' + fail + ' failed ════════');
