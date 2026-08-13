CREATE TABLE IF NOT EXISTS analysis_reports (
  id UUID PRIMARY KEY,
  report_hash TEXT NOT NULL UNIQUE CHECK (report_hash ~ '^0x[0-9a-f]{64}$'),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token TEXT NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  block_number NUMERIC(78, 0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]+$'),
  pool_hook_identity TEXT[] NOT NULL,
  adapter_version TEXT NOT NULL,
  engine_versions JSONB NOT NULL,
  scenario_version TEXT NOT NULL,
  severity_counts JSONB NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT completed_reports_only CHECK (
    report->>'status' = 'completed'
    AND report->>'partial' = 'false'
    AND report->>'source' = 'browser'
  )
);

CREATE INDEX IF NOT EXISTS analysis_reports_identity_created
  ON analysis_reports (chain_id, token, created_at DESC);

CREATE INDEX IF NOT EXISTS analysis_reports_block_identity
  ON analysis_reports (chain_id, token, block_hash);

-- The application role should receive SELECT and INSERT only. No update/delete
-- endpoint exists; migrations remain owned by a separate Railway role.
