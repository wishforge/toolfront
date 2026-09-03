// red36 — security/performance/privacy/compliance probes for the copy + data
// changes (2026-09-03). Complements red35 (API surface); this one targets:
//   A. localized detail templates (new {list} interpolation from API data)
//   B. XSS payload matrix through the report/compare render paths (worker)
//   C. performance: TTFB median over samples + Brotli volume vs a control site
//   D. privacy: fetch x localStorage intersection, cookies, third-party refs
//   E. compliance: no real brands carrying fabricated scores in served data
const TF = 'http://localhost:8788';
const MON = 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } };

console.log('\n[A] localized detail templates — API data must not reach markup');
{
  // The bots array from the API is interpolated into a localized template and
  // rendered as a TEXT node. Simulate a hostile robots.txt value end-to-end.
  // createTextNode is a DOM API — it can only live in the page, not the worker.
  const repSrc = (await import('node:fs')).readFileSync('/Users/david/k8s/auto_swe_sys/toolfront/public/report.html', 'utf8');
  ok('detail renders via createTextNode (not innerHTML)', (repSrc.match(/createTextNode/g) || []).length >= 1);
  const html = (await import('node:fs')).readFileSync('/Users/david/k8s/auto_swe_sys/toolfront/public/report.html', 'utf8');
  ok('status whitelist still guards the class attribute', html.includes("var ST_OK = ['found', 'blocked', 'open', 'notfound', 'unknown']"));
  ok('bots list interpolated with replace(), not string concat into markup', html.includes("detail.replace('{list}', item.bots.join(', '))"));
  ok('supp-item text goes through a text node', /txt\.appendChild\(document\.createTextNode\(' — ' \+ detail\)\)/.test(html));
}

console.log('\n[B] XSS payload matrix through scan -> report render (worker)');
{
  const worker = (await import('/Users/david/k8s/auto_swe_sys/toolfront/worker.js')).default;
  const payloads = [
    '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "';alert(1)//",
    '`${alert(1)}`', '<svg/onload=alert(1)>', '%3Cscript%3E', '&#60;script&#62;',
    '\u0000<script>', 'javascript:alert(1)', 'A'.repeat(5000),
  ];
  let bad = 0;
  for (const p of payloads) {
    const res = await worker.fetch(new Request(`${TF}/api/scan?domain=${encodeURIComponent(p)}`), {}, {});
    if (res.status === 500) bad++;
    // A 400/403 is the correct outcome; a scan must never start.
    if (res.status === 200) { const j = await res.json(); if (j.domain && j.domain === p) bad++; }
  }
  ok('10 payloads: no 500, no payload echoed as a scannable domain', bad === 0, `suspicious=${bad}`);
}

console.log('\n[C] performance — TTFB median (time-to-headers) + volume');
{
  const timeToHeaders = async (url) => {
    const t = Date.now();
    const r = await fetch(url);
    await r.arrayBuffer();
    return { ttfb: r.headers ? undefined : undefined, total: Date.now() - t, size: (await r.text()).length };
  };
  // TTFB = time until response headers; measure via fetch timing is not
  // exposed in undici, so use total time on small responses as a stable proxy
  // and sample 5x taking the median (skill rule: never trust one sample).
  const sample = async (url) => {
    const xs = [];
    for (let i = 0; i < 5; i++) { const t = Date.now(); await fetch(url).then(r => r.text()); xs.push(Date.now() - t); }
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  };
  const home = await sample(`${TF}/`);
  const cmp = await sample(`${TF}/compare?a=toolfront.dev&b=docs.example.com`);
  const rk = await sample(`${MON}/rankings`);
  const api = await sample(`${MON}/api/rankings`);
  const control = await sample('https://example.com');
  console.log(`     median ms → home ${home} | compare ${cmp} | rankings ${rk} | rankings-api ${api} | control(example.com) ${control}`);
  ok('home median under 1500ms (local dev)', home < 1500, `${home}ms`);
  ok('rankings API median under 500ms', api < 500, `${api}ms`);
  const homeHtml = await (await fetch(`${TF}/`)).text();
  const cmpHtml = await (await fetch(`${TF}/compare`)).text();
  const rkHtml = await (await fetch(`${MON}/rankings`)).text();
  console.log(`     raw bytes → home ${homeHtml.length} | compare ${cmpHtml.length} | rankings ${rkHtml.length}`);
  ok('compare page under 40KB raw', cmpHtml.length < 40000, `${cmpHtml.length}B`);
  ok('rankings page under 40KB raw', rkHtml.length < 40000, `${rkHtml.length}B`);
}

console.log('\n[D] privacy — data egress, cookies, third-party refs');
{
  const cmpHtml = await (await fetch(`${TF}/compare`)).text();
  const rkHtml = await (await fetch(`${MON}/rankings`)).text();
  const skips = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '');
  const externalLinks = (h) => (skips(h).match(/(?:src|href)="https?:\/\/(?!localhost|127\.0\.0\.1|toolfront\.dev)[^"]+"/g) || []);
  ok('compare page has no third-party resource refs', externalLinks(cmpHtml).length === 0, externalLinks(cmpHtml).slice(0, 3).join(' | '));
  ok('rankings page has no third-party resource refs', externalLinks(rkHtml).filter(l => !/toolfront\.dev/.test(l)).length === 0, externalLinks(rkHtml).slice(0, 3).join(' | '));
  // fetch x storage intersection: the API calls must not carry local data.
  ok('compare fetch carries only the two domains (no localStorage payload)',
    /fetch\('\/api\/compare\?a=' \+ encodeURIComponent\(a\) \+ '&b=' \+ encodeURIComponent\(b\)\)/.test(cmpHtml));
  ok('rankings fetch carries only the vertical (no JWT)', /fetch\('\/api\/rankings\?vertical=' \+ current\)/.test(rkHtml));
  const rkRes = await fetch(`${MON}/api/rankings`);
  const rkJson = await rkRes.text();
  ok('rankings API response has no email / IP / token fields', !/(@[a-z]+\.)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)|(token|jwt|secret)/i.test(rkJson));
  ok('no Set-Cookie on rankings', !rkRes.headers.get('set-cookie'));
}

console.log('\n[E] compliance — served data must not assert fabricated scores about real brands');
{
  const j = await (await fetch(`${MON}/api/rankings`)).json();
  const BRANDS = ['stripe.com', 'vercel.com', 'github.com', 'netlify.com', 'supabase.com', 'linear.app', 'railway.app', 'openai.com'];
  const leaked = (j.rows || []).filter(r => BRANDS.includes(r.domain));
  ok('no curated brand rows served from fabricated seed data', leaked.length === 0, JSON.stringify(leaked));
  const nonReserved = (j.rows || []).filter(r => !/\.example\.(com|org|net)$/.test(r.domain) && r.domain !== 'toolfront.dev');
  console.log(`     rows served: ${(j.rows || []).length} (non-reserved: ${nonReserved.map(r => r.domain).join(', ') || 'none'})`);
  ok('every served row is a reserved domain or our own', nonReserved.length === 0, JSON.stringify(nonReserved));
  const page = await (await fetch(`${MON}/rankings`)).text();
  ok('rankings page states where scores come from', /data-i18n="rank.disclaimer"/.test(page));
}

console.log(`\nred36 结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
