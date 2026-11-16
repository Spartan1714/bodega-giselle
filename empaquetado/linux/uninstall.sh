#!/usr/bin/env bash
# Desinstala Bodega Giselle. Conserva los datos salvo que use --borrar-datos
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Ejecute con sudo"; exit 1; }
systemctl disable --now bodega-giselle 2>/dev/null || true
rm -f /etc/systemd/system/bodega-giselle.service /usr/local/bin/bodega-respaldo /usr/local/bin/bodega-restaurar
rm -rf /opt/bodega-giselle
systemctl daemon-reload
if [ "${1:-}" = "--borrar-datos" ]; then
  rm -rf /var/lib/bodega-giselle /etc/bodega-giselle
  userdel bodega 2>/dev/null || true
  echo "Todo eliminado, incluidos los datos."
else
  echo "Programa eliminado. Los datos siguen en /var/lib/bodega-giselle (use --borrar-datos para eliminarlos)."
fi
