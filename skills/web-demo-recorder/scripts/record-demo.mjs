#!/usr/bin/env node
/**
 * record-demo.mjs - record a human-like product walkthrough of a website into MP4
 *
 * Uses playwright-core + full Chromium (headed) to:
 *   1. open the target URL like a human (real typing delay, smooth scrolls, pauses)
 *   2. record video via playwright recordVideo
 *   3. detect and report Cloudflare/Turnstile challenge pages
 *   4. convert webm -> mp4 with system ffmpeg (playwright's bundled ffmpeg lacks
 *      libx264 muxer / movflags support - do NOT use it)
 *   5. extract sample frames for content verification
 *
 * Usage:
 *   node record-demo.mjs [--url http://localhost:8787] [--domain example.com]
 *                        [--out /path/to/out] [--width 1280] [--height 800]
 *
 * Environment discovery (same as precommit-ui-regression):
 *   - full Chromium: ~/Library/Caches/ms-playwright/chromium-1228/.../Google Chrome for Testing
 *   - playwright-core: /Users/david/.workbuddy/binaries/node/workspace/node_modules/
 *   - system ffmpeg: /opt/homebrew/bin/ffmpeg (macOS Homebrew)
 */
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------- arg parsing ----------
function parseArgs(argv) {
  const args = { url: "http://localhost:8787", domain: "example.com", out: "/tmp/demo-recording", w: 1280, h: 800 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--domain") args.domain = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--width") args.w = parseInt(argv[++i]);
    else if (a === "--height") args.h = parseInt(argv[++i]);
  }
  return args;
}

// ---------- environment discovery ----------
function findChromium() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.CHROMIUM_PATH,
    home + "/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    home + "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    home + "/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // auto-discover latest full chromium under ms-playwright
  try {
    const base = home + "/Library/Caches/ms-playwright";
    if (existsSync(base)) {
      const dirs = readdirSync(base).filter(d => d.startsWith("chromium-") && !d.includes("headless")).sort();
      if (dirs.length) {
        const latest = dirs[dirs.length - 1];
        const p = base + "/" + latest + "/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
        if (existsSync(p)) return p;
      }
    }
  } catch (_) {}
  return null;
}

function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
  return candidates.find(c => c && existsSync(c)) || null;
}

// ---------- main ----------
const args = parseArgs(process.argv);
const exe = findChromium();
if (!exe) {
  console.error("X full Chromium not found. Set CHROMIUM_PATH or install playwright chromium.");
  process.exit(1);
}
const ffmpeg = findFfmpeg();
if (!ffmpeg) {
  console.error("X system ffmpeg not found (playwright bundled ffmpeg cannot mux mp4). Set FFMPEG_PATH.");
  process.exit(1);
}
const pwcPath = process.env.PLAYWRIGHT_CORE_PATH || "/Users/david/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
const { chromium } = await import(pathToFileURL(pwcPath).href);

mkdirSync(args.out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: exe, headless: false });
const context = await browser.newContext({
  viewport: { width: args.w, height: args.h },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  recordVideo: { dir: args.out, size: { width: args.w, height: args.h } },
});
// Force English UI on every page load: clear any persisted language and pin tf-lang=en
await context.addInitScript(() => {
  try { localStorage.setItem("tf-lang", "en"); } catch (_) {}
});
const page = await context.newPage();

try {
  console.log("[0] blank page (simulate opening the site)");
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(1500); // brief white screen -> "opening" feel, not a stall

  console.log("[1] open " + args.url);
  // append ?lang=en to force English UI regardless of localStorage
  const langParam = args.url.includes("?") ? "&lang=en" : "?lang=en";
  await page.goto(args.url + langParam, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(2200); // let the page settle + hero animations play (LIVE badge, count-up)

  // Cloudflare/Turnstile challenge detection
  const challenged = await page.evaluate(() => {
    const t = document.title.toLowerCase();
    const txt = (document.body?.innerText || "").slice(0, 300);
    return t.includes("just a moment") || txt.includes("verifying you are human") || txt.includes("enable javascript");
  });
  if (challenged) {
    console.error("X Cloudflare/Turnstile challenge detected. Automated browsers cannot record protected sites.");
    console.error("  -> record the local dev server instead:  --url http://localhost:8787");
    console.error("  -> or ask the user to record with their own browser (they have cf_clearance cookie).");
  } else {
    console.log("[2] page loaded, no challenge - recording");
  }

  // NATURAL BROWSE: gaze-following with uneven pauses, like a real human.
  // Mouse drifts to what the eye is reading; scrolls are continuous, not stop-go.
  // 1) read the hero headline briefly
  await page.mouse.move(args.w / 2, 200);
  await sleep(1500);
  // 2) glance down at the live report card (left side of hero)
  await page.mouse.move(args.w * 0.72, 380);
  await sleep(1300);
  // 3) scroll to the pills strip (small continuous scroll)
  await page.mouse.wheel(0, 300);
  await sleep(700);
  await page.mouse.wheel(0, 260);
  await sleep(900);
  // 4) "Built for the agent ecosystem" - 4 capability cards. Hover the
  //    Shopify Storefronts card to emphasize the target-customer story.
  await page.mouse.wheel(0, 500);
  await sleep(700);
  await page.mouse.move(args.w * 0.625, 510); // cursor over Shopify Storefronts
  await sleep(1900);
  // 5) "Same store. Two very different agents." - the BLACK BOX vs GLASS BOX
  //    comparison is the value-prop core, hold long enough to read both
  await page.mouse.wheel(0, 480);
  await sleep(700);
  await page.mouse.wheel(0, 400);
  await sleep(2200);
  // 6) quick scroll past the rest (back to scan form)
  await page.mouse.wheel(0, 500);
  await sleep(300);
  await page.mouse.wheel(0, -1800);
  await sleep(900);
  await page.mouse.move(args.w / 2, 480); // settle gaze near the input
  await sleep(700);

  // type domain + scan (diagnosis FIRST - we are a scanner, not a search engine)
  console.log("[3] type domain " + args.domain);
  const input = page.locator('input[placeholder*="domain"], .scan-input').first();
  if (await input.count()) {
    await input.click();
    await input.type(args.domain, { delay: 95 }); // natural typing pace
    await sleep(600);

    const scanBtn = page.locator('button:has-text("Scan"), button:has-text("扫描")').first();
    if (await scanBtn.count()) {
      console.log("[4] click scan");
      await scanBtn.click();
      await sleep(1200);
      await page.waitForURL(/\/report\?/, { timeout: 30000 }).catch(() => {});
      await page.waitForSelector(".grade, .nums, .card", { timeout: 30000 }).catch(() => {});
      await sleep(2600); // read grade + score + pills, then move on
    }
  }

  // gaze at the report header, then scroll into findings (continuous)
  await page.mouse.move(args.w / 2, 260);
  await sleep(1100);
  await page.mouse.wheel(0, 460);
  await sleep(900);
  await page.mouse.wheel(0, 460);
  await sleep(1200);

  // apply a fix if present
  const applyBtn = page.locator(".fix .fix-btn-apply").first();
  if (await applyBtn.count()) {
    console.log("[5] apply fix");
    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(700);
    await applyBtn.click();
    await sleep(1500); // see the done state + gain change, briefly
  }
  await page.mouse.wheel(0, 400);
  await sleep(900);

  // CONTRAST: after the diagnosis, show the real site (report-first, site-second)
  const realUrl = "https://" + args.domain;
  console.log("[5a] contrast: open real site " + realUrl);
  try {
    await page.goto(realUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3200); // brand recognition is instant; no need for a long hold
  } catch (e) {
    console.log("contrast warn: " + e.message.slice(0, 60));
  }
  // return to the report page to close on the product (CTA anchors toolfront.dev)
  const reportUrl = args.url.replace(/\/$/, "") + "/report?domain=" + args.domain + "&lang=en";
  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForSelector(".grade, .nums, .card", { timeout: 30000 }).catch(() => {});
  await sleep(2200); // closing hold on the product

  console.log("[6] done, closing...");
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  await page.close();
  await context.close();
  await browser.close();
}

// ---------- convert newest webm -> mp4 (system ffmpeg only) ----------
const files = readdirSync(args.out);
const webmFiles = files.filter(f => f.endsWith(".webm")).sort();
const src = webmFiles[webmFiles.length - 1];
if (src) {
  const mp4 = join(args.out, "demo.mp4");
  console.log("Converting " + src + " -> demo.mp4");
  execFileSync(ffmpeg, ["-y", "-i", join(args.out, src), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", mp4], { stdio: "ignore" });
  console.log("MP4: " + mp4);
  // extract a verification frame at 1s
  try {
    execFileSync(ffmpeg, ["-y", "-ss", "1", "-i", mp4, "-frames:v", "1", join(args.out, "verify-1s.png")], { stdio: "ignore" });
    console.log("Verify frame: " + join(args.out, "verify-1s.png"));
  } catch (_) {}
} else {
  console.error("X no webm found in " + args.out);
}
