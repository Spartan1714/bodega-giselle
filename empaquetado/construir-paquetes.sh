#!/usr/bin/env bash
# Genera BodegaGiselle-Windows.zip y BodegaGiselle-Linux.tar.gz en ./salida
set -euo pipefail
cd "$(dirname "$0")"; rm -rf salida tmp; mkdir -p salida tmp/BodegaGiselle-Windows tmp/BodegaGiselle-Linux
cp -r windows/. tmp/BodegaGiselle-Windows/; cp -r linux/. tmp/BodegaGiselle-Linux/
cp -r ../app tmp/BodegaGiselle-Windows/app; cp -r ../app tmp/BodegaGiselle-Linux/app
find tmp -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
(cd tmp && zip -qr ../salida/BodegaGiselle-Windows.zip BodegaGiselle-Windows && tar czf ../salida/BodegaGiselle-Linux.tar.gz BodegaGiselle-Linux)
rm -rf tmp; ls -l salida
