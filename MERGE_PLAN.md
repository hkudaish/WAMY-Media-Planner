# WAMY Media Planner merger

This project is isolated from the existing WAMY application and uses its own
local PostgreSQL database, `wamy_media_merged`.

## Implemented baseline

- Use the attached Media Project Planner interface and normalized planner
  workflows as the product and UX baseline.
- Origin-based CSRF protection, persistent login throttling, secure server-side
  integrations, immutable auditing, request IDs, validation, transaction
  boundaries, organization scoping, and recoverable soft deletion are enabled.
- Preserve the planner's Gantt view, calendar, Excel task-plan preview/import,
  account activation, granular task updates, and periodic synchronization.
- Preserve the current application's attention engine, responsibility
  comparison, duration monitoring, approvals, and secure Drive workflow.

## Delivery status

1. Consolidated idempotent schema with a recorded production baseline migration.
2. Hardened authentication and authorization with security regression coverage.
3. Preserved planner, import, reporting, and Google Drive workflows.
4. Added a compiled production frontend and non-root container runtime.
5. Added encrypted scheduled backups, restore testing, health checks, and a
   production deployment runbook.

External production infrastructure (DNS, TLS termination, off-site storage,
alert destinations, Google Workspace retention, and log aggregation) must be
configured by the deployment operator as described in `DEPLOYMENT.md`.
