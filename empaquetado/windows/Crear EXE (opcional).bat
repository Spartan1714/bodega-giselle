@echo off
chcp 65001 >nul
cd /d "%~dp0"
call buscar-python.bat
if errorlevel 1 exit /b 1
echo Requiere internet (instala PyInstaller). Esto genera BodegaGiselle.exe en la carpeta "dist".
%PY% -m pip install --upgrade pyinstaller
%PY% -m PyInstaller --noconfirm --onefile --name BodegaGiselle --add-data "app\static;static" app\servidor.py
echo.
echo Listo: dist\BodegaGiselle.exe  (copie config.ini junto al .exe y ejecute:  BodegaGiselle.exe --abrir)
pause
