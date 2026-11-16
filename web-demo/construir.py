import os; os.chdir(os.path.dirname(os.path.abspath(__file__)))
import re, base64
import os; R=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','app','static')+'/'
def L(n): return open(R+n,encoding='utf-8').read()
css=L('estilo.css')
icono='data:image/svg+xml;base64,'+base64.b64encode(open(R+'icono.svg','rb').read()).decode()
js=''
for n in ['nucleo.js','caja.js','gestion.js','admin.js']:
    t=L(n).replace('/static/icono.svg',icono)
    assert '</script' not in t
    if n=='nucleo.js':
        t=t.replace("El navegador bloqueó la ventana de impresión. Permita las ventanas emergentes para este sitio.","La impresión no está disponible en la versión web de prueba.")
    js+='\n/* ===== '+n+' ===== */\n'+t
backend=open('backend.js',encoding='utf-8').read()
extra=open('extra.js',encoding='utf-8').read()
extracss=open('extra.css',encoding='utf-8').read()
html=f"""<title>Bodega Giselle</title>
<style>
:root {{ color-scheme: light; }}
{css}
{extracss}
</style>
<div id="app"><p class="cargando">Cargando…</p></div>
<div id="toasts" aria-live="polite"></div>
<div id="demo"></div>
<script>
{backend}
</script>
<script>
{js}
</script>
<script>
{extra}
</script>
"""
open('demo.html','w',encoding='utf-8').write(html)
print(len(html)//1024,'KB')
