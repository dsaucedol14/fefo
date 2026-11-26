#!/bin/sh
# Detiene el PostgreSQL 16 local de Postgres.app usado para desarrollar fefo en esta Mac.
set -e
PGBIN="/Applications/Postgres.app/Contents/Versions/16/bin"
DATADIR="$HOME/Library/Application Support/Postgres/var-fefo-16"
"$PGBIN/pg_ctl" -D "$DATADIR" stop
