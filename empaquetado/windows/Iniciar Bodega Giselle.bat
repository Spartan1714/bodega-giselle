@echo off
chcp 65001 >nul
title Bodega Giselle
cd /d "%~dp0"
call buscar-python.bat
if errorlevel 1 exit /b 1
echo Iniciando Bodega Giselle... (no cierre esta ventana mientras trabaja)
echo.
%PY% app\servidor.py --config "%~dp0config.ini" --abrir
if errorlevel 1 (
  echo.
  echo El programa se cerro con un error. Revise datos\bodega.log
  pause
)
