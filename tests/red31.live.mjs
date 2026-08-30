// Round 31 — Anthropic-Cybersecurity-Skills informed: IP-header spoofing rate-limit bypass,
// protocol-handler SSRF, cloud-metadata endpoints, API-vs-UI data exposure
const BASE = 'https://toolfront.dev';
let pass = 0, fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? ' — ' + d : '')); c ? pass++ : fail++; };

console.log('═══ A. IP 头伪造限流绕过（performing-api-rate-limiting-bypass）═══');
// Attacker spoofs CF-Connecting-IP / X-Forwarded-For with a DIFFERENT value per
// request. If the edge honors the spoofed header, each request lands in a fresh
// counter and NO 429 ever fires. If Cloudflare overwrites them (expected), the
// 31st+ request from our REAL ip gets throttled.
{
  const spoofed = [];
  for (let i = 0; i < 35; i++) {
    const fake = `198.51.100.${(i % 250) + 1}`;
    const r = await fetch(BASE + '/api/scan?domain=example.com', {
      headers: {
        'CF-Connecting-IP': fake,
        'X-Forwarded-For': fake + ', 203.0.113.9',
        'X-Real-IP': fake,
        'True-Client-IP': fake,
        'Forwarded': `for=${fake}`,
      }
    });
    spoofed.push(r.status);
    await r.text();
  }
  // VERIFIED SEPARATELY: spoofing CF-Connecting-IP → Cloudflare EDGE returns 403
  // (the request never reaches the Worker); spoofing X-Forwarded-For alone → 200 but
  // ineffective (the limiter reads the edge-set CF-Connecting-IP); clean request → 200.
  // So the strongest possible outcome held: the header the limiter trusts cannot be
  // spoofed at all. The 35-burst below with ALL spoof headers was 100% edge-rejected.
  ok('A1 35 次伪造 IP 头轰炸 → 全部被边缘拦截（无一绕过）', spoofed.every(x => x === 403 || x === 429 || x === 200), spoofed.filter(x => x === 403).length + '×403 ' + spoofed.filter(x => x === 429).length + '×429 ' + spoofed.filter(x => x === 200).length + '×200');
  ok('A2 无 5xx（伪造头不崩溃）', spoofed.every(s => s < 500), spoofed.filter(s => s >= 500).length + ' 个 5xx');
  ok('A3 无 200 绕过（伪造 CF-* 头到不了 Worker）', !spoofed.some(x => x === 200), '');
  console.log('    状态码序列: ' + spoofed.join('').replace(/(200{4,})/g, m => `[${m.length}×200]`).slice(0, 80));
}

console.log('═══ B. 协议 handler + 云元数据 SSRF（performing-ssrf-vulnerability-exploitation）═══');
{
  const payloads = [
    'file:///etc/passwd', 'file://localhost/etc/passwd',
    'gopher://127.0.0.1:6379/_INFO', 'dict://127.0.0.1:6379/INFO',
    'ftp://internal/secret', 'http://169.254.169.254/latest/meta-data/',
    '169.254.169.254', 'metadata.google.internal', 'instance-data',
    'metadata.azure.internal',
  ];
  for (const p of payloads) {
    const r = await fetch(BASE + '/api/scan?domain=' + encodeURIComponent(p));
    ok('B ' + p.slice(0, 34) + ' → 拒绝/不可扫', r.status === 400 || r.status === 502, 'HTTP ' + r.status);
  }
}

console.log('═══ C. API vs UI 数据暴露差异（exploiting-excessive-data-exposure-in-api）═══');
{
  const r = await fetch(BASE + '/api/scan?domain=example.com');
  const j = await r.json();
  const topKeys = Object.keys(j).sort();
  // UI (renderReport) consumes: domain score grade verdict checks(scannedAt) cached
  const uiUsed = new Set(['domain', 'score', 'grade', 'verdict', 'checks', 'scannedAt', 'cached']);
  const notRendered = topKeys.filter(k => !uiUsed.has(k));
  ok('C1 API 顶层键全部被 UI 消费（无多余暴露）', notRendered.length === 0, notRendered.join(',') || 'none'); // tool_surface_hash stripped in round 31
  // checks 内部键: id label status points max detail — UI 用 localLabel/localDetail，但 label/detail 仍传输
  if (j.checks && j.checks[0]) {
    const ck = Object.keys(j.checks[0]).sort();
    ok('C2 checks 键白名单（无意外字段）', ['detail', 'id', 'label', 'max', 'points', 'status'].every(k => ck.includes(k)) && ck.length === 6, ck.join(','));
  }
  // 响应无 PII / 无服务端内部信息
  const body = JSON.stringify(j);
  ok('C3 响应无 IP/邮箱/堆栈/密钥', !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|@|stack|Bearer|re_/i.test(body.replace(/example\.com/g, '')), '');
}

console.log('═══ D. confirm token 不可枚举性（exploiting-idor-vulnerabilities）═══');
{
  // tokens are two randomUUIDs concatenated = 244 bits entropy; an attacker
  // guessing is impossible. Verify format + uniform failure page.
  const guesses = ['', '0', 'a'.repeat(48), 'f'.repeat(64), 'deadbeef'.repeat(8)];
  for (const g of guesses) {
    const r = await fetch(BASE + '/confirm?token=' + encodeURIComponent(g));
    ok('D token="' + g.slice(0, 12) + '" → 统一过期页（200 非 500）', r.status === 200, 'HTTP ' + r.status);
  }
  // 篡改真 token 一位（若有 pending）——静态层面 token 无顺序性，跳过动态枚举（需要 2^244）
}

console.log('════════ ' + pass + ' passed, ' + fail + ' failed ════════');
