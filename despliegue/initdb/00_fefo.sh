#!/bin/sh
# Primera creación de la base (solo corre si el volumen está vacío): modelo de P3 y extensión del prototipo.
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d fefo -c "ALTER DATABASE fefo SET timezone = 'America/Mexico_City'"
for f in 01_esquema.sql 02_catalogo.sql 06_extension_prototipo.sql; do
  psql -v ON_ERROR_STOP=1 -q -U postgres -d fefo -f "/bd/$f"
done
psql -v ON_ERROR_STOP=1 -U postgres -d fefo -v clave="$APP_DB_PASSWORD" <<'SQL'
ALTER ROLE app_fefo WITH LOGIN PASSWORD :'clave';
ALTER ROLE app_fefo SET search_path = fefo;
GRANT CONNECT ON DATABASE fefo TO app_fefo;
SQL
echo "Base fefo lista. Asigna contraseñas: docker compose exec api node servidor/dist/tareas/usuarios.js --pendientes <contraseña>"
