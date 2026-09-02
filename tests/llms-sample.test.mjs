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
