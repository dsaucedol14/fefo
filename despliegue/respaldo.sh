#!/bin/sh
# Respaldo diario con pg_dump a disco externo (RNF-12). Programar con cron o el Programador de tareas de Windows.
# Uso: sh respaldo.sh /ruta/al/disco/externo
set -e
DESTINO=${1:?Indica la carpeta de destino}
ARCHIVO="$DESTINO/fefo-$(date +%Y%m%d-%H%M).dump"
docker compose -f "$(dirname "$0")/docker-compose.yml" exec -T bd pg_dump -U postgres -d fefo -Fc > "$ARCHIVO"
echo "Respaldo: $ARCHIVO"
# Restaurar (PE-12):  docker compose exec -T bd pg_restore -U postgres -d fefo --clean --if-exists < archivo.dump
