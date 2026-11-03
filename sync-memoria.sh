#!/usr/bin/env bash
# La configuración de la memoria compartida (web/memory/memory.config.js) es la
# de Claw, BYTE A BYTE: marca, página almacén, orígenes de las apps, espacio de
# nombres y colores viven en un solo sitio (el repo de Claw) y aquí solo se
# copian. Si las dos copias difieren, Code hablaría con otra memoria (otro
# espacio de nombres, otra página almacén) o con otra lista de apps.
#
#   ./sync-memoria.sh [ruta/a/claw]            copia la de Claw aquí
#   ./sync-memoria.sh [ruta/a/claw] --revisa   solo comprueba (sale 1 si difieren
#                                              o si no encuentra la de Claw)
#
# deploy.sh lo llama con --revisa: no se despliega una config que no sea la de Claw.
set -euo pipefail
cd "$(dirname "$0")"
REVISA=0; CLAW=${CLAW:-../elffuss-claw}
for a in "$@"; do if [ "$a" = "--revisa" ]; then REVISA=1; else CLAW="$a"; fi; done
ORIGEN="$CLAW/web/memory/memory.config.js"
DESTINO=web/memory/memory.config.js
[ -f "$ORIGEN" ] || { echo "✗ no encuentro la config de la memoria de Claw en $ORIGEN (pasa la ruta del checkout de Claw, o CLAW=…)"; exit 1; }
suma() { shasum -a 256 "$1" | cut -d' ' -f1; }
if [ "$REVISA" = 1 ]; then
  if [ -f "$DESTINO" ] && [ "$(suma "$ORIGEN")" = "$(suma "$DESTINO")" ]; then
    echo "✔ config de la memoria = la de Claw ($(suma "$DESTINO" | cut -c1-12))"; exit 0
  fi
  echo "✗ $DESTINO no es la de Claw ($ORIGEN). ./sync-memoria.sh para copiarla." >&2; exit 1
fi
mkdir -p web/memory
cp "$ORIGEN" "$DESTINO"
echo "✳ config de la memoria copiada de Claw ($(suma "$DESTINO" | cut -c1-12))"
