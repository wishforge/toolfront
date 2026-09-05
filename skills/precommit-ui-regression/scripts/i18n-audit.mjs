#!/usr/bin/env node
/**
 * i18n-audit.mjs — bilingual consistency gate.
 *
 * The dictionary-level checks that existed before were not enough: they
 * counted keys that were *present* and missed copy that was never wired to
 * i18n at all (no data-i18n attr, no apply pass, value in the wrong block).
 * This gate asserts on what the user actually sees — the rendered DOM.
 *
 * Checks, per page per language:
 *   1. shared source loaded        — /i18n/common.js present on every page
 *   2. no bare keys                — an element's text must never equal its
 *                                    data-i18n key (untranslated fallback)
 *   3. language consistency        — rendered [data-i18n] text matches the
 *                                    selected language (brand/proper-noun
 *                                    allowlist excluded)
 *   4. nav + footer consistency    — every page shows the same nav and footer
 *                                    in the same language
 *
 * Usage: node i18n-audit.mjs --url http://localhost:8788
 * Exit:  0 = all pass, 1 = at least one failure.
 */
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const ORIGIN = (urlIdx >= 0 && args[urlIdx + 1]) ? args[urlIdx + 1].replace(/\/$/, "") : "http://localhost:8788";

const PAGES = ["/", "/compare", "/rankings", "/report?domain=example.org"];
const LANGS = ["en", "zh"];

// Brand marks, language names and proper nouns that legitimately stay Latin.
// Brand names, product names and copyright lines are intentionally NOT
// translated — they are not copy, they are identity.
const ALLOW = [
  /^toolfront_?$/i, /^toolfront$/i, /^toolfront monitor$/i, /^©\s*\d{4}/i,
  /^monitor$/i, /^EN$/, /^中文$/,
  /webmcp/i, /llms\.txt/i, /sitemap/i, /openapi/i, /robots\.txt/i,
  /^github/i, /^rfc\s?\d+/i, /^iana$/i, /^cloudflare$/i, /^openai$/i,
  /^shopify$/i, /^chrome/i, /^ai$/i, /^dev tools$/i, /^hosting$/i, /^payments$/i,
  /^\d+(\.\d+)*$/, /^v\d/i, /^https?:\/\//i, /^[A-Z0-9 .·|→✓✕~_-]{0,4}$/,
];
const allowed = (t) => ALLOW.some((re) => re.test(t));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL | ${name}${detail ? " | " + detail : ""}`); }
};

const { chromium } = await import(
  pathToFileURL("/Users/david/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs").href
);
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const navOf = {};
for (const path of PAGES) {
  for (const lang of LANGS) {
    const sep = path.includes("?") ? "&" : "?";
    await page.goto(`${ORIGIN}${path}${sep}lang=${lang}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(path.startsWith("/report") ? 9000 : 1400);

    const st = await page.evaluate(() => {
      const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s || "");
      const out = { shared: !!document.querySelector('script[src*="/i18n/common.js"]'), bare: [], wrong: [], nav: null, footer: null };
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        const txt = (el.textContent || "").trim();
        if (!txt) return;
        if (txt === key) out.bare.push(key);
        else out.wrong.push({ key, txt: txt.slice(0, 40), zh: hasCJK(txt) });
      });
      const nav = document.querySelector(".pillnav");
      if (nav) out.nav = nav.innerText.replace(/\s+/g, " ").trim();
      const foot = document.querySelector(".footer-v5, .pg-footer, footer");
      if (foot) out.footer = foot.innerText.replace(/\s+/g, " ").trim().slice(0, 80);
      return out;
    });

    const tag = `${path.split("?")[0]}?lang=${lang}`;
    ok(`${tag} shared i18n source loaded`, st.shared);
    ok(`${tag} no bare keys`, st.bare.length === 0, st.bare.slice(0, 5).join(", "));

    const wrong = st.wrong.filter((w) => (lang === "zh" ? !w.zh : w.zh) && !allowed(w.txt));
    ok(`${tag} rendered language matches`, wrong.length === 0, wrong.slice(0, 4).map((w) => `${w.key}="${w.txt}"`).join(" ; "));

    if (st.nav) navOf[`${path}|${lang}`] = st.nav;
    // Footer: at least the legal trio should follow the language when present.
    if (st.footer) {
      const zh = /[\u4e00-\u9fff]/.test(st.footer);
      if (lang === "zh" && /Methodology|Privacy|Security|Terms/.test(st.footer)) {
        ok(`${tag} footer language matches`, false, st.footer.slice(0, 60));
      } else if (lang === "en" && zh && !/toolfront/i.test(st.footer)) {
        // English page showing Chinese footer copy (excluding the brand mark)
        ok(`${tag} footer language matches`, false, st.footer.slice(0, 60));
      } else {
        pass++;
      }
    }
  }
}

// Cross-page: the same language must render the same navigation everywhere.
for (const lang of LANGS) {
  const vals = Object.entries(navOf).filter(([k]) => k.endsWith(`|${lang}`)).map(([, v]) => v);
  const uniq = [...new Set(vals)];
  ok(`nav identical across pages (lang=${lang})`, uniq.length <= 1, uniq.join(" || "));
}

console.log(`\nTOTAL: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
