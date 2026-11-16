#!/usr/bin/env bash
# Instala Tailscale (VPN privada) para mantenimiento remoto. Requiere internet. Ejecutar con sudo.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Ejecute con sudo"; exit 1; }
echo "Esto descarga e instala el script oficial de https://tailscale.com/install.sh"
read -r -p "Continuar? [s/N] " r; [ "$r" = "s" ] || exit 0
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
echo "Listo. Con 'tailscale ip -4' vera la direccion privada para conectarse por SSH desde su equipo."
