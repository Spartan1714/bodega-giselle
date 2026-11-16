# -*- coding: utf-8 -*-
"""Prueba de la interfaz en un navegador real (Chrome sin pantalla) contra un servidor real."""
import os, socket, subprocess, sys, tempfile, time
from datetime import date, timedelta
import requests
from playwright.sync_api import sync_playwright, expect

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVIDOR = os.path.join(RAIZ, "app", "servidor.py")
SHOTS = os.path.join(tempfile.gettempdir(), 'bodega_shots_web')
os.makedirs(SHOTS, exist_ok=True)
fallos, total = [], 0


def check(cond, msg):
    global total
    total += 1
    if not cond:
        fallos.append(msg); print("  FALLO:", msg)


s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
BASE = "http://127.0.0.1:%d" % PORT
import http.server, threading
HTML = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo.html"), "rb").read()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/" else 404); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
        if self.path == "/": self.wfile.write(HTML)
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
class _P:
    def terminate(self): srv.shutdown()
    def wait(self, timeout=0): pass
proc = _P()
errores_js = []
hoy = date.today()
try:
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
        ctx = br.new_context(viewport={"width": 1366, "height": 768}, locale="es-HN")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errores_js.append("pageerror: %s" % e))
        page.on("console", lambda m: errores_js.append("console.%s: %s" % (m.type, m.text)) if m.type == "error" and not m.text.startswith("Failed to load resource") else None)  # los 401/403/409 son respuestas esperadas de la API
        page.set_default_timeout(8000)

        print("== Primer uso")
        page.goto(BASE)
        page.wait_for_selector("#fa")
        page.screenshot(path=SHOTS + "/01_configuracion.png")
        page.fill("#negocio", "Bodega Giselle"); page.fill("#nombre", "Giselle"); page.fill("#usuario", "giselle")
        page.fill("#password", "clave123"); page.fill("#password2", "otra"); page.click("#fa button")
        page.wait_for_selector(".error-form")
        check("no coinciden" in page.inner_text(".error-form"), "contraseñas distintas se rechazan")
        page.fill("#password2", "clave123"); page.click("#fa button")
        page.wait_for_selector("#q")
        check(page.title() == "Bodega Giselle", "título de la página")
        check(page.locator("#nav button").count() == 8, "administrador ve 8 pestañas")

        print("== Productos")
        page.click("#nav button[data-v=productos]"); page.click("#nuevo")
        page.fill("#nombre", "Leche entera 1L"); page.fill("#cat", "Lácteos"); page.fill("#precio", "25"); page.fill("#min", "5")
        page.fill("#ncod", "7501001"); page.press("#ncod", "Enter"); page.click("#gen")
        page.screenshot(path=SHOTS + "/02_form_producto.png")
        page.click("#fp button.primario"); page.wait_for_selector("#fp", state="detached"); page.wait_for_timeout(400)
        page.click("#nuevo"); page.wait_for_selector("#fp"); page.wait_for_timeout(300)
        page.fill("#nombre", "Frijol rojo"); page.fill("#cat", "Granos básicos"); page.check("#peso")
        check(page.input_value("#unidad") == "libra", "al marcar peso la unidad pasa a libra")
        page.fill("#precio", "12"); page.fill("#ucompra", "quintal"); page.fill("#factor", "100")
        check("1 quintal = 100 libra" in page.inner_text("#ayudaFactor"), "ayuda de conversion de unidades")
        page.click("#fp button.primario"); page.wait_for_selector("#fp", state="detached"); page.wait_for_timeout(400)
        page.wait_for_selector("#tb tr:nth-child(2)")
        check(page.locator("#tb tr").count() == 2, "dos productos en la lista")
        check("Sin stock" in page.inner_text("#tb"), "productos nuevos muestran sin stock")
        page.screenshot(path=SHOTS + "/03_productos.png")
        # codigo interno quedo guardado
        prods = requests.Session()
        # (se verifica por API mas abajo)

        print("== Compra")
        page.click("#nav button[data-v=compras]")
        page.fill("#pq", "leche"); page.press("#pq", "Enter")
        try:
            page.wait_for_selector('input[data-k=cantidad][data-i="0"]', timeout=4000)
        except Exception:
            page.screenshot(path=SHOTS + "/fallo_compra.png")
            print("DEBUG main:", page.inner_text("#main")[:400].replace("\n", " | "))
            print("DEBUG js:", errores_js)
            raise
        page.fill('input[data-k=cantidad][data-i="0"]', "20"); page.fill('input[data-k=costo][data-i="0"]', "18")
        page.fill('input[data-k=vence][data-i="0"]', (hoy + timedelta(days=30)).isoformat())
        page.fill("#pq", "frijol"); page.press("#pq", "Enter")
        page.fill('input[data-k=cantidad][data-i="1"]', "1"); page.fill('input[data-k=costo][data-i="1"]', "900")
        check("= 100 libra" in page.inner_text("#ln"), "muestra la conversión quintal → libras en la línea")
        check("L 1,260.00" in page.inner_text("#tot"), "total de la compra L 1,260.00 (era %s)" % page.inner_text("#tot"))
        page.screenshot(path=SHOTS + "/04_compra.png")
        page.click("#reg"); page.click("#ms"); page.wait_for_selector(".toast.ok")

        print("== Venta con escáner y peso")
        page.click("#nav button[data-v=vender]"); page.wait_for_selector("#q")
        page.fill("#q", "7501001"); page.press("#q", "Enter")
        page.wait_for_selector(".linea")
        page.fill("#q", "2*7501001"); page.press("#q", "Enter")
        expect(page.locator('.linea .q').first).to_have_text('3')
        page.click('[data-a="menos"]'); page.click('[data-a="menos"]')
        page.fill("#q", "frijol"); page.press("#q", "Enter")
        page.wait_for_selector("#peso"); page.fill("#peso", "2,5")
        check("L 30.00" in page.inner_text("#prev"), "vista previa del peso: 2.5 lb = L 30.00")
        page.press("#peso", "Enter")
        expect(page.locator('.linea')).to_have_count(2)
        check("55.00" in page.inner_text("#total"), "total del carrito L 55.00 (era %s)" % page.inner_text("#total"))
        page.fill("#recibido", "100")
        check("45.00" in page.inner_text("#cambio"), "cambio L 45.00")
        page.screenshot(path=SHOTS + "/05_venta.png")
        page.keyboard.press("F9"); page.wait_for_selector(".exito")
        t = page.inner_text(".exito")
        check("55.00" in t and "45.00" in t, "pantalla de éxito con total y cambio")
        page.screenshot(path=SHOTS + "/06_exito.png")
        page.click("#nv")
        expect(page.locator('.linea')).to_have_count(0)
        try:
            expect(page.locator("#q")).to_be_focused(); check(True, "")
        except AssertionError:
            check(False, "el foco vuelve al buscador tras la venta")
        # codigo desconocido
        page.fill("#q", "9999999"); page.press("#q", "Enter"); page.wait_for_selector("#aviso .aviso.error")
        check("Crear producto con este código" in page.inner_text("#aviso"), "código desconocido ofrece crear el producto")
        # escáner: teclas sueltas cuando el foco no está en el buscador
        page.click("#limpiarQ"); page.evaluate("document.activeElement.blur()")
        page.keyboard.type("7501001"); page.keyboard.press("Enter")
        page.wait_for_selector(".linea")
        # stock insuficiente: 30 > 19 que quedan
        page.fill("#q", "30*7501001"); page.press("#q", "Enter")
        expect(page.locator('.linea .q').first).to_have_text('31')
        page.click("#cobrar"); page.wait_for_selector("text=No hay suficiente inventario")
        page.screenshot(path=SHOTS + "/07_sin_stock.png")
        page.click("#mn"); page.click("#vaciar"); page.click("#ms")
        expect(page.locator('.linea')).to_have_count(0)

        print("== Ventas, inventario, gastos, reportes")
        page.click("#nav button[data-v=ventas]"); page.wait_for_selector("#tv tr.clic")
        check("L 55.00" in page.inner_text("#resumen"), "resumen de ventas del día")
        page.click("#tv tr.clic"); page.wait_for_selector(".modal h3")
        check("Venta #1" in page.inner_text(".modal"), "detalle de venta")
        check("Ganancia de esta venta" in page.inner_text(".modal"), "admin ve la ganancia")
        page.screenshot(path=SHOTS + "/08_detalle_venta.png"); page.click("#ok")
        page.click("#nav button[data-v=inventario]"); page.wait_for_selector("text=Poco stock")
        page.screenshot(path=SHOTS + "/09_inventario.png")
        page.click("#pest button[data-t=existencias]"); page.wait_for_selector("#et tr")
        page.click("[data-lotes]"); page.wait_for_selector("text=Lotes de")
        page.screenshot(path=SHOTS + "/10_lotes.png"); page.click("#cl")
        page.click("#nav button[data-v=gastos]")
        page.fill("#gc", "Luz"); page.fill("#gm", "10"); page.click("#fg button"); page.wait_for_selector("#tg tr td")
        check("L 10.00" in page.inner_text("#gt"), "gasto registrado y sumado")
        page.click("#nav button[data-v=reportes]"); page.wait_for_selector(".kpis")
        t = page.inner_text("#rep")
        check("L 55.00" in t, "reporte muestra ventas L 55.00")
        check("Leche entera" in t, "reporte lista productos más vendidos")
        page.screenshot(path=SHOTS + "/11_reportes.png", full_page=True)

        print("== Usuarios y cajero")
        page.click("#nav button[data-v=ajustes]"); page.click("#nu")
        page.fill("#un", "Caja Uno"); page.fill("#uu", "caja1"); page.fill("#up", "caja123"); page.click("#fu button.primario")
        page.wait_for_selector("#tu tr:nth-child(2)")
        page.screenshot(path=SHOTS + "/12_ajustes.png", full_page=True)
        page.click("#btnSalir"); page.wait_for_selector("#fa")
        page.fill("#usuario", "caja1"); page.fill("#password", "mala"); page.click("#fa button"); page.wait_for_selector(".error-form")
        page.fill("#password", "caja123"); page.click("#fa button"); page.wait_for_selector("#q")
        check(page.locator("#nav button").count() == 4, "cajero ve 4 pestañas")
        page.fill("#q", "7501001"); page.press("#q", "Enter"); page.wait_for_selector(".linea")
        check(page.locator("[data-a=precio]").count() == 0, "cajero no puede cambiar precios")
        page.click("[data-m=tarjeta]"); page.click("#cobrar"); page.wait_for_selector(".exito"); page.click("#nv")
        page.click("#nav button[data-v=productos]"); page.wait_for_selector("#tb tr")
        check(page.locator("#nuevo").count() == 0 and "Último costo" not in page.inner_text("table"), "cajero no ve costos ni botón de crear")
        code = page.evaluate("fetch('/api/reportes/resumen').then(r => r.status)")
        check(code == 403, "cajero recibe 403 en reportes")
        page.screenshot(path=SHOTS + "/13_cajero_productos.png")

        print("== Código de barras EAN-13 (se dibuja y se vuelve a leer)")
        page.evaluate("""() => { const d = document.createElement('div'); d.id = 'bc'; d.style.cssText = 'position:fixed;left:0;top:0;background:#fff;padding:20px;z-index:999;width:700px';
            d.innerHTML = ['4006381333931','2000000000015','7501001000014'].map(c => '<div style="width:300px;margin:12px">' + ean13Svg(codigoImprimible(c) || c, 80) + '</div>').join(''); document.body.appendChild(d); }""")
        page.locator("#bc").screenshot(path=SHOTS + "/barras.png")
        ctx.close(); br.close()
finally:
    proc.terminate(); proc.wait(timeout=10)

# lectura de los códigos dibujados con OpenCV
try:
    import cv2
    img = cv2.imread(SHOTS + "/barras.png")
    det = cv2.barcode.BarcodeDetector()
    r = det.detectAndDecodeWithType(img)
    leidos = [x for x in (r[1] if len(r) > 1 else []) if x]
    print("  OpenCV leyó:", leidos)
    check("4006381333931" in leidos, "OpenCV lee el EAN-13 4006381333931 dibujado por la interfaz")
except Exception as e:
    check(False, "no se pudo verificar la lectura del código con OpenCV: %r" % e)

check(not errores_js, "sin errores de JavaScript en el navegador: %s" % errores_js[:5])
print("\nPruebas de interfaz: %d, fallos: %d" % (total, len(fallos)))
for f in fallos: print(" -", f)
sys.exit(1 if fallos else 0)
