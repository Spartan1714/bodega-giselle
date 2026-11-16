# -*- coding: utf-8 -*-
"""Pruebas de extremo a extremo del servidor (arranca un servidor real con datos temporales)."""
import concurrent.futures
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import date, timedelta

import requests

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVIDOR = os.path.join(RAIZ, "app", "servidor.py")

fallos = []
total = 0


def check(cond, msg):
    global total
    total += 1
    if not cond:
        fallos.append(msg)
        print("  FALLO:", msg)


def puerto_libre():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


datos = tempfile.mkdtemp(prefix="bodega-test-")
PORT = puerto_libre()
BASE = "http://127.0.0.1:%d" % PORT


def arrancar():
    p = subprocess.Popen([sys.executable, "-I", SERVIDOR, "--datos", datos, "--puerto", str(PORT), "--config", "/nonexistent"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            requests.get(BASE + "/api/estado", timeout=1)
            return p
        except requests.ConnectionError:
            time.sleep(0.1)
    p.terminate()
    raise SystemExit("El servidor no arranco:\n" + p.stdout.read().decode())


def api(s, metodo, ruta, **kw):
    return s.request(metodo, BASE + ruta, timeout=20, **kw)


proc = arrancar()
hoy = date.today()
try:
    A = requests.Session()  # administrador

    print("== Acceso")
    r = api(A, "GET", "/api/estado").json()
    check(r["configurado"] is False, "sistema nuevo sin configurar")
    check(api(A, "GET", "/api/productos").status_code == 401, "productos exige sesion")
    check(api(A, "POST", "/api/setup", json={"negocio": "Bodega Giselle", "nombre": "Giselle", "usuario": "giselle", "password": "123"}).status_code == 400,
          "contrasena corta rechazada")
    r = api(A, "POST", "/api/setup", json={"negocio": "Bodega Giselle", "nombre": "Giselle", "usuario": "giselle", "password": "clave123", "moneda": "L"})
    check(r.status_code == 200 and r.json()["usuario"]["rol"] == "admin", "setup crea administrador")
    check(api(requests.Session(), "POST", "/api/setup", json={"negocio": "X", "nombre": "X", "usuario": "otro", "password": "clave123"}).status_code == 409,
          "setup no se puede repetir")
    check("HttpOnly" in r.headers.get("Set-Cookie", "") and "SameSite=Strict" in r.headers.get("Set-Cookie", ""), "cookie HttpOnly y SameSite")
    check(api(A, "GET", "/api/estado").json()["usuario"]["usuario"] == "giselle", "sesion activa tras setup")

    print("== Productos")
    r = api(A, "POST", "/api/productos", json={"nombre": "Leche entera 1L", "categoria": "Lácteos", "precio_venta": 25, "stock_minimo": 5,
                                               "dias_alerta_venc": 30, "codigos": ["7501001"], "generar_codigo": True})
    check(r.status_code == 200, "crear producto leche: %s" % r.text)
    leche = r.json()
    check(len(leche["codigos"]) == 2, "leche tiene 2 codigos")
    interno = [c for c in leche["codigos"] if c.startswith("2")][0]
    check(len(interno) == 13 and interno[-1] == str((10 - sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(interno[:12])) % 10) % 10),
          "codigo interno es EAN-13 valido (%s)" % interno)
    r = api(A, "POST", "/api/productos", json={"nombre": "Frijol rojo", "categoria": "Granos básicos", "unidad": "libra", "se_vende_por_peso": True,
                                               "precio_venta": 12, "unidad_compra": "quintal", "factor_conversion": 100, "stock_minimo": 20})
    frijol = r.json()
    check(r.status_code == 200 and frijol["se_vende_por_peso"] is True, "crear frijol por peso")
    azucar = api(A, "POST", "/api/productos", json={"nombre": "Azúcar", "categoria": "Granos básicos", "unidad": "libra", "se_vende_por_peso": True, "precio_venta": 9}).json()
    r = api(A, "POST", "/api/productos", json={"nombre": "Otro", "precio_venta": 1, "codigos": ["7501001"]})
    check(r.status_code == 409 and "Leche" in r.json()["error"], "codigo duplicado rechazado")
    check(api(A, "POST", "/api/productos", json={"nombre": "Malo", "precio_venta": -5}).status_code == 400, "precio negativo rechazado")
    check(api(A, "POST", "/api/productos", json={"nombre": "Malo2", "precio_venta": 5, "codigos": ["a b|c"]}).status_code == 400, "codigo con caracteres raros rechazado")
    check(api(A, "GET", "/api/productos?q=azucar").json()[0]["nombre"] == "Azúcar", "busqueda sin acentos")
    check(api(A, "GET", "/api/productos?q=FRIJ%20ROJ").json()[0]["id"] == frijol["id"], "busqueda por varias palabras")
    check(api(A, "GET", "/api/productos?q=75010").json()[0]["id"] == leche["id"], "busqueda por prefijo de codigo")
    check(api(A, "GET", "/api/buscar?codigo=7501001").json()["id"] == leche["id"], "buscar por codigo exacto")
    check(api(A, "GET", "/api/buscar?codigo=999").json().get("no_encontrado") is True, "codigo inexistente responde no_encontrado")
    check(len(api(A, "GET", "/api/productos?q=%25").json()) == 0, "comodin % no coincide con todo")
    r = api(A, "PUT", "/api/productos/%d" % leche["id"], json={"precio_venta": 26})
    check(r.json()["precio_venta"] == 26, "editar precio")
    api(A, "PUT", "/api/productos/%d" % leche["id"], json={"precio_venta": 25})
    r = api(A, "POST", "/api/productos/%d/codigos" % azucar["id"], json={"codigo": "ABC-1"})
    check(r.status_code == 200, "agregar codigo")
    r = api(A, "DELETE", "/api/codigos/ABC-1")
    check(api(A, "GET", "/api/buscar?codigo=ABC-1").json().get("no_encontrado") is True, "codigo eliminado")

    print("== Compras (lotes y conversion de unidades)")
    v1 = (hoy + timedelta(days=20)).isoformat()
    v2 = (hoy + timedelta(days=60)).isoformat()
    r = api(A, "POST", "/api/compras", json={"lineas": [
        {"producto_id": leche["id"], "cantidad": 10, "costo_unitario": 18, "fecha_vencimiento": v1},
        {"producto_id": leche["id"], "cantidad": 20, "costo_unitario": 19, "fecha_vencimiento": v2},
        {"producto_id": frijol["id"], "cantidad": 1, "costo_unitario": 900}]})
    check(r.status_code == 200 and r.json()["total"] == 10 * 18 + 20 * 19 + 900, "compra registrada con total correcto: %s" % r.text)
    p = {x["id"]: x for x in api(A, "GET", "/api/productos").json()}
    check(p[leche["id"]]["stock"] == 30, "stock leche 30")
    check(p[frijol["id"]]["stock"] == 100, "1 quintal = 100 libras")
    check(abs(p[frijol["id"]]["ultimo_costo"] - 9) < 1e-9, "costo por libra 9")
    check(api(A, "POST", "/api/compras", json={"lineas": [{"producto_id": leche["id"], "cantidad": 1, "costo_unitario": 1,
                                                          "fecha_vencimiento": (hoy - timedelta(days=1)).isoformat()}]}).status_code == 400, "vencimiento pasado rechazado")
    check(api(A, "POST", "/api/compras", json={"lineas": [{"producto_id": leche["id"], "cantidad": 1.5, "costo_unitario": 1}]}).status_code == 400,
          "cantidad decimal en producto por unidad rechazada")
    check(api(A, "POST", "/api/compras", json={"lineas": []}).status_code == 400, "compra vacia rechazada")

    print("== Ventas (FEFO, peso, redondeo)")
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 12}], "metodo_pago": "efectivo", "recibido": 500})
    check(r.status_code == 200, "venta de 12 leches: %s" % r.text)
    v = r.json()
    check(v["total"] == 300 and v["cambio"] == 200, "total 300 y cambio 200")
    check(len(v["lineas"]) == 1 and v["lineas"][0]["cantidad"] == 12 and v["lineas"][0]["subtotal"] == 300, "linea agrupada")
    check(v["lineas"][0].get("costo") == 218.0, "costo FEFO 10x18 + 2x19 = 218 (admin)")
    venta_leche = v["id"]
    r = api(A, "GET", "/api/inventario/lotes?producto_id=%d" % leche["id"]).json()
    check([round(l["cantidad_actual"], 3) for l in r] == [0.0, 18.0] or [round(l["cantidad_actual"], 3) for l in r] == [18.0], "FEFO descuenta del lote que vence primero: %s" % r)
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": frijol["id"], "cantidad": 2.5}], "metodo_pago": "efectivo"})
    check(r.json()["total"] == 30, "2.5 lb x 12 = 30")
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": frijol["id"], "cantidad": 0.333}], "metodo_pago": "tarjeta"})
    check(r.json()["total"] == 4.0, "0.333 lb x 12 = 3.996 -> 4.00")
    check(api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 1.5}]}).status_code == 400, "no se vende media leche")
    check(api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 0}]}).status_code == 400, "cantidad cero rechazada")
    check(api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 1}], "metodo_pago": "efectivo", "recibido": 10}).status_code == 400,
          "efectivo recibido menor que total rechazado")
    check(api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 1}], "metodo_pago": "bitcoin"}).status_code == 400, "metodo invalido rechazado")
    # misma venta, dos lineas del mismo producto
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 2}, {"producto_id": leche["id"], "cantidad": 3}]})
    check(r.json()["total"] == 125, "dos lineas del mismo producto: 5 x 25 = 125")
    stock_leche = lambda: {x["id"]: x for x in api(A, "GET", "/api/productos").json()}[leche["id"]]["stock"]
    check(stock_leche() == 13, "stock leche 13 tras ventas (era %s)" % stock_leche())

    print("== Stock insuficiente y ventas sin stock")
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 20}]})
    check(r.status_code == 409 and r.json()["codigo"] == "stock_insuficiente", "409 por stock insuficiente")
    check(r.json()["faltantes"][0]["faltan"] == 7 and r.json()["faltantes"][0]["disponible"] == 13, "faltantes correctos")
    check(stock_leche() == 13, "la venta rechazada no altera el stock (rollback)")
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 20}], "forzar": True})
    check(r.status_code == 200 and r.json()["total"] == 500, "venta forzada permitida")
    check(stock_leche() == 0, "stock queda en 0, no negativo")
    check(api(A, "GET", "/api/alertas").json()["ventas_sin_stock"] == 1, "alerta de ventas sin stock registrado")
    forzada = r.json()["id"]
    r = api(A, "POST", "/api/ventas/%d/anular" % forzada, json={"motivo": "prueba"})
    check(r.status_code == 200, "anular venta forzada")
    check(stock_leche() == 13, "anulacion devuelve al stock lo que salio de lotes (13)")
    check(api(A, "POST", "/api/ventas/%d/anular" % forzada, json={"motivo": "otra vez"}).status_code == 409, "no se anula dos veces")
    check(api(A, "POST", "/api/ventas/%d/anular" % forzada, json={}).status_code in (400, 409), "anular exige motivo")

    print("== Productos vencidos no se venden")
    con = sqlite3.connect(os.path.join(datos, "bodega.db"))
    con.execute("UPDATE lotes SET fecha_vencimiento = ? WHERE producto_id = ? AND cantidad_actual > 0", ((hoy - timedelta(days=2)).isoformat(), leche["id"]))
    con.commit()
    con.close()
    pl = {x["id"]: x for x in api(A, "GET", "/api/productos").json()}[leche["id"]]
    check(pl["stock"] == 0 and pl["stock_vencido"] == 13, "stock vencido separado del vendible")
    check(api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": leche["id"], "cantidad": 1}]}).status_code == 409, "no se vende lote vencido")
    al = api(A, "GET", "/api/alertas").json()
    check(any(x["estado"] == "vencido" and x["producto_id"] == leche["id"] for x in al["vencimientos"]), "alerta: lote vencido")
    lote_venc = al["vencimientos"][0]["lote_id"]
    r = api(A, "POST", "/api/inventario/ajuste", json={"lote_id": lote_venc, "tipo": "vencido", "cantidad": 13})
    check(r.status_code == 200 and r.json()["cambio"] == -13, "dar de baja lote vencido")
    check(api(A, "POST", "/api/inventario/ajuste", json={"lote_id": lote_venc, "tipo": "vencido", "cantidad": 5}).status_code == 400, "no se da de baja mas de lo que hay")

    print("== Ajustes, mermas y alertas")
    lotes_f = api(A, "GET", "/api/inventario/lotes?producto_id=%d" % frijol["id"]).json()
    check(abs(lotes_f[0]["cantidad_actual"] - 97.167) < 1e-6, "lote de frijol 97.167 lb")
    check(api(A, "POST", "/api/inventario/ajuste", json={"lote_id": lotes_f[0]["id"], "tipo": "merma", "cantidad": 1}).status_code == 400, "merma exige motivo")
    r = api(A, "POST", "/api/inventario/ajuste", json={"lote_id": lotes_f[0]["id"], "tipo": "merma", "cantidad": 1.167, "motivo": "derrame"})
    check(r.json()["cambio"] == -1.167, "merma registrada")
    r = api(A, "POST", "/api/inventario/ajuste", json={"lote_id": lotes_f[0]["id"], "tipo": "ajuste", "cantidad": 15, "motivo": "conteo fisico"})
    check(r.json()["cambio"] == -81.0, "conteo fisico fija 15 lb")
    al = api(A, "GET", "/api/alertas").json()
    check(any(x["id"] == frijol["id"] for x in al["stock_bajo"]), "alerta de stock bajo para frijol (15 <= 20)")
    mov = api(A, "GET", "/api/inventario/movimientos?producto_id=%d" % frijol["id"]).json()
    check({m["tipo"] for m in mov} >= {"compra", "venta", "merma", "ajuste"}, "movimientos registran todos los tipos")

    print("== Fiados")
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": azucar["id"], "cantidad": 1}], "metodo_pago": "fiado"})
    check(r.status_code == 400, "fiado exige cliente")
    api(A, "POST", "/api/compras", json={"lineas": [{"producto_id": azucar["id"], "cantidad": 50, "costo_unitario": 6}]})
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": azucar["id"], "cantidad": 4}], "metodo_pago": "fiado", "cliente": "Doña Marta"})
    check(r.status_code == 200, "venta al fiado")
    f = api(A, "GET", "/api/fiados").json()
    check(f["total"] == 36 and f["clientes"][0]["cliente"] == "Doña Marta", "fiado pendiente listado")
    api(A, "POST", "/api/fiados/cobrar", json={"ids": [x["id"] for x in f["clientes"][0]["ventas"]]})
    check(api(A, "GET", "/api/fiados").json()["total"] == 0, "fiado cobrado desaparece de pendientes")

    print("== Gastos y reportes")
    api(A, "POST", "/api/gastos", json={"concepto": "Luz", "monto": 150.5})
    g = api(A, "GET", "/api/gastos").json()
    check(g["total"] == 150.5 and len(g["gastos"]) == 1, "gasto registrado")
    rep = api(A, "GET", "/api/reportes/resumen?desde=%s&hasta=%s" % (hoy.isoformat(), hoy.isoformat())).json()
    con = sqlite3.connect(os.path.join(datos, "bodega.db"))
    esperado = con.execute("SELECT ROUND(SUM(total),2), COUNT(*) FROM ventas WHERE anulada=0").fetchone()
    sub = con.execute("SELECT ROUND(SUM(d.subtotal),2) FROM detalle_ventas d JOIN ventas v ON v.id=d.venta_id WHERE v.anulada=0").fetchone()[0]
    con.close()
    check(rep["ventas"] == esperado[0] and rep["num_ventas"] == esperado[1], "reporte: ventas = suma de ventas no anuladas (%s vs %s)" % (rep["ventas"], esperado))
    check(abs(sub - esperado[0]) < 0.005, "suma de subtotales por linea = total de ventas (%s vs %s)" % (sub, esperado[0]))
    check(abs(rep["ganancia_bruta"] - (rep["ventas"] - rep["costo"])) < 0.005, "ganancia = ventas - costo")
    check(abs(rep["utilidad"] - (rep["ganancia_bruta"] - 150.5)) < 0.005, "utilidad = ganancia - gastos")
    check(rep["valor_inventario"] > 0 and len(rep["top_productos"]) >= 2, "valor de inventario y top productos")
    check(sum(d["ventas"] for d in rep["por_dia"]) - rep["ventas"] < 0.005, "por dia suma el total")
    for t in ("productos", "ventas", "inventario", "gastos"):
        r = api(A, "GET", "/api/exportar/%s.csv" % t)
        check(r.status_code == 200 and r.content.startswith(b"\xef\xbb\xbf"), "exportar %s.csv con BOM para Excel" % t)

    print("== Usuarios y permisos")
    check(api(A, "POST", "/api/usuarios", json={"nombre": "Caja 1", "usuario": "caja1", "password": "caja123", "rol": "cajero"}).status_code == 200, "crear cajero")
    check(api(A, "POST", "/api/usuarios", json={"nombre": "Dup", "usuario": "CAJA1", "password": "caja123"}).status_code == 409, "usuario duplicado (sin distinguir mayusculas)")
    uid_admin = api(A, "GET", "/api/estado").json()["usuario"]["id"]
    check(api(A, "PUT", "/api/usuarios/%d" % uid_admin, json={"rol": "cajero"}).status_code == 400, "no puede quitarse el rol de admin")
    check(api(A, "PUT", "/api/usuarios/%d" % uid_admin, json={"activo": False}).status_code == 400, "no puede desactivarse")
    C = requests.Session()
    check(api(C, "POST", "/api/login", json={"usuario": "caja1", "password": "mala"}).status_code == 401, "login incorrecto")
    check(api(C, "POST", "/api/login", json={"usuario": "caja1", "password": "caja123"}).status_code == 200, "login cajero")
    pc = api(C, "GET", "/api/productos").json()
    check(all("ultimo_costo" not in x for x in pc), "cajero no ve costos")
    check(api(C, "POST", "/api/productos", json={"nombre": "X", "precio_venta": 1}).status_code == 403, "cajero no crea productos")
    check(api(C, "POST", "/api/compras", json={"lineas": []}).status_code == 403, "cajero no registra compras")
    check(api(C, "GET", "/api/reportes/resumen").status_code == 403, "cajero no ve reportes")
    check(api(C, "GET", "/api/usuarios").status_code == 403, "cajero no ve usuarios")
    check(api(C, "GET", "/api/respaldo/descargar").status_code == 403, "cajero no descarga respaldos")
    check(api(C, "PUT", "/api/config", json={"negocio": "Hack"}).status_code == 403, "cajero no cambia configuracion")
    r = api(C, "POST", "/api/ventas", json={"lineas": [{"producto_id": azucar["id"], "cantidad": 1, "precio": 0.01}], "metodo_pago": "efectivo"})
    check(r.status_code == 200 and r.json()["total"] == 9 and "costo" not in r.json()["lineas"][0], "cajero vende, no cambia precio y no ve costo")
    mi_venta = r.json()["id"]
    check(api(C, "GET", "/api/ventas/%d" % venta_leche).status_code == 403, "cajero no ve ventas ajenas")
    check(api(C, "GET", "/api/ventas/%d" % mi_venta).status_code == 200, "cajero ve su venta")
    lv = api(C, "GET", "/api/ventas?desde=2000-01-01&hasta=2100-01-01").json()
    check(lv["cantidad"] == 1, "cajero solo lista sus ventas de hoy")
    check(api(C, "POST", "/api/ventas/%d/anular" % mi_venta, json={"motivo": "x"}).status_code == 403, "cajero no anula ventas")
    r = api(A, "POST", "/api/ventas", json={"lineas": [{"producto_id": azucar["id"], "cantidad": 1, "precio": 8.5}]})
    check(r.json()["total"] == 8.5, "admin si puede cambiar el precio de una linea")

    print("== Seguridad")
    for i in range(5):
        api(requests.Session(), "POST", "/api/login", json={"usuario": "caja1", "password": "x%d" % i})
    r = api(requests.Session(), "POST", "/api/login", json={"usuario": "caja1", "password": "caja123"})
    check(r.status_code == 429, "bloqueo tras 5 intentos fallidos (codigo %s)" % r.status_code)
    r = api(A, "POST", "/api/productos", json={"nombre": "Evil", "precio_venta": 1}, headers={"Origin": "http://evil.example"})
    check(r.status_code == 403, "peticion con Origin ajeno rechazada")
    check(api(A, "GET", "/static/../servidor.py").status_code == 404, "no se sirven archivos del servidor")
    check(api(A, "GET", "/").status_code == 200 and "Content-Security-Policy" in api(A, "GET", "/").headers, "pagina principal con CSP")
    r = api(A, "POST", "/api/productos", data="{no es json", headers={"Content-Type": "application/json"})
    check(r.status_code == 400, "JSON invalido da 400")
    r = api(A, "GET", "/api/productos?q=' OR 1=1 --")
    check(r.status_code == 200 and len(r.json()) == 0, "inyeccion SQL en busqueda no hace nada")
    r = api(A, "POST", "/api/cambiar-password", json={"actual": "clave123", "nueva": "nueva456"})
    check(r.status_code == 200, "cambiar contrasena propia")
    check(api(requests.Session(), "POST", "/api/login", json={"usuario": "giselle", "password": "nueva456"}).status_code == 200, "login con nueva contrasena")

    print("== Concurrencia: 24 cajas vendiendo a la vez con stock de 10")
    p2 = api(A, "POST", "/api/productos", json={"nombre": "Refresco", "precio_venta": 10}).json()
    api(A, "POST", "/api/compras", json={"lineas": [{"producto_id": p2["id"], "cantidad": 10, "costo_unitario": 5}]})

    def vender(_):
        s = requests.Session()
        s.cookies.update(A.cookies)
        return api(s, "POST", "/api/ventas", json={"lineas": [{"producto_id": p2["id"], "cantidad": 1}]}).status_code

    with concurrent.futures.ThreadPoolExecutor(24) as ex:
        codigos = list(ex.map(vender, range(24)))
    check(codigos.count(200) == 10 and codigos.count(409) == 14, "exactamente 10 ventas exitosas y 14 rechazadas: %s" % sorted(set(codigos)))
    check({x["id"]: x for x in api(A, "GET", "/api/productos").json()}[p2["id"]]["stock"] == 0, "stock final 0 exacto")

    print("== Respaldos")
    r = api(A, "POST", "/api/respaldo/crear")
    check(r.status_code == 200, "crear respaldo")
    check(len(api(A, "GET", "/api/respaldo/lista").json()["respaldos"]) >= 1, "respaldo listado")
    r = api(A, "GET", "/api/respaldo/descargar")
    check(r.content.startswith(b"SQLite format 3"), "descarga es una base SQLite valida")
    descargado = os.path.join(datos, "descargado.db")
    open(descargado, "wb").write(r.content)
    n_prod = len(api(A, "GET", "/api/productos").json())
    check(api(A, "POST", "/api/logout").status_code == 200 and api(A, "GET", "/api/productos").status_code == 401, "cerrar sesion")
finally:
    proc.terminate()
    proc.wait(timeout=10)

print("== Restaurar desde respaldo (servidor detenido)")
con = sqlite3.connect(os.path.join(datos, "bodega.db"))
con.execute("DELETE FROM codigos_barras")
con.execute("UPDATE productos SET activo=0")
con.commit()
con.close()
r = subprocess.run([sys.executable, "-I", SERVIDOR, "--datos", datos, "--config", "/nonexistent", "--restaurar", descargado], capture_output=True, text=True)
check(r.returncode == 0, "restaurar termina bien: %s %s" % (r.stdout, r.stderr))
con = sqlite3.connect(os.path.join(datos, "bodega.db"))
check(con.execute("SELECT COUNT(*) FROM productos WHERE activo=1").fetchone()[0] == n_prod, "productos recuperados tras restaurar")
con.close()
r = subprocess.run([sys.executable, "-I", SERVIDOR, "--datos", datos, "--config", "/nonexistent", "--restaurar", os.path.join(datos, "bodega.log")], capture_output=True, text=True)
check(r.returncode != 0, "restaurar rechaza un archivo que no es base de datos")

print()
print("Pruebas: %d, fallos: %d" % (total, len(fallos)))
for f in fallos:
    print(" -", f)
sys.exit(1 if fallos else 0)
