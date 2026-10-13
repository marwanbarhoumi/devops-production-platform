#!/bin/sh
# Runs once, when the PostgreSQL data volume is first initialised
# (official image: /docker-entrypoint-initdb.d). It creates one least-privilege
# role and one database per service so each service owns its own data.
#
# Passwords come from environment variables and are passed as psql variables,
# so they never appear in this file or in the image.
set -eu

: "${PRODUCT_DB_PASSWORD:?PRODUCT_DB_PASSWORD must be set}"
: "${ORDER_DB_PASSWORD:?ORDER_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set product_pw="$PRODUCT_DB_PASSWORD" \
  --set order_pw="$ORDER_DB_PASSWORD" <<'EOSQL'
CREATE ROLE product_svc WITH LOGIN PASSWORD :'product_pw';
CREATE ROLE order_svc WITH LOGIN PASSWORD :'order_pw';

CREATE DATABASE products_db OWNER product_svc;
CREATE DATABASE orders_db OWNER order_svc;

-- Services may only connect to their own database.
REVOKE ALL ON DATABASE products_db FROM PUBLIC;
REVOKE ALL ON DATABASE orders_db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE products_db TO product_svc;
GRANT CONNECT, TEMPORARY ON DATABASE orders_db TO order_svc;
EOSQL

echo "Created databases products_db (owner product_svc) and orders_db (owner order_svc)"
