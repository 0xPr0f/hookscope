# Vercel and Railway deployment runbook

This runbook deploys the Vite application and its optional report-storage API to Vercel, with PostgreSQL on Railway. It does not create a server-side analyzer: RPC reads, source retrieval, bytecode analysis, replay, and fuzzing continue to execute in the browser. The only server-side routes append and read completed reports.

```text
Browser -> Vercel CDN (dist/)
        -> Vercel Functions (/api/reports*)
                           |
                           `-> Railway PostgreSQL (TLS, public TCP proxy)
```

Vercel and Railway are separate networks. A Vercel Function cannot use Railway's private `DATABASE_URL`; construct the Vercel secret from Railway's external/TCP-proxy host and port (shown by Railway as `DATABASE_PUBLIC_URL`) and the least-privilege runtime role created below. Keep preview and production on separate databases or Railway environments.

## 1. Deployment boundary

| Variable | Visibility | Purpose |
|---|---|---|
| `DATABASE_URL` | Vercel Functions only | PostgreSQL URL for the runtime role. Set separately for Preview and Production. Never prefix it with `VITE_`. |
| `VITE_RPC_<chainId>` | Public browser bundle | Optional RPC override. Use a public endpoint or a browser/domain-restricted credential. |
| `VITE_GRAPH_API_KEY` | Public browser bundle | One domain-restricted Graph Network key; serves every chain whose subgraph ID is in the registry. |
| `VITE_V4_SUBGRAPH_<chainId>` | Public browser bundle | Optional v4 GraphQL endpoint. Use only browser-safe credentials. |

`VITE_` values are build-time public configuration: anyone can inspect them in the generated JavaScript. Vercel environment changes affect only later deployments, so rebuild after every change. Do not commit `.env.local`, `.env.preview`, `.env.production`, Vercel's `.vercel/` link metadata, or either database URL.

The application works without report storage. In that mode omit `DATABASE_URL`; the report routes return `503`, while browser analysis and local history remain available.

## 2. Prepare PostgreSQL

Create one PostgreSQL service for each environment that will persist reports. Vercel is outside Railway's private network, so keep the database TCP proxy enabled, require TLS, restrict Railway project access, and enable scheduled backups before production traffic. Consider point-in-time recovery when the retention and recovery objectives require it.

Use the Railway-provided owner connection only for migrations and role management. Prompt for it instead of placing it in a shell command or tracked file:

```bash
read -rsp 'Railway migration-owner URL: ' MIGRATION_DATABASE_URL
export MIGRATION_DATABASE_URL
printf '\n'

psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f db/001_analysis_reports.sql
```

Create a dedicated runtime login. The template grants only `CONNECT`, schema `USAGE`, and `SELECT`/`INSERT` on `analysis_reports`; it also assigns short statement, lock, and idle-transaction timeouts.

```bash
read -rsp 'New report-storage runtime password: ' REPORT_STORAGE_PASSWORD
export REPORT_STORAGE_PASSWORD
printf '\n'

psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v runtime_role=report_storage_runtime \
  -f db/runtime-role.example.sql

unset REPORT_STORAGE_PASSWORD MIGRATION_DATABASE_URL
```

The final query must report `can_select = t`, `can_insert = t`, `can_update = f`, and `can_delete = f`. Build the runtime URL with:

- username `report_storage_runtime`;
- the new, URI-encoded runtime password;
- database name, public host, and public port from Railway's external/TCP-proxy URL; and
- TLS enabled (`sslmode=require`).

Store that URL as Vercel's `DATABASE_URL`. Do not give Vercel the owner URL. The API supplies UUIDs itself and needs no sequence privileges.

For later schema changes, add a numbered SQL file, make it backward-compatible with the currently deployed functions, take/verify a backup, and apply it with `psql -X -v ON_ERROR_STOP=1` before releasing dependent code. Do not automatically run owner-level migrations from a public Vercel Function. Prefer expand-and-contract migrations so an application rollback remains compatible with the database.

## 3. Validate locally

Use the repository's pinned pnpm version and verify the configuration, tests, and production bundle:

```bash
corepack enable
pnpm install --frozen-lockfile
node scripts/validate-deployment.mjs
pnpm test
pnpm build
pnpm preview
```

`pnpm preview` serves only the built static application. To exercise Vercel routes locally, link the project and use `vercel dev`; place only local/test credentials in `.env.local`, or pull the Development environment into the ignored local Vercel state. Never test writes against the production database.

```bash
vercel link
vercel pull --environment=development
vercel dev
curl --fail-with-body \
  'http://localhost:3000/api/reports?chainId=1&token=0x0000000000000000000000000000000000000000'
```

## 4. Configure Vercel environments

In Vercel Project Settings, keep Framework Preset set to Vite and let the committed `vercel.json` provide the install, build, output, SPA rewrite, headers, and function duration. Match the Function region to the Railway database region where Vercel plan controls allow it.

Add `DATABASE_URL` as a sensitive project variable to Preview and Production, using different runtime databases. Add each required `VITE_` value to the same targets. Dashboard entry avoids copying secrets into shell history; the equivalent prompting CLI flow is:

```bash
vercel env add DATABASE_URL preview
vercel env add DATABASE_URL production
vercel env add VITE_RPC_1 preview
vercel env add VITE_RPC_1 production
vercel env add VITE_GRAPH_API_KEY preview
vercel env add VITE_GRAPH_API_KEY production
vercel env ls
```

Repeat the chain-ID suffixes actually enabled by the deployment. Add `VITE_V4_SUBGRAPH_<chainId>` only when it is used. Do not add `MIGRATION_DATABASE_URL` or `REPORT_STORAGE_PASSWORD` to Vercel.

## 5. Preview release

Create a preview deployment, retain the printed immutable URL, and run the smoke checks against that URL:

```bash
vercel
export DEPLOYMENT_URL='https://replace-with-preview-url.example'
export STORAGE_HEALTH_PATH='/api/reports?chainId=1&token=0x0000000000000000000000000000000000000000'

curl --fail-with-body "$DEPLOYMENT_URL$STORAGE_HEALTH_PATH"
curl --fail-with-body "$DEPLOYMENT_URL/"
curl --fail-with-body "$DEPLOYMENT_URL/a/non-api/spa-route"
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH "$DEPLOYMENT_URL/api/reports"
```

Expected results are a JSON `200` containing a `history` array, two HTML `200` responses, and `405` for the unsupported method. The sentinel lookup is read-only but exercises the Function, database connection, migration, and runtime `SELECT` privilege; it does not create a separate health API. Also verify the browser console has no worker/Wasm load errors, the response contains the committed cross-origin isolation headers, a deterministic example completes, and an ordinary report lookup succeeds. If Vercel Deployment Protection is enabled, run these checks through an authenticated session or an approved protection-bypass mechanism.

Do not promote when the sentinel storage lookup is `503`: confirm the migration exists, the runtime role has `SELECT`, the external host/port are used, TLS is enabled, the environment target is correct, and a new deployment was built after the variable changed.

## 6. Production release

A staged production build lets the immutable deployment URL be checked before assigning the production domain:

```bash
node scripts/validate-deployment.mjs
pnpm test
pnpm build

vercel --prod --skip-domain
export DEPLOYMENT_URL='https://replace-with-staged-production-url.example'
export STORAGE_HEALTH_PATH='/api/reports?chainId=1&token=0x0000000000000000000000000000000000000000'
curl --fail-with-body "$DEPLOYMENT_URL$STORAGE_HEALTH_PATH"
curl --fail-with-body "$DEPLOYMENT_URL/"
vercel promote "$DEPLOYMENT_URL"
```

After promotion, rerun the storage probe, root, SPA fallback, security-header, deterministic-analysis, report-read, and completed-report persistence checks on the production domain. Review Vercel Function error/latency logs and Railway connection/CPU/storage metrics. Configure external monitoring for the sentinel report lookup; alert on non-`200` responses and sustained function `5xx` rates.

## 7. Limits and perimeter controls

- `POST /api/reports` rejects reports above 2,000,000 bytes. Vercel also imposes its own Function request/response payload limit (currently 4.5 MB). The application check happens after platform body parsing, and `Content-Length` is only a hint; keep the platform limit and test the deployed route after plan/runtime changes.
- The current 12-submissions-per-minute check is an in-memory, per-IP, per-function-instance abuse brake. It resets on cold starts and is not shared between concurrent regions or instances. It is not a production-grade global rate limit.
- Before enabling anonymous public writes at meaningful volume, add a durable/distributed rate limiter or a Vercel Firewall/WAF rule, monitor `413`/`429` rates, and set spend alerts. Authentication or attestations are a separate product decision; the storage proxy does not prove that a submitted report was produced by the browser.
- Function duration is capped at 10 seconds and the runtime database role has an 8-second statement timeout. The client pool is intentionally small, but Vercel concurrency can still create many database connections across instances; monitor Railway connection count and add a compatible pooler if sustained load requires it.
- API responses are same-origin browser resources. Do not add permissive CORS headers unless cross-origin API access is an explicit requirement.

## 8. Rollback and recovery

For a bad application release, immediately move production traffic to the previous known-good deployment, then verify health and logs:

```bash
vercel rollback
vercel rollback status
curl --fail-with-body \
  'https://your-production-domain.example/api/reports?chainId=1&token=0x0000000000000000000000000000000000000000'
```

You can target an eligible deployment with `vercel rollback <deployment-url>`. A Vercel rollback changes routing; it does not rebuild with current environment variables and does not revert PostgreSQL. Undo rollback mode and restore normal promotion with `vercel promote <deployment-url>` after the fix is verified.

If a database migration caused the incident, first restore service with a compatible application deployment. Use a reviewed forward-fix when possible. For destructive corruption, restore a Railway backup or point-in-time recovery into a new database service, validate row counts and report reads, rotate the runtime credential, update Vercel's `DATABASE_URL`, and create a new deployment. Never point production at an unverified restore or assume Vercel rollback changed the database.

## Operator completion checklist

- [ ] Separate preview and production PostgreSQL instances/environments exist.
- [ ] Migration applied with the owner URL; backups and monitoring enabled.
- [ ] Runtime role can only `SELECT` and `INSERT`; Vercel has its TLS public-proxy URL only.
- [ ] All required browser-safe `VITE_` variables are set for Preview and Production.
- [ ] Static validation, tests, and production build pass.
- [ ] Preview smoke tests pass, including workers/Wasm and the sentinel storage lookup.
- [ ] Production staged URL passes before promotion; post-promotion checks pass on the real domain.
- [ ] Global abuse controls, spend alerts, function/database alerts, and a recovery drill are completed before high-volume public writes.

## Platform references

- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)
- [Vercel staged production deployments](https://vercel.com/docs/cli/deploying-from-cli#deploying-a-staged-production-build)
- [Vercel production rollback](https://vercel.com/docs/deployments/rollback-production-deployment)
- [Railway PostgreSQL and external connections](https://docs.railway.com/databases/postgresql)
- [Railway volume backups](https://docs.railway.com/volumes/backups)
- [Railway PostgreSQL point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery)
