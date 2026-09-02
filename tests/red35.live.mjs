// red35 — red/blue probes for the Batch-2/2c attack surfaces (spec 2026-09-03).
// Targets: /api/compare + /compare (toolfront 8788), /api/rankings + /rankings
// (monitor 8787). Local wrangler dev = real workerd runtime + assets layer;
// noted limitation: not the deployed edge, headers from _headers/harden() still apply.
const TF = 'http://localhost:8788';
const MON = 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } };

async function j(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { status: r.status, body, headers: r.headers };
}

console.log('\n[A] /api/rankings — prototype-chain & garbage vertical param');
{
  for (const v of ['__proto__', 'constructor', 'hasOwnProperty', 'valueOf', 'toString']) {
    const r = await j(`${MON}/api/rankings?vertical=${v}`);
    ok(`vertical=${v} → not 500`, r.status !== 500, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 80)}`);
  }
  const long = 'a'.repeat(10000);
  const r1 = await j(`${MON}/api/rankings?vertical=${long}`);
  ok('10KB vertical → not 500', r1.status !== 500, `status=${r1.status}`);
  const r2 = await j(`${MON}/api/rankings?vertical=${encodeURIComponent('支付\n<b>x</b>')}`);
  ok('unicode/HTML vertical → not 500', r2.status !== 500, `status=${r2.status}`);
  const r3 = await j(`${MON}/api/rankings?vertical=all&vertical=hosting`);
  ok('duplicate param → not 500', r3.status !== 500);
}

console.log('\n[B] /api/compare — SSRF / domain smuggling matrix');
{
  const badDomains = [
    '0x7f.0.0.1', '2130706433', '0177.0.0.1', '127.0.0.1', 'localhost',
    'user@evil.com', 'evil.com#target', 'javascript:alert(1)',
    '127.0.0.1.nip.io', 'metadata.google.internal', '10.0.0.1',
    '192.168.1.1', '169.254.169.254', '[::1]', '::ffff:127.0.0.1',
  ];
  for (const d of badDomains) {
    const r = await j(`${TF}/api/compare?a=${encodeURIComponent(d)}&b=example.com`);
    const scanAttempted = r.status === 200 && r.body && r.body.a_status === 200;
    ok(`a=${d.slice(0, 24)} → not scanned, not 500`, !scanAttempted && r.status !== 500,
      `status=${r.status} a_status=${r.body && r.body.a_status}`);
  }
  const long = 'a'.repeat(10000);
  const r1 = await j(`${TF}/api/compare?a=${long}&b=example.com`);
  ok('10KB domain → not 500', r1.status !== 500, `status=${r1.status}`);
  const r2 = await j(`${TF}/api/compare?a=example.com&b=example.com`);
  ok('same domain → 400', r2.status === 400, `status=${r2.status}`);
  const r3 = await j(`${TF}/api/compare`);
  ok('missing params → 400', r3.status === 400);
  const r4 = await j(`${TF}/api/compare?a=${encodeURIComponent('good.com')}&b=${encodeURIComponent('good.com/../x')}`);
  ok('path traversal in domain → not 500', r4.status !== 500, `status=${r4.status}`);
}

console.log('\n[C] security headers on the new pages');
{
  const cmp = await fetch(`${TF}/compare?a=x.com&b=y.com`);
  const h = cmp.headers;
  ok('/compare CSP present', !!h.get('content-security-policy'), (h.get('content-security-policy') || '').slice(0, 40));
  ok('/compare nosniff', h.get('x-content-type-options') === 'nosniff');
  ok('/compare XFO', h.get('x-frame-options') === 'DENY');
  ok('/compare Referrer-Policy', !!h.get('referrer-policy'));
  const rk = await fetch(`${MON}/rankings`);
  const h2 = rk.headers;
  ok('/rankings CSP present', !!(h2.get('content-security-policy') || '').includes('default-src'));
  ok('/rankings nosniff', h2.get('x-content-type-options') === 'nosniff');
  ok('/rankings XFO DENY', h2.get('x-frame-options') === 'DENY');
  const api = await fetch(`${MON}/api/rankings`);
  ok('/api/rankings no-store', (api.headers.get('cache-control') || '').includes('no-store'));
}

console.log('\n[D] /compare page — param → DOM paths (jsdom-free static checks)');
{
  const html = await (await fetch(`${TF}/compare`)).text();
  ok('lang whitelist guard present', html.includes('hasOwnProperty.call(LANGS'));
  ok('no innerHTML with raw params', !/innerHTML[^;]*(params|in-a|in-b)/.test(html));
  ok('history.replaceState uses encodeURIComponent', html.includes('encodeURIComponent(a)'));
}

console.log(`\nred35 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
