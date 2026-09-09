# Production deployment runbook

This application is designed to run behind an HTTPS reverse proxy. The provided
Compose file binds the application only to `127.0.0.1:5173`; do not expose the
Node process or PostgreSQL directly to the internet.

## 1. Prepare secrets and storage

Copy `.env.production.example` to a secret environment file outside source
control. Replace every `REPLACE_...` value. Generate independent values for the
PostgreSQL administrator, application role, bootstrap token, and backup key.
The backup key must be exactly 64 hexadecimal characters and must be stored in a
separate secret manager so backups remain recoverable after host loss.

`OFFSITE_BACKUP_PATH` must be a mounted remote/off-host filesystem. A directory
on the same physical server does not qualify as an off-site backup.

Restrict the environment file to the deployment account (`chmod 600` on Linux).

## 2. Build and initialize

```bash
docker compose --env-file /secure/path/wamy-production.env -f docker-compose.production.yml build
docker compose --env-file /secure/path/wamy-production.env -f docker-compose.production.yml up -d postgres
docker compose --env-file /secure/path/wamy-production.env -f docker-compose.production.yml run --rm app npm run db:init
docker compose --env-file /secure/path/wamy-production.env -f docker-compose.production.yml up -d
```

The application container runs as a non-root user. PostgreSQL is reachable only
on the private container network. The app uses the non-superuser `wamy_app`
role, while the PostgreSQL administrator password is not provided to the app.

## 3. Create the initial administrator

Provision accounts from the application container. Do not put passwords in shell
history; inject them from your deployment secret mechanism.

```bash
docker compose --env-file /secure/path/wamy-production.env -f docker-compose.production.yml run --rm \
  -e USER_EMAIL -e USER_PASSWORD -e USER_NAME -e USER_ROLE=admin -e USER_ORG=wamy \
  app npm run user:create
```

Keep `ALLOW_PUBLIC_SIGNUP=false`. Additional users can be provisioned with the
same command using `USER_ROLE=user` or `USER_ROLE=supervisor`, then managed from
the application by an authorized administrator.

## 4. HTTPS reverse proxy

Configure Caddy, nginx, a cloud load balancer, or an equivalent gateway to:

- serve the `PUBLIC_ORIGIN` hostname with a valid TLS certificate;
- proxy to `http://127.0.0.1:5173`;
- preserve `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`;
- apply request-size and connection timeouts;
- never proxy PostgreSQL publicly.

`PUBLIC_ORIGIN` must exactly match the browser origin and Google OAuth authorized
JavaScript origin. Add only intentional alternate origins to `ALLOWED_ORIGINS`.

## 5. Google Drive

Enable Google Drive API and Google Picker API. Restrict the browser API key to
the production hostname, Google Picker API, and Drive API. Use the narrow
`drive.file` OAuth scope. Store files in an organization-owned Shared Drive with
retention and recovery configured; personal user Drives are not an acceptable
production file archive.

## 6. Backup and restore

The backup service creates an encrypted PostgreSQL custom-format backup every
six hours by default, keeps 30 days, copies each backup to `OFFSITE_BACKUP_PATH`,
and publishes health through `/backups/.backup-status.json`. Set
`BACKUP_ALERT_WEBHOOK` so failed backups notify the operations team.

After the first backup, test recovery into a temporary isolated database:

```bash
docker compose --env-file /secure/path/wamy-production.env -f docker-compose.production.yml \
  --profile operations run --rm restore-test
```

Run this restore test after deployment and at least monthly. Record its
`duration_seconds` as the observed recovery time. The suggested objectives are
RPO <= 6 hours and RTO <= 2 hours. Adjust `BACKUP_INTERVAL_HOURS` for a smaller
RPO. Test Google Drive recovery separately under the organization's retention
policy.

## 7. Monitoring and alerts

Monitor:

- `GET /api/health/live` for process liveness;
- `GET /api/health/ready` for PostgreSQL readiness;
- Docker/container restarts and resource use;
- structured JSON logs from stdout/stderr;
- HTTP 5xx rates, login throttling events, and request latency;
- PostgreSQL connections, disk usage, replication/PITR status if managed;
- backup container health and webhook alerts;
- broken or deleted Google Drive links.

Ship logs to an external, access-controlled log system with retention. The
database audit table is append-only to the application role but is not a
replacement for off-host security logs.

## 8. Deployment verification

Run before every release:

```bash
npm ci
npm run build
npm run db:init
npm run check
npm run test:plans
npm run test:security
npm audit --omit=dev
```

Run integration tests against a staging database, not the production database.
After rollout, verify the readiness endpoint, login, scoped task visibility,
task updates, audit events, Google Drive upload, one encrypted off-site backup,
and one restore test.

## Rollback

Keep the previous immutable application image. Application rollback consists of
restarting that image against the same database. Never reverse a database
migration blindly. Take a backup before migrations and use a tested forward fix
or restore into a separate database when data recovery is required.
