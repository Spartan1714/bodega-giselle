@echo off
cd /d "%~dp0"
call buscar-python.bat
if errorlevel 1 exit /b 1
%PY% app\servidor.py --config "%~dp0config.ini"
