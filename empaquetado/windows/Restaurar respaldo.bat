@echo off
chcp 65001 >nul
cd /d "%~dp0"
call buscar-python.bat
if errorlevel 1 exit /b 1
echo Detenga primero el programa ("Detener Bodega Giselle.bat").
echo Arrastre aqui el archivo de respaldo (.db) desde datos\respaldos y presione Enter:
set /p ARCH=
%PY% app\servidor.py --config "%~dp0config.ini" --restaurar %ARCH%
pause
