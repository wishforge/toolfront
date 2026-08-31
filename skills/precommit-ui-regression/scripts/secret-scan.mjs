#!/usr/bin/env node
/**
 * secret-scan.mjs - pre-commit secret scan (second gate of the precommit-ui-regression skill)
 *
 * Scans all "pending" files in the working tree:
 *   - git tracked but modified files (git diff --name-only)
 *   - untracked new files (git status --porcelain ?? entries)
 * Detects:
 *   - hardcoded keys/tokens (known prefixes: AWS/OpenAI/GitHub/Slack, etc.)
 *   - private key blocks (BEGIN ... PRIVATE KEY)
 *   - credentialed connection strings (postgres://user:pass@...)
 *   - generic sensitive fields (api_key / secret / token = <value>)
 *   - ToolFront-specific: real KV ids (32-hex in wrangler.toml / .dev.vars)
 * Any hit -> exit 1 (blocks commit); all clean -> exit 0
 *
 * Usage: node secret-scan.mjs [--repo <git repo path>] [--strict]
 *   --strict  treat suspicious-but-low-confidence patterns as failures too (default: only high confidence fails)
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : ".";
const strict = process.argv.includes("--strict");

// ---------- high-confidence patterns (hit = fail) ----------
const HIGH_CONFIDENCE = [
  // cloud/vendor key prefixes
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS secret key", re: /(?:aws_secret_access_key|AWS_SECRET)\s*[:=]\s*["']?[A-Za-z0-9\/+=]{40}/ },
  { name: "OpenAI/Stripe-style key", re: /\b(sk|pk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "GitHub PAT", re: /\bghp_[A-Za-z0-9]{36,}/ },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "Stripe secret", re: /\bsk_live_[0-9a-zA-Z]{24,}/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "credentialed connection string", re: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s:@\/]+:[^\s@\/]+@/ },
  { name: "Firebase service account", re: /"private_key_id"\s*:\s*"[0-9a-f]{40}"/ },
];

// ---------- low-confidence (only --strict fails) ----------
const LOW_CONFIDENCE = [
  { name: "generic api_key field", re: /\b(?:api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{16,}/i },
  { name: "generic password field", re: /\bpassword\s*[:=]\s*["'][^"']{6,}["']/i },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/ },
];

// ---------- filename blacklist (present in pending list = fail) ----------
const FILENAME_BLACKLIST = [
  /\.env(\.\w+)?$/i,          // .env, .env.local
  /\.dev\.vars(\.\w+)?$/i,    // Cloudflare .dev.vars
  /id_rsa$|id_ed25519$|\.pem$/i,
  /credentials\.json$|service-account.*\.json$/i,
];

// ---------- ToolFront-specific: real KV/D1 ids in wrangler.toml ----------
const CLOUDFLARE_IDS = [
  { name: "real KV namespace id", re: /[0-9a-f]{32}/, file: /wrangler\.toml$|\.dev\.vars$/ },
];

// ---------- utils ----------
const findings = [];
function record(file, lineNo, name, snippet) {
  findings.push({ file, lineNo, name, snippet });
}

function scanText(file, text) {
  const lines = text.split("\n");
  const isCfConfig = /wrangler\.toml$|\.dev\.vars$/.test(file);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of HIGH_CONFIDENCE) {
      if (p.re.test(line)) record(file, i + 1, p.name, truncate(line));
    }
    if (strict) {
      for (const p of LOW_CONFIDENCE) {
        if (p.re.test(line)) record(file, i + 1, p.name + " [low]", truncate(line));
      }
    }
    if (isCfConfig) {
      // skip comment lines and placeholder values (REQUIRED for production, etc.)
      const trimmed = line.trim();
      if (!trimmed.startsWith("#") && !/REQUIRED|TODO|placeholder|your-|xxx|example/i.test(line)) {
        for (const p of CLOUDFLARE_IDS) {
          // wrangler.toml KV binding is id = "..." - check the value inside quotes
          const m = line.match(/(?:id|namespace_id|database_id|account_id)\s*=\s*"([0-9a-f]{32})"/i);
          if (m) record(file, i + 1, p.name + " (" + m[1].slice(0, 8) + "...)", truncate(line));
        }
      }
    }
  }
}

function truncate(s, n = 80) {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n) + "..." : t;
}

// ---------- collect pending files ----------
function collectFiles() {
  const files = new Set();
  try {
    const modified = execSync(`git -C "${repo}" diff --name-only --diff-filter=ACMRT`, { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const f of modified) files.add(f);
  } catch (_) {}
  try {
    const staged = execSync(`git -C "${repo}" diff --cached --name-only --diff-filter=ACMRT`, { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const f of staged) files.add(f);
  } catch (_) {}
  try {
    const untracked = execSync(`git -C "${repo}" status --porcelain`, { encoding: "utf8" })
      .split("\n")
      .filter(l => l.startsWith("??"))
      .map(l => l.slice(3).trim())
      .filter(Boolean);
    for (const f of untracked) files.add(f);
  } catch (_) {}
  return [...files];
}

// ---------- main flow ----------
console.log(`🔍 secret scan: ${repo}`);
const files = collectFiles();
console.log(`   pending files: ${files.length}`);

if (files.length === 0) {
  console.log("✓ No pending files, skip");
  process.exit(0);
}

// 1. filename blacklist
for (const f of files) {
  for (const bl of FILENAME_BLACKLIST) {
    if (bl.test(f)) record(f, 0, "sensitive filename: " + f, "(filename itself leaks)");
  }
}

// 2. content scan (skip binary / oversized files)
for (const f of files) {
  const full = join(repo, f);
  if (!existsSync(full)) continue;
  try {
    const st = statSync(full);
    if (st.size > 2 * 1024 * 1024) continue; // skip >2MB
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // binary
    scanText(f, buf.toString("utf8"));
  } catch (_) {}
}

// 3. summary
if (findings.length) {
  console.log(`\n✗ ${findings.length} secret(s) found, commit blocked:`);
  for (const fd of findings) {
    console.log(`  [${fd.file}${fd.lineNo ? ":" + fd.lineNo : ""}] ${fd.name}`);
    console.log(`    ${fd.snippet}`);
  }
  console.log(`\nHow to resolve:`);
  console.log(`  - Real secret: remove from code, use env vars / local .dev.vars (gitignored)`);
  console.log(`  - Placeholder/test value: confirm harmless, git add then re-run; use --strict to separate low-confidence items`);
  process.exit(1);
}

console.log("✓ No secrets found, safe to commit");
process.exit(0);
