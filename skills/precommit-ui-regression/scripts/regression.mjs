#!/usr/bin/env node
/**
 * precommit-ui-regression - pre-commit UI regression script
 *
 * Uses playwright-core + local Chromium for multi-viewport (desktop/tablet/phone) UI regression:
 *   - per viewport: no horizontal overflow (scrollWidth <= innerWidth)
 *   - scan a domain to generate the report page, verify finding cards render
 *   - interaction: i18n toggle roundtrip, Apply fix toggles done state
 *   - saves screenshots, exit 0=pass 1=fail
 *
 * Usage:
 *   node regression.mjs [--url http://localhost:8788] [--domain example.com]
 *                      [--out <screenshot dir>] [--custom-checks <JSON string>]
 *
 * Args:
 *   --url            site under test, default http://localhost:8788
 *   --domain         domain to scan (report-page regression), default example.com
 *   --out            screenshot output dir, default /tmp/ui-regression-shots
 *   --custom-checks  custom element check JSON, see CHECKS comment below
 */
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- local environment discovery (priority high -> low) ----------
function findPlaywrightCore() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    // WorkBuddy managed node workspace (verified on this machine)
    "/Users/david/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs",
    // global agent-browser playwright-core (if present)
    ...(() => { try {
      const g = requireGlob();
      return g ? [g + "/agent-browser/node_modules/playwright-core/index.mjs"] : [];
    } catch { return []; } })(),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function requireGlob() {
  try { return process.env.npm_config_prefix || null; } catch { return null; }
}

function findChromium() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.CHROMIUM_PATH,
    // agent-browser cache (verified: ~/Library/Caches/ms-playwright/chromium_headless_shell-1228/...)
    home + "/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    // playwright default cache
    home + "/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // auto-discover latest headless shell under ms-playwright
  try {
    const base = home + "/Library/Caches/ms-playwright";
    if (existsSync(base)) {
      const dirs = readdirSync(base).filter(d => d.startsWith("chromium_headless_shell-")).sort();
      if (dirs.length) {
        const latest = dirs[dirs.length - 1];
        const p = base + "/" + latest + "/chrome-headless-shell-mac-arm64/chrome-headless-shell";
        if (existsSync(p)) return p;
      }
    }
  } catch (_) {}
  return null;
}

// ---------- arg parsing ----------
function parseArgs(argv) {
  const args = { url: "http://localhost:8788", domain: "example.com", out: "/tmp/ui-regression-shots", customChecks: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--domain") args.domain = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--custom-checks") args.customChecks = argv[++i];
  }
  return args;
}

// ---------- default element checks (generic - skip silently when missing, do not fail) ----------
const DEFAULT_CHECKS = [
  { name: "nav present", selector: "nav" },
  { name: "hero present", selector: ".hero, [class*=hero], main h1" },
  { name: "footer present", selector: "footer, [class*=footer]" },
];

// ---------- utils ----------
let results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag} | ${name}${detail ? " | " + detail : ""}`);
}

// ---------- main flow ----------
const args = parseArgs(process.argv);
const chromiumPath = findChromium();
if (!chromiumPath) {
  console.error("X local Chromium not found. Set CHROMIUM_PATH or run agent-browser install.");
  process.exit(1);
}
const pwcPath = findPlaywrightCore();
if (!pwcPath) {
  console.error("X playwright-core not found. Set PLAYWRIGHT_CORE_PATH.");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(pwcPath).href);
console.log(`✓ Chromium: ${chromiumPath}`);
console.log(`✓ playwright-core: ${pwcPath}`);
mkdirSync(args.out, { recursive: true });

const customChecks = args.customChecks ? JSON.parse(args.customChecks) : [];
const allChecks = [...DEFAULT_CHECKS, ...customChecks];

const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });

// viewport matrix: desktop / tablet / phone (incl. smallest iPhone SE)
const VIEWPORTS = [
  { name: "desktop-1280", w: 1280, h: 800 },
  { name: "tablet-768", w: 768, h: 1024 },
  { name: "mobile-390", w: 390, h: 844 },
  { name: "mobile-375", w: 375, h: 812 },
];

for (const vp of VIEWPORTS) {
  console.log(`\n═══ ${vp.name} (${vp.w}×${vp.h}) ═══`);
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  try {
    await page.goto(args.url, { waitUntil: "networkidle", timeout: 30000 }).catch(() =>
      page.goto(args.url, { waitUntil: "load", timeout: 30000 })
    );
    await page.waitForTimeout(1200);

    // 1. no horizontal overflow (core assertion)
    const { sw, iw } = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }));
    check(`${vp.name} no horizontal overflow`, sw <= iw, `${sw} vs ${iw}`);

    // 2. generic element presence
    for (const c of allChecks) {
      const found = await page.locator(c.selector).count();
      if (found > 0) check(`${vp.name} ${c.name}`, true, c.selector);
    }

    // 3. screenshot (viewport, not full page - mobile full page is too tall)
    await page.screenshot({ path: join(args.out, `${vp.name}-hero.png`) });

    // 4. report-page regression: fill domain -> scan -> wait for finding cards (strictly wait .fix to avoid early return from wide selectors)
    const input = page.locator('input[placeholder*="domain"]').first();
    if (await input.count()) {
      await input.fill(args.domain);
      const scanBtn = page.locator('button:has-text("Scan"), button:has-text("扫描")').first();
      if (await scanBtn.count()) {
        await scanBtn.click();
        /* The scan is async, and .fix cards are built by JS only after the scan
           result arrives — strictly later than the URL flipping to /report.
           Waiting on (URL || cards) resolves the moment the URL flips, so the
           count below ran against an empty DOM and reported count=0 on every
           viewport. Wait for the navigation first, then for the cards. */
        await page.waitForFunction(
          () => location.pathname.includes("report"),
          { timeout: 20000 }
        ).catch(() => {});
        await page.waitForFunction(
          () => document.querySelectorAll(".fix").length > 0,
          { timeout: 20000 }
        ).catch(() => {});
        const fixCount = await page.locator(".fix").count();
        check(`${vp.name} finding cards render`, fixCount >= 3, `count=${fixCount}`);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(args.out, `${vp.name}-report.png`) });

        // 5. interaction: Apply fix -> done state
        if (await page.locator(".fix .fix-btn-apply").count()) {
          await page.locator(".fix .fix-btn-apply").first().click();
          await page.waitForTimeout(300);
          const done = await page.locator(".fix.done").count();
          check(`${vp.name} apply-fix toggles done`, done >= 1, `done=${done}`);
        }
      }
    }
  } catch (e) {
    check(`${vp.name} run`, false, e.message.slice(0, 120));
  } finally {
    await page.close();
  }
}

// 6. i18n toggle roundtrip (EN->ZH->EN), desktop only
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(args.url, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(800);
  const enH1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
  if (await page.locator("#lang-zh").count()) {
    await page.click("#lang-zh");
    await page.waitForTimeout(400);
    const zhH1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
    await page.click("#lang-en");
    await page.waitForTimeout(400);
    const enH1b = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
    check("i18n EN→ZH→EN roundtrip", enH1 !== zhH1 && zhH1.length > 0 && enH1b === enH1, `EN="${enH1.slice(0,20)}" ZH="${zhH1.slice(0,20)}"`);
  } else {
    check("i18n toggle present", false, "#lang-zh not found - skipped (site has no such toggle)");
  }
  await page.close();
} catch (e) {
  check("i18n roundtrip", false, e.message.slice(0, 120));
}

// 7. compare-page regression (desktop + smallest phone): dual cards render,
//    no overflow in the stacked mobile layout. Reuses the KV-cached domain
//    from the report-page regression, so the extra cost is one fresh scan at
//    most (toolfront.dev self-scan resolves from local assets).
try {
  for (const vp of [VIEWPORTS[0], VIEWPORTS[VIEWPORTS.length - 1]]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    const cmpUrl = args.url + "/compare?a=" + encodeURIComponent(args.domain) + "&b=toolfront.dev";
    await page.goto(cmpUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() =>
      page.goto(cmpUrl, { waitUntil: "load", timeout: 45000 })
    );
    await page.waitForFunction(() => document.querySelectorAll(".pcard").length > 0, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(500);
    const cards = await page.locator(".pcard").count();
    check(`${vp.name} compare dual cards`, cards === 2, `count=${cards}`);
    const vs = await page.locator(".vs-badge").count();
    check(`${vp.name} compare VS badge`, vs === 1);
    const { sw, iw } = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }));
    check(`${vp.name} compare no horizontal overflow`, sw <= iw, `${sw} vs ${iw}`);
    await page.screenshot({ path: join(args.out, `${vp.name}-compare.png`) });
    await page.close();
  }
} catch (e) {
  check("compare page", false, e.message.slice(0, 120));
}

await browser.close();

// ---------- summary ----------
const fails = results.filter(r => !r.ok);
console.log("\n══════════ SUMMARY ══════════");
console.log(`TOTAL: ${results.length}  PASS: ${results.length - fails.length}  FAIL: ${fails.length}`);
console.log(`Screenshots: ${args.out}`);
if (fails.length) {
  console.log("\nFailures:");
  for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? " | " + f.detail : ""}`);
  process.exit(1);
}
console.log("✓ All checks passed, safe to commit / push PR");
process.exit(0);
