#!/bin/sh
set -eu

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "APP_DB_PASSWORD is required" >&2
  exit 1
fi

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$APP_DB_PASSWORD" <<-'EOSQL'
SELECT format('CREATE ROLE wamy_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wamy_app') \gexec
ALTER ROLE wamy_app PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT, CREATE ON DATABASE wamy_media TO wamy_app;
GRANT USAGE, CREATE ON SCHEMA public TO wamy_app;
EOSQL
