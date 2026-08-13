-- Run with psql after db/001_analysis_reports.sql, using the Railway migration
-- owner connection. This creates/rotates a login that can only read and append
-- reports. Keep REPORT_STORAGE_PASSWORD out of shell history and CI logs.
--
--   export REPORT_STORAGE_PASSWORD='<generated-secret>'
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
--     -v runtime_role=report_storage_runtime -f db/runtime-role.example.sql
--   unset REPORT_STORAGE_PASSWORD

\if :{?runtime_role}
\else
  \set runtime_role report_storage_runtime
\endif

\getenv runtime_password REPORT_STORAGE_PASSWORD
\if :{?runtime_password}
\else
  \echo 'REPORT_STORAGE_PASSWORD must be set in the process environment.'
  \quit 1
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'runtime_role', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'runtime_role',
  :'runtime_password'
)
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role')
\gexec
SELECT format('GRANT SELECT, INSERT ON TABLE public.analysis_reports TO %I', :'runtime_role')
\gexec

-- These role defaults bound accidental long-running work independently of the
-- function timeout. Values are deliberately conservative for the storage-only API.
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'runtime_role', '8s')
\gexec
SELECT format('ALTER ROLE %I SET lock_timeout = %L', :'runtime_role', '3s')
\gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'runtime_role', '10s')
\gexec

SELECT
  :'runtime_role' AS runtime_role,
  has_table_privilege(:'runtime_role', 'public.analysis_reports', 'SELECT') AS can_select,
  has_table_privilege(:'runtime_role', 'public.analysis_reports', 'INSERT') AS can_insert,
  has_table_privilege(:'runtime_role', 'public.analysis_reports', 'UPDATE') AS can_update,
  has_table_privilege(:'runtime_role', 'public.analysis_reports', 'DELETE') AS can_delete;
