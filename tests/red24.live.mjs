// 第二十四轮红蓝：异形IP SSRF / Unicode同形 / 超长参数 / HTTP方法 / 并发性能
const BASE = 'https://toolfront.dev';
let pass = 0, fail = 0;
function ok(name, cond, detail) { console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : '')); cond ? pass++ : fail++; }
const get = (u) => fetch(BASE + u, { redirect: 'manual' });

console.log('═══ A. 异形 IP 格式 SSRF（内网/本机绕道）═══');
{
  const ips = [
    ['十进制 127.0.0.1', '2130706433'],
    ['十六进制 127.0.0.1', '0x7f000001'],
    ['八进制 127.0.0.1', '0177.0.0.1'],
    ['IPv6 ::1', '%5B::1%5D'],
    ['IPv6 完整', '0:0:0:0:0:0:0:1'],
    ['localhost 带端口', 'localhost:8080'],
    ['userinfo@host 混淆', 'user@example.com'],
    ['十进制 192.168.1.1', '3232235777'],
    ['短 IPv6 ::ffff:127.0.0.1', '%5B::ffff:127.0.0.1%5D'],
  ];
  for (const [name, d] of ips) {
    const r = await get('/api/scan?domain=' + encodeURIComponent(d));
    ok('A ' + name, r.status === 400 || r.status === 403 || r.status === 502, 'HTTP ' + r.status);
  }
}

console.log('═══ B. Unicode 同形 / punycode 域名 ═══');
{
  const r = await get('/api/scan?domain=аррӏе.com'); // 西里尔同形 apple
  ok('B1 同形域名规范化处理', r.status === 400 || r.status === 403 || r.status === 502 || r.status === 200, 'HTTP ' + r.status);
  const r2 = await get('/api/scan?domain=xn--80ak6aa92e.com'); // punycode
  ok('B2 punycode 域名', r2.status === 400 || r2.status === 403 || r2.status === 502 || r2.status === 200, 'HTTP ' + r2.status);
  const r3 = await get('/api/scan?domain=例子.测试'); // 中文域名
  ok('B3 中文域名', r3.status === 400 || r3.status === 403 || r3.status === 502 || r3.status === 200, 'HTTP ' + r3.status);
}

console.log('═══ C. 超长 / 畸形参数（内存/CPU 面）═══');
{
  const huge = 'a'.repeat(10000);
  const r = await get('/api/scan?domain=' + huge + '.com');
  ok('C1 超长域名（10KB）被拒绝', r.status === 400 || r.status === 403 || r.status === 502, 'HTTP ' + r.status);
  const r2 = await get('/api/scan?domain=' + encodeURIComponent('a'.repeat(500)) + '.' + encodeURIComponent('b'.repeat(500)) + '.com');
  ok('C2 超长标签域名', r2.status === 400 || r2.status === 403 || r2.status === 502, 'HTTP ' + r2.status);
  // 大量查询参数（参数炸弹）
  let q = '/api/scan?domain=example.com';
  for (let i = 0; i < 200; i++) q += '&x' + i + '=' + 'v';
  const r3 = await get(q);
  ok('C3 200 个冗余参数不崩', r3.status === 200 || r3.status === 429, 'HTTP ' + r3.status);
}

console.log('═══ D. HTTP 方法滥用 ═══');
{
  const methods = ['HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
  for (const m of methods) {
    const r = await fetch(BASE + '/api/scan?domain=example.com', { method: m });
    const okCode = r.status === 200 || r.status === 405 || r.status === 400 || r.status === 204 || r.status === 429;
    ok('D ' + m + ' /api/scan', okCode, 'HTTP ' + r.status);
  }
}

console.log('═══ E. 并发性能（20 并发真实扫描，错误率/延迟）═══');
{
  const N = 20;
  const domains = Array.from({ length: N }, (_, i) => 'concurrency-test-' + i + '.example.com');
  const t0 = Date.now();
  // These fixtures do not resolve, so the DESIGNED response is 502 with a
  // machine-readable JSON error (scanning a dead target is an expected client
  // outcome, not a server fault). A crash page (HTML) or an unexpected 5xx is
  // the failure — hence: statuses must stay inside the designed set, and any
  // 5xx body must parse as {error: ...}.
  const rs = await Promise.all(domains.map(d => fetch(BASE + '/api/scan?domain=' + d)));
  const bodies = await Promise.all(rs.map(r => r.text()));
  const total = Date.now() - t0;
  const machineReadable = rs.every((r, i) => {
    if (r.status < 500) return true;
    try { return JSON.parse(bodies[i]).error != null; } catch (_) { return false; }
  });
  const designed = rs.every(r => r.status === 200 || r.status === 429 || r.status === 502);
  ok('E1 20 concurrent: zero crash pages (' + total + 'ms total)', machineReadable, 'statuses=' + [...new Set(rs.map(r => r.status))].join(','));
  ok('E2 statuses stay in the designed set (200 / 429 / 502-JSON)', designed, rs.map(r => r.status).join(','));
}

console.log('═══ F. 响应内容类型 / 头部完整性 ═══');
{
  const r = await get('/api/scan?domain=example.com');
  const ct = r.headers.get('content-type') || '';
  ok('F1 扫描响应是 JSON（非 HTML，杜绝反射型 XSS）', ct.includes('application/json'), ct);
  const r2 = await fetch(BASE + '/');
  ok('F2 主页 CSP 在位', (r2.headers.get('content-security-policy') || '').includes("default-src 'self'"), '');
  const r3 = await get('/api/scan?domain=example.com%0d%0aX-Test:injected');
  ok('F3 CRLF 注入域名被拒绝', r3.status === 400 || r3.status === 403 || r3.status === 502, 'HTTP ' + r3.status);
}

console.log('════════ 总览 ════════');
console.log(pass + ' passed, ' + fail + ' failed');
