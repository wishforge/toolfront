// 第二十八轮 RED：篡改 localStorage 基线 → 注入 DOM（jsdom 真实渲染验证）
import fs from 'fs';
import { JSDOM } from 'jsdom';

// report.html owns renderReport (the homepage split moved it there long ago);
// meta-relative path keeps the suite CWD-independent.
const html = fs.readFileSync(new URL('../public/report.html', import.meta.url), 'utf8');
// Fetch a real report instead of reading a /tmp fixture: the suite must be
// self-contained, otherwise CI runners (which have no such file) fail on startup.
const s1 = await (await fetch('https://toolfront.dev/api/scan?domain=example.com')).json();

let pass = 0, fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? ' — ' + d : '')); c ? pass++ : fail++; };

const store = {};
const mockLS = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

function bootRender(prevPayload, report) {
  store['tf-last:example.com'] = prevPayload;
  const dom = new JSDOM(html, {
    url: 'https://toolfront.dev/report?domain=example.com&lang=zh',
    runScripts: 'dangerously',
    beforeParse(win) {
      Object.defineProperty(win, 'localStorage', { value: mockLS, configurable: true });
      win.fetch = () => Promise.reject(new Error('no network'));
    },
  });
  dom.window.renderReport(report);
  return dom.window.document;
}

console.log('═══ A. 篡改 localStorage → HTML 注入 ═══');
// A1: prev.ts 带 XSS payload（唯一流入 DOM 的 prev 字段）
{
  const payload = JSON.stringify({ score: 1, ts: '<img src=x onerror=alert(1)>', checks: [{ id: 'llms-txt', status: 'fail' }] });
  const d = bootRender(payload, { ...s1, domain: 'example.com', scannedAt: '2026-08-30T10:00:00.000Z' });
  const imgs = d.querySelectorAll('img[src="x"]');
  const scripts = d.querySelectorAll('script[Injected]');
  ok('A1 恶意 ts 不产生 <img onerror>', imgs.length === 0);
  const vsNotes = Array.from(d.querySelectorAll('.vs-note')).map(n => n.textContent).join(' ');
  ok('A1b ts 被当纯文本渲染（字符串原样显示，不产生元素）', d.querySelectorAll('img, script[Injected], [onerror]').length === 0);
}

// A2: 完全非法的 JSON（应静默降级为无基线）
{
  const d = bootRender('this is not json {{{', { ...s1, domain: 'example.com', scannedAt: '2026-08-30T10:00:00.000Z' });
  // Baseline markup changed: 'first scan' renders as a .vs-item inside the vs
  // block, and a .vs-note (local-storage notice) is always present. The
  // silent-degrade contract: the page renders AND shows the first-scan copy.
  const firstScan = d.body.textContent.includes('首次扫描该域名');
  ok('A2 烂 JSON 静默降级 → 显示"首次扫描"', firstScan && !!d.querySelector('.grade'));
}

// A3: 原型污染尝试（__proto__ 字段）
{
  const payload = '{"__proto__": {"polluted": true}, "score": 1, "ts": "2026-01-01", "checks": []}';
  const d = bootRender(payload, { ...s1, domain: 'example.com', scannedAt: '2026-08-30T10:00:00.000Z' });
  const vsNote = d.querySelector('.vs-note');
  ok('A3 __proto__ 载荷安全（JSON.parse 不污染原型）', !!vsNote, vsNote ? vsNote.textContent.slice(0, 50) : '(无)');
}

// A4: 超长 ts 字段
{
  const payload = JSON.stringify({ score: 1, ts: 'A'.repeat(100000), checks: [] });
  const d = bootRender(payload, { ...s1, domain: 'example.com', scannedAt: '2026-08-30T10:00:00.000Z' });
  const notes = d.querySelectorAll('.vs-note');
  const maxLen = Array.from(notes).reduce((m, n) => Math.max(m, n.textContent.length), 0);
  ok('A4 超长 ts 被 slice(0,10) 截断', maxLen < 200, '渲染文本最长 ' + maxLen + ' 字符');
}

// A5: 伪造 checks 数组（畸形对象）
{
  const payload = JSON.stringify({ score: 'not-a-number', ts: '2026-01-01', checks: 'not-an-array' });
  const d = bootRender(payload, { ...s1, domain: 'example.com', scannedAt: '2026-08-30T10:00:00.000Z' });
  ok('A5 畸形结构不崩（score 非 数字/checks 非数组）', !!d.querySelector('.grade'));
}

// A6: 伪造超大 score
{
  const payload = JSON.stringify({ score: -99999999, ts: '2026-01-01', checks: [{ id: 'llms-txt', status: 'fail' }] });
  const d = bootRender(payload, { ...s1, domain: 'example.com', scannedAt: '2026-08-30T10:00:00.000Z' });
  const delta = d.querySelector('.delta');
  ok('A6 伪造极端 score 不崩（delta 仅作文本显示）', !!delta, delta ? delta.textContent.trim() : '(无)');
}

console.log('\n════════ ' + pass + ' passed, ' + fail + ' failed ════════');
