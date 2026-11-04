#!/usr/bin/env sh
# Cria as contas da aplicação numa instância PostgreSQL local (Docker ou CI). Idempotente.
#   app_owner: dona do esquema, só migrações; BYPASSRLS para manutenção e fixtures de teste.
#   app:       conta de runtime: só DML, sem superuser, sem BYPASSRLS (a RLS aplica-se sempre).
# Variáveis: DB_PASSWORD, DB_OWNER_PASSWORD, DATABASES (ex.: "app app_test"). Usa a ligação psql por omissão (PG*).
set -eu
: "${DB_PASSWORD:?defina DB_PASSWORD}"
: "${DB_OWNER_PASSWORD:?defina DB_OWNER_PASSWORD}"
DATABASES="${DATABASES:-app}"

psql -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner LOGIN BYPASSRLS PASSWORD '${DB_OWNER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${DB_PASSWORD}';
  END IF;
END \$\$;
SQL

for db in $DATABASES; do
  psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 \
    || psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $db OWNER app_owner"
  psql -v ON_ERROR_STOP=1 -d "$db" -c "ALTER SCHEMA public OWNER TO app_owner" \
    -c "REVOKE ALL ON SCHEMA public FROM PUBLIC" -c "GRANT USAGE ON SCHEMA public TO app"
done
