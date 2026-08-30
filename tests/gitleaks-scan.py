#!/usr/bin/env python3
"""Gitleaks-equivalent full-history secret scan (no external dependency).

v2 fixes from v1's false positives:
- only scans objects of type blob (v1 also matched tree/commit objects, whose
  contents are lists of 40-char SHA-1s — those matched the "40 alphanumeric
  chars" Cloudflare-token rule and produced 419 bogus hits)
- token rules are context-anchored (assignment / prefix) instead of bare
  "40 alphanumerics", which is indistinguishable from a git SHA
"""
import re
import subprocess
import sys

REPO = sys.argv[1] if len(sys.argv) > 1 else "."

# Context-anchored: a bare 40-char string is a git SHA, not evidence of a token.
RULES = [
    ("Resend API Key",            re.compile(r"\bre_[A-Za-z0-9]{20,}\b")),
    ("Cloudflare API Token",      re.compile(r"(?i)cloudflare[_-]?api[_-]?token['\"\s:=]{1,6}[A-Za-z0-9_-]{40}")),
    ("Wrangler secret value",     re.compile(r"(?i)(?:wrangler secret put|--secret)\s+[A-Z_]+[^\n]{0,40}?['\"][A-Za-z0-9_/-]{20,}['\"]")),
    ("AWS Access Key ID",         re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("GitHub Token",              re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("Slack Token",               re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Private Key Block",         re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("Generic secret assignment", re.compile(r"(?i)\b(?:secret|api[_-]?key|passwd|password)\b\s*[:=]\s*['\"][A-Za-z0-9+/=_-]{16,}['\"]")),
    ("JWT-like",                  re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
]

ALLOWLIST_PATH = re.compile(r"(node_modules|\.map\b|LICENSE|package-lock\.json|\.woff2?$|\.png$|\.svg$)")


def sh(args, binary=False):
    r = subprocess.run(args, cwd=REPO, capture_output=True)
    return r.stdout if binary else r.stdout.decode("utf-8", errors="replace")


# object name -> path (for reporting), only for objects reachable from refs
paths = {}
for line in sh(["git", "rev-list", "--objects", "--all"]).splitlines():
    parts = line.split(" ", 1)
    if len(parts) == 2:
        paths[parts[0]] = parts[1]

# only blobs
blobs = []
for line in sh(["git", "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]).splitlines():
    o, t = line.split()
    if t == "blob":
        blobs.append(o)

commits = sh(["git", "rev-list", "--count", "--all"]).strip()
print(f"扫描 {len(blobs)} 个 blob（全历史 {commits} 个提交，含已重写前的悬空对象）\n")

findings, seen = [], set()
for sha in blobs:
    path = paths.get(sha, "(unreachable/dangling)")
    if ALLOWLIST_PATH.search(path):
        continue
    raw = sh(["git", "cat-file", "-p", sha], binary=True)
    if not raw or b"\0" in raw[:400]:
        continue
    blob = raw.decode("utf-8", errors="replace")
    for name, rx in RULES:
        for m in rx.finditer(blob):
            ln = blob[:m.start()].count("\n") + 1
            key = (name, path, m.group(0)[:40])
            if key in seen:
                continue
            seen.add(key)
            findings.append((name, path, ln, m.group(0)[:70]))

if not findings:
    print("✅ 全历史零密钥命中")
else:
    print(f"🔴 命中 {len(findings)} 处：")
    for name, path, ln, snip in findings[:40]:
        print(f"  [{name}] {path}:{ln} → {snip}")

print("\n─── 敏感文件是否误入版本库 ───")
tracked = set(sh(["git", "ls-files"]).split())
for f in [".dev.vars", "token.key", "resend.md", ".env", ".wrangler"]:
    print(f"  {f:12} {'⚠ 已入库！' if f in tracked else '✓ 未入库'}")

print("\n─── 配置文件中是否含密钥明文 ───")
for f in ["wrangler.toml", "package.json"]:
    try:
        content = open(f"{REPO}/{f}", encoding="utf-8").read()
    except OSError:
        continue
    hits = [n for n, rx in RULES if rx.search(content)]
    print(f"  {f:14} {'🔴 ' + ', '.join(hits) if hits else '✓ 无密钥'}")
