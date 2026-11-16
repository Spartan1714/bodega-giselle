@echo off
chcp 65001 >nul
cd /d "%~dp0"
call buscar-python.bat
if errorlevel 1 exit /b 1
schtasks /Create /F /TN "Bodega Giselle" /SC ONLOGON /TR "wscript.exe \"%~dp0segundo-plano.vbs\"" /RL LIMITED
if errorlevel 1 (
  echo No se pudo crear la tarea. Pruebe con clic derecho ^> Ejecutar como administrador.
  pause & exit /b 1
)
echo.
echo Listo: Bodega Giselle se iniciara sola (sin ventana) cada vez que inicie sesion en Windows.
echo Para usarla abra el navegador en  http://localhost:8080
echo Para quitar el inicio automatico use "Quitar inicio automatico.bat".
schtasks /Run /TN "Bodega Giselle" >nul 2>&1
pause
