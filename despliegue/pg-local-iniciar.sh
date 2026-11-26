#!/bin/sh
# Arranca el PostgreSQL 16 local de Postgres.app para desarrollar fefo en esta Mac (sin Docker).
# Cluster dedicado en ~/Library/Application Support/Postgres/var-fefo-16, puerto 5433,
# superusuario "postgres" / contraseña "fefo-dev" (mismos valores que esperaba el "docker run" original).
set -e
PGBIN="/Applications/Postgres.app/Contents/Versions/16/bin"
DATADIR="$HOME/Library/Application Support/Postgres/var-fefo-16"
"$PGBIN/pg_ctl" -D "$DATADIR" -l "$DATADIR/logfile" -w start
