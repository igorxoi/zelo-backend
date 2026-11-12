#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${PGTEST_DB:-zelo_test}"
psql -d postgres -qX -c "drop database if exists ${DB}" -c "create database ${DB}"
psql -d "${DB}" -qX -v ON_ERROR_STOP=1 -f database/schema.sql
PGTEST_DB="${DB}" node --import tsx --test test/*.test.ts
