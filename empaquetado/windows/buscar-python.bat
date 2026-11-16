@echo off
rem Busca Python 3.8 o mayor. Deja el comando en la variable PY. (Uso interno)
set "PY="
for %%C in ("py -3" "python" "python3") do (
  if not defined PY (
    %%~C -c "import sys; sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>&1
    if not errorlevel 1 set "PY=%%~C"
  )
)
if not defined PY (
  echo.
  echo  No se encontro Python 3.8 o mayor en esta computadora.
  echo  Descarguelo gratis de https://www.python.org/downloads/ y durante la
  echo  instalacion marque la casilla "Add python.exe to PATH". Luego abra este
  echo  programa otra vez.
  echo.
  pause
  exit /b 1
)
exit /b 0
