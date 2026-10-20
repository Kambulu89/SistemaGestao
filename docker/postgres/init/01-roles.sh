#!/usr/bin/env bash
# Cria as contas e as bases de desenvolvimento/teste. Corre uma única vez no primeiro arranque do
# contentor PostgreSQL (docker-entrypoint-initdb.d) e também serve para preparar uma instância local:
#
#   POSTGRES_USER=postgres SG_OWNER_PASSWORD=... SG_RUNTIME_PASSWORD=... bash docker/postgres/init/01-roles.sh
#
# Duas contas, de propósito:
#   sg_owner   dona das bases e do esquema; só migrations/seeds. Nunca usada em runtime.
#   sg_runtime conta da aplicação: NOSUPERUSER, NOBYPASSRLS, sem CREATE no esquema. É a que a RLS
#              (Fase 1) tem de limitar; se fosse superuser ou dona das tabelas, a RLS seria ignorada.
set -euo pipefail

: "${SG_OWNER_PASSWORD:?defina SG_OWNER_PASSWORD}"
: "${SG_RUNTIME_PASSWORD:?defina SG_RUNTIME_PASSWORD}"
ADMIN_USER="${POSTGRES_USER:-postgres}"
ADMIN_DB="${POSTGRES_DB:-postgres}"
PSQL=(psql -v ON_ERROR_STOP=1 --username "$ADMIN_USER" --dbname "$ADMIN_DB" -X)
[ -n "${PGHOST:-}" ] && export PGHOST

"${PSQL[@]}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sg_owner') THEN
    CREATE ROLE sg_owner LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${SG_OWNER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sg_runtime') THEN
    CREATE ROLE sg_runtime LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD '${SG_RUNTIME_PASSWORD}';
  END IF;
END
\$\$;
SQL

for DB in sistema_gestao sistema_gestao_test; do
  EXISTS=$("${PSQL[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB}'")
  if [ "$EXISTS" != "1" ]; then
    "${PSQL[@]}" -c "CREATE DATABASE ${DB} OWNER sg_owner"
  fi
  "${PSQL[@]}" -d "$DB" <<SQL
REVOKE ALL ON DATABASE ${DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${DB} TO sg_runtime;
ALTER SCHEMA public OWNER TO sg_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
done
echo "Contas e bases preparadas (sg_owner, sg_runtime; sistema_gestao, sistema_gestao_test)."
