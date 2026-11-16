@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo Ejecute este archivo con clic derecho ^> Ejecutar como administrador.
  pause & exit /b 1
)
netsh advfirewall firewall add rule name="Bodega Giselle" dir=in action=allow protocol=TCP localport=8080 profile=private
echo.
echo Regla creada (solo redes privadas). Ahora cambie host = 0.0.0.0 en config.ini y reinicie el programa.
pause
