# Bodega Giselle — Linux

Sistema de inventario, vencimientos, ventas con código de barras y contabilidad básica.
Solo necesita Python 3.8+ (viene en Debian/Ubuntu). Sin dependencias externas.

## Instalar
```
tar xzf BodegaGiselle-Linux.tar.gz && cd BodegaGiselle-Linux
sudo ./install.sh            # solo accesible desde el propio equipo (recomendado)
sudo ./install.sh --lan      # también desde otras PC/celulares de la red local
```
Abra `http://localhost:8080` y cree el usuario administrador en la primera pantalla.
Volver a ejecutar `install.sh` actualiza el programa sin tocar datos ni configuración.

## Rutas
- Programa: `/opt/bodega-giselle` · Datos: `/var/lib/bodega-giselle` · Config: `/etc/bodega-giselle/config.ini`
- Respaldos automáticos diarios (30): `/var/lib/bodega-giselle/respaldos`
- Servicio: `systemctl status|restart bodega-giselle` · Log: `journalctl -u bodega-giselle -f`

## Respaldos
- Manual: `sudo bodega-respaldo`
- Restaurar: `sudo bodega-restaurar /var/lib/bodega-giselle/respaldos/ARCHIVO.db` (guarda antes una copia de la base actual)
- Copia externa recomendada (otra máquina/disco), por ejemplo con cron:
  `rsync -a /var/lib/bodega-giselle/respaldos/ usuario@otro-equipo:/ruta/`
  Un respaldo que vive solo en el mismo disco no protege contra una falla del disco.

## Mantenimiento remoto (recomendado: Tailscale + SSH)
1. En el servidor: `sudo ./acceso-remoto-tailscale.sh` y aprobar el equipo en su cuenta de Tailscale; instale también Tailscale en su laptop.
2. Instale SSH: `sudo apt install openssh-server`. Use llaves (`ssh-copy-id`) y, cuando funcionen, en `/etc/ssh/sshd_config` ponga `PasswordAuthentication no` y `PermitRootLogin no`.
3. Firewall: `sudo ufw default deny incoming && sudo ufw allow in on tailscale0 && sudo ufw allow from 192.168.0.0/16 to any port 8080 proto tcp` (ajuste su red local; si no usa `--lan` no necesita la última) y `sudo ufw enable`. Cuidado: confirme que la regla de SSH/Tailscale funciona antes de activar ufw.
4. Para ver la aplicación desde su casa sin abrir puertos: `ssh -L 8080:127.0.0.1:8080 usuario@IP-tailscale` y abra `http://localhost:8080`.
No exponga el puerto 8080 directamente a Internet: el programa no usa HTTPS por sí mismo. Si necesita HTTPS, ponga detrás un proxy (Caddy/nginx); la cookie se marca `Secure` automáticamente con `X-Forwarded-Proto: https`.

## Desinstalar
`sudo ./uninstall.sh` (conserva datos) · `sudo ./uninstall.sh --borrar-datos`

## Impresión
Tickets (80 mm) y etiquetas se imprimen desde el navegador (Ctrl+P); elija la impresora térmica en el diálogo. Un lector de código de barras USB funciona como teclado: basta con tener el cursor en la pantalla Vender.
