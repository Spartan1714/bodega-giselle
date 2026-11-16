@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "datos\servidor.pid" (
  echo Bodega Giselle no parece estar abierta.
  pause & exit /b 0
)
set /p PID=<"datos\servidor.pid"
taskkill /PID %PID% /F >nul 2>&1
del "datos\servidor.pid" >nul 2>&1
echo Bodega Giselle detenida.
pause
