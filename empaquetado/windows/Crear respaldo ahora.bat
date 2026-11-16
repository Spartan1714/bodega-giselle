@echo off
chcp 65001 >nul
cd /d "%~dp0"
call buscar-python.bat
if errorlevel 1 exit /b 1
%PY% app\servidor.py --config "%~dp0config.ini" --respaldo
echo.
echo Los respaldos estan en la carpeta datos\respaldos
echo Copie esa carpeta a una memoria USB regularmente.
pause
