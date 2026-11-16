#!/usr/bin/env bash
# Instalador de Bodega Giselle para Linux (systemd). Ejecutar como root:  sudo ./install.sh [--lan] [--puerto N]
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/bodega-giselle
DATOS=/var/lib/bodega-giselle
CONF=/etc/bodega-giselle/config.ini
LAN=0; PUERTO=8080
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) LAN=1;;
    --puerto) PUERTO="${2:?falta el numero}"; shift;;
    *) echo "Opcion desconocida: $1"; exit 1;;
  esac; shift
done
[ "$(id -u)" -eq 0 ] || { echo "Ejecute con sudo: sudo ./install.sh"; exit 1; }
command -v systemctl >/dev/null || { echo "Se requiere systemd."; exit 1; }
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "Instale Python 3 (sudo apt install python3)"; exit 1; }
"$PY" -c 'import sys,sqlite3; sys.exit(0 if sys.version_info>=(3,8) else 1)' || { echo "Se requiere Python 3.8 o mayor con sqlite3."; exit 1; }

id bodega >/dev/null 2>&1 || useradd --system --home "$DATOS" --shell /usr/sbin/nologin bodega
install -d -o bodega -g bodega -m 750 "$DATOS"
install -d -m 755 "$DEST" /etc/bodega-giselle
rm -rf "$DEST/app"
cp -r "$AQUI/app" "$DEST/app"
find "$DEST/app" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
chown -R root:root "$DEST"; chmod -R go-w "$DEST"

if [ ! -f "$CONF" ]; then
  HOST=127.0.0.1; [ "$LAN" -eq 1 ] && HOST=0.0.0.0
  cat > "$CONF" <<CFG
[servidor]
host = $HOST
puerto = $PUERTO

[datos]
carpeta = $DATOS
respaldos_dias = 30

[negocio]
nombre = Bodega Giselle
moneda = L

[seguridad]
horas_sesion = 12
CFG
  echo "Configuracion creada en $CONF"
else
  echo "Se conserva la configuracion existente: $CONF"
fi
chmod 644 "$CONF"

cat > /etc/systemd/system/bodega-giselle.service <<UNIT
[Unit]
Description=Bodega Giselle (inventario y ventas)
After=network.target

[Service]
Type=simple
User=bodega
Group=bodega
ExecStart=$PY $DEST/app/servidor.py --config $CONF
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATOS
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

# Comandos utiles
cat > /usr/local/bin/bodega-respaldo <<SH
#!/usr/bin/env bash
exec sudo -u bodega $PY $DEST/app/servidor.py --config $CONF --respaldo
SH
cat > /usr/local/bin/bodega-restaurar <<SH
#!/usr/bin/env bash
# Uso: sudo bodega-restaurar /var/lib/bodega-giselle/respaldos/ARCHIVO.db
[ -n "\${1:-}" ] || { echo "Uso: sudo bodega-restaurar ARCHIVO.db"; exit 1; }
systemctl stop bodega-giselle
sudo -u bodega $PY $DEST/app/servidor.py --config $CONF --restaurar "\$1"
systemctl start bodega-giselle
SH
chmod 755 /usr/local/bin/bodega-respaldo /usr/local/bin/bodega-restaurar

systemctl daemon-reload
systemctl enable --now bodega-giselle
sleep 2
if systemctl is-active --quiet bodega-giselle; then
  P=$(grep -E '^puerto' "$CONF" | head -1 | sed 's/.*= *//')
  echo; echo "Bodega Giselle esta funcionando: http://localhost:${P}"
  echo "Estado:  systemctl status bodega-giselle      Registro: journalctl -u bodega-giselle -f"
else
  echo "El servicio no arranco. Revise: journalctl -u bodega-giselle -n 50"; exit 1
fi
