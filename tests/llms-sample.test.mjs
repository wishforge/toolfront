// llms.txt sample generator — contract tests for the "paste-ready fix"
// (F2 from the competitor review). The fix card for a missing llms.txt now
// offers a copy-ready sample built from the scanned domain + homepage title.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeTitleOf, llmsSampleFor } from '../worker.js';

test('homeTitleOf extracts <title> from homepage HTML', () => {
  assert.equal(homeTitleOf('<html><head><title>Acme — Fast Widgets</title></head><body>hi</body></html>', 'acme.com'), 'Acme — Fast Widgets');
});

test('homeTitleOf prefers og:title when present', () => {
  const html = '<head><title>Fallback</title><meta property="og:title" content="Acme Official"></head>';
  assert.equal(homeTitleOf(html, 'acme.com'), 'Acme Official');
});

test('homeTitleOf falls back to the domain when no title is found', () => {
  assert.equal(homeTitleOf('<html><body>no head title</body></html>', 'acme.com'), 'Acme');
});

test('llmsSampleFor emits a valid llmstxt.org skeleton with the real domain', () => {
  const s = llmsSampleFor('acme.com', 'Acme — Fast Widgets');
  assert.ok(s.startsWith('# Acme — Fast Widgets'), 'H1 uses the homepage title');
  assert.ok(s.includes('https://acme.com/'), 'links use the scanned domain');
  assert.ok(s.includes('>'), 'contains the llms.txt blockquote intro convention');
  assert.ok(/^#/.test(s), 'starts with an H1 as the spec requires');
  // Must NOT contain any executable / unescaped angle-bracket HTML from the title
  assert.ok(!/</.test(s.replace(/^# [^<]+/, '')), 'sample body contains no raw < tags (escaped)');
});

test('llmsSampleFor escapes a hostile title (no HTML injection into the sample)', () => {
  const s = llmsSampleFor('acme.com', '<img src=x onerror=alert(1)>');
  assert.ok(!s.includes('<img'), 'raw hostile markup is stripped/escaped');
});

test('hostile-title matrix: no raw < survives for 15 obfuscation families', () => {
  // Same families as the esc() XSS matrix. Rendered via textContent, so
  // stripped tag bodies are inert text — the property that must hold is
  // "no < structure reaches the sample".
  const MATRIX = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<sCrIpT>alert(1)</ScRiPt>',
    '</script><script>alert(1)//',
    '"><img src=x onerror=alert(1)>',
    '\u003cscript\u003ealert(1)\u003c/script\u003e',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&amp;lt;script&amp;gt;',
    'x"><iframe src="data:text/html,<script>alert(1)</script>">',
    '`${alert(1)}`',
    '<style>@import url(//evil.com/x.css)</style>',
    '<meta http-equiv="refresh" content="0;url=//evil.com">',
    '\x00<script>alert(1)</script>',
    '<'.repeat(50000) + 'script>alert(1)</script>', // unclosed-< flood
  ];
  for (const payload of MATRIX) {
    const s = llmsSampleFor('acme.com', homeTitleOf('<head><title>' + payload + '</title></head>', 'acme.com'));
    assert.ok(!/</.test(s), 'no raw < survives for: ' + payload.slice(0, 40));
  }
});
