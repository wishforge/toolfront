-- Public scan history (scoring-history feature, 2026-09-03).
-- Append-only ledger of SUCCESSFUL public scans, one row per recorded scan.
-- Privacy contract (see public/privacy.html "Public scan history"):
--   * no scanner identity ever — no IP, no account, no email
--   * domain + score + grade + per-check statuses + scoring version + time
--   * rows are public on the report page and in rankings
--   * retention: 50 newest rows per domain or 12 months (pruned in code)
--   * removal for domain owners: file/DNS challenge verified via support
CREATE TABLE IF NOT EXISTS scan_history (
  domain TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,              -- epoch milliseconds
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  scoring_version TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'    -- { checks: [{id,status,points,max}] } — no PII
);
CREATE INDEX IF NOT EXISTS idx_scan_history_domain_time
  ON scan_history(domain, scanned_at DESC);
