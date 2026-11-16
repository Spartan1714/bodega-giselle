#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bodega Giselle - Sistema de inventario y ventas.

Servidor web local con base de datos SQLite. Usa solamente la biblioteca
estandar de Python (3.8 o superior), por lo que funciona igual en Windows y
en Linux sin instalar nada mas.

Uso:
    python servidor.py                 (arranca el servidor)
    python servidor.py --abrir         (arranca y abre el navegador)
    python servidor.py --respaldo      (crea un respaldo y termina)
    python servidor.py --restaurar F   (restaura la base de datos desde F)
"""
import argparse
import configparser
import csv
import hashlib
import hmac
import http.cookies
import io
import json
import logging
import logging.handlers
import math
import os
import re
import secrets
import shutil
import signal
import sqlite3
import sys
import threading
import time
import traceback
import unicodedata
import webbrowser
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

VERSION = "1.0.0"
FMT = "%Y-%m-%d %H:%M:%S"
MAX_BODY = 2 * 1024 * 1024
COOKIE = "bg_sesion"

if getattr(sys, "frozen", False):  # empaquetado con PyInstaller
    RES_DIR = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    APP_DIR = os.path.dirname(sys.executable)
else:
    RES_DIR = APP_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG = {
    "host": "127.0.0.1",
    "puerto": 8080,
    "carpeta_datos": os.path.join(APP_DIR, "datos"),
    "negocio": "Bodega Giselle",
    "moneda": "L",
    "respaldos_dias": 30,
    "horas_sesion": 12,
}
DB_PATH = ""
DIR_RESPALDOS = ""
log = logging.getLogger("bodega")


# ============================================================ utilidades
def ahora():
    return datetime.now().strftime(FMT)


def hoy():
    return date.today().isoformat()


def norm(texto):
    """Minusculas y sin acentos, para buscar 'azucar' y encontrar 'Azucar'."""
    t = unicodedata.normalize("NFKD", str(texto or ""))
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", t.lower()).strip()


def like_esc(s):
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def D(x):
    return Decimal(str(x))


def r2(x):
    return float(D(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def r3(x):
    return float(D(x).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def dinero(cantidad, precio):
    return r2(D(cantidad) * D(precio))


class ApiError(Exception):
    def __init__(self, status, mensaje, **extra):
        super().__init__(mensaje)
        self.status = status
        self.mensaje = mensaje
        self.extra = extra


def to_num(valor, campo, minimo=None, maximo=None, defecto=None):
    if valor is None or valor == "":
        if defecto is not None:
            return defecto
        raise ApiError(400, "Falta el numero: %s" % campo)
    if isinstance(valor, bool):
        raise ApiError(400, "Numero invalido: %s" % campo)
    try:
        n = float(valor)
    except (TypeError, ValueError):
        raise ApiError(400, "Numero invalido: %s" % campo)
    if not math.isfinite(n):
        raise ApiError(400, "Numero invalido: %s" % campo)
    if minimo is not None and n < minimo:
        raise ApiError(400, "%s no puede ser menor que %s" % (campo, minimo))
    if maximo is not None and n > maximo:
        raise ApiError(400, "%s no puede ser mayor que %s" % (campo, maximo))
    return n


def to_id(valor, campo="id"):
    try:
        n = int(valor)
        if n <= 0:
            raise ValueError
        return n
    except (TypeError, ValueError):
        raise ApiError(400, "Identificador invalido: %s" % campo)


def to_texto(d, campo, maxlen=150, obligatorio=True, nombre=None):
    v = d.get(campo)
    if v is None or (isinstance(v, str) and not v.strip()):
        if obligatorio:
            raise ApiError(400, "Falta el campo: %s" % (nombre or campo))
        return None
    v = str(v).strip()
    if len(v) > maxlen:
        raise ApiError(400, "%s es demasiado largo (maximo %d)" % (nombre or campo, maxlen))
    return v


def to_fecha(valor, campo, obligatorio=False):
    if not valor:
        if obligatorio:
            raise ApiError(400, "Falta la fecha: %s" % campo)
        return None
    try:
        d = datetime.strptime(str(valor), "%Y-%m-%d").date()
    except ValueError:
        raise ApiError(400, "Fecha invalida en %s (use AAAA-MM-DD)" % campo)
    if d.year < 2000 or d.year > 2100:
        raise ApiError(400, "Fecha fuera de rango en %s" % campo)
    return d.isoformat()


def to_bool(v):
    return v in (True, 1, "1", "true", "True", "si", "on")


def ean13_digito(doce):
    s = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(doce))
    return str((10 - s % 10) % 10)


def codigo_interno(producto_id):
    base = "2" + str(producto_id).zfill(11)  # prefijo 2 = uso interno de tienda
    return base + ean13_digito(base)


RE_CODIGO = re.compile(r"^[A-Za-z0-9._\-/]{1,40}$")
RE_USUARIO = re.compile(r"^[A-Za-z0-9._-]{3,30}$")


# ============================================================ base de datos
SCHEMA = """
CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'cajero' CHECK (rol IN ('admin','cajero')),
    activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    creada TEXT NOT NULL,
    expira TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS proveedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    telefono TEXT,
    notas TEXT,
    activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    nombre_norm TEXT NOT NULL,
    categoria_id INTEGER REFERENCES categorias(id),
    unidad TEXT NOT NULL DEFAULT 'unidad',
    se_vende_por_peso INTEGER NOT NULL DEFAULT 0,
    precio_venta REAL NOT NULL CHECK (precio_venta >= 0),
    stock_minimo REAL NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
    dias_alerta_venc INTEGER NOT NULL DEFAULT 30,
    unidad_compra TEXT,
    factor_conversion REAL NOT NULL DEFAULT 1 CHECK (factor_conversion > 0),
    activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS codigos_barras (
    codigo TEXT PRIMARY KEY,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id INTEGER REFERENCES proveedores(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    fecha TEXT NOT NULL,
    total REAL NOT NULL DEFAULT 0,
    notas TEXT
);
CREATE TABLE IF NOT EXISTS lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL REFERENCES productos(id),
    compra_id INTEGER REFERENCES compras(id),
    cantidad_inicial REAL NOT NULL CHECK (cantidad_inicial > 0),
    cantidad_actual REAL NOT NULL CHECK (cantidad_actual >= 0),
    costo_unitario REAL NOT NULL CHECK (costo_unitario >= 0),
    fecha_vencimiento TEXT,
    fecha_ingreso TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    fecha TEXT NOT NULL,
    total REAL NOT NULL DEFAULT 0,
    metodo_pago TEXT NOT NULL DEFAULT 'efectivo'
        CHECK (metodo_pago IN ('efectivo','tarjeta','transferencia','fiado')),
    recibido REAL,
    cliente TEXT,
    fiado_pagado_fecha TEXT,
    notas TEXT,
    anulada INTEGER NOT NULL DEFAULT 0,
    anulada_por INTEGER REFERENCES usuarios(id),
    anulada_fecha TEXT,
    anulada_motivo TEXT
);
CREATE TABLE IF NOT EXISTS detalle_ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id INTEGER NOT NULL REFERENCES productos(id),
    lote_id INTEGER REFERENCES lotes(id),
    cantidad REAL NOT NULL CHECK (cantidad > 0),
    precio_unitario REAL NOT NULL,
    subtotal REAL NOT NULL,
    costo_unitario REAL NOT NULL,
    sin_stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS movimientos_inventario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL REFERENCES productos(id),
    lote_id INTEGER REFERENCES lotes(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('compra','venta','merma','vencido','ajuste','anulacion')),
    cantidad REAL NOT NULL,
    fecha TEXT NOT NULL,
    usuario_id INTEGER REFERENCES usuarios(id),
    motivo TEXT
);
CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    concepto TEXT NOT NULL,
    monto REAL NOT NULL CHECK (monto >= 0),
    usuario_id INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_prod_norm ON productos(nombre_norm);
CREATE INDEX IF NOT EXISTS idx_codigos_prod ON codigos_barras(producto_id);
CREATE INDEX IF NOT EXISTS idx_lotes_prod ON lotes(producto_id);
CREATE INDEX IF NOT EXISTS idx_lotes_venc ON lotes(fecha_vencimiento) WHERE cantidad_actual > 0;
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_det_venta ON detalle_ventas(venta_id);
CREATE INDEX IF NOT EXISTS idx_det_prod ON detalle_ventas(producto_id);
CREATE INDEX IF NOT EXISTS idx_mov_prod ON movimientos_inventario(producto_id);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
"""


def conectar():
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=FULL")  # seguro ante apagones
    return conn


@contextmanager
def tx(conn):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


def init_db():
    os.makedirs(CONFIG["carpeta_datos"], exist_ok=True)
    os.makedirs(DIR_RESPALDOS, exist_ok=True)
    conn = conectar()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        if conn.execute("PRAGMA user_version").fetchone()[0] < 1:
            conn.execute("PRAGMA user_version=1")
    finally:
        conn.close()


def filas(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def leer_config(conn):
    cfg = {"negocio": CONFIG["negocio"], "moneda": CONFIG["moneda"], "ticket_pie": "Gracias por su compra", "telefono": ""}
    for r in conn.execute("SELECT clave, valor FROM config"):
        cfg[r["clave"]] = r["valor"]
    return cfg


def guardar_config(conn, clave, valor):
    conn.execute("INSERT INTO config(clave, valor) VALUES(?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor", (clave, valor))


# ============================================================ contrasenas y sesiones
def hash_password(p):
    salt = secrets.token_hex(16)
    iters = 200000
    h = hashlib.pbkdf2_hmac("sha256", p.encode("utf-8"), bytes.fromhex(salt), iters)
    return "pbkdf2$%d$%s$%s" % (iters, salt, h.hex())


def verificar_password(p, almacenado):
    try:
        _, it, salt, h = almacenado.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", p.encode("utf-8"), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), h)
    except Exception:
        return False


def validar_password(p):
    if not isinstance(p, str) or len(p) < 6:
        raise ApiError(400, "La contrasena debe tener al menos 6 caracteres")
    if len(p) > 100:
        raise ApiError(400, "La contrasena es demasiado larga")


def hash_token(t):
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def crear_sesion(conn, usuario_id):
    token = secrets.token_urlsafe(32)
    ahora_dt = datetime.now()
    conn.execute("DELETE FROM sesiones WHERE expira < ?", (ahora_dt.strftime(FMT),))
    conn.execute(
        "INSERT INTO sesiones(token, usuario_id, creada, expira) VALUES(?,?,?,?)",
        (hash_token(token), usuario_id, ahora_dt.strftime(FMT),
         (ahora_dt + timedelta(hours=CONFIG["horas_sesion"])).strftime(FMT)),
    )
    return token


def usuario_de_sesion(conn, token):
    if not token:
        return None
    th = hash_token(token)
    r = conn.execute(
        "SELECT u.id, u.nombre, u.usuario, u.rol, s.expira FROM sesiones s "
        "JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND u.activo = 1", (th,)
    ).fetchone()
    if not r:
        return None
    ahora_dt = datetime.now()
    exp = datetime.strptime(r["expira"], FMT)
    if exp <= ahora_dt:
        conn.execute("DELETE FROM sesiones WHERE token = ?", (th,))
        return None
    nueva = ahora_dt + timedelta(hours=CONFIG["horas_sesion"])
    if nueva - exp > timedelta(minutes=10):  # renovar sin escribir en cada peticion
        conn.execute("UPDATE sesiones SET expira = ? WHERE token = ?", (nueva.strftime(FMT), th))
    return {"id": r["id"], "nombre": r["nombre"], "usuario": r["usuario"], "rol": r["rol"]}


_fallos = {}
_fallos_lock = threading.Lock()


def login_bloqueado(claves):
    with _fallos_lock:
        for k in claves:
            n, hasta = _fallos.get(k, (0, 0))
            if hasta > time.time():
                return int(hasta - time.time())
    return 0


def registrar_fallo(claves):
    with _fallos_lock:
        for k in claves:
            n, hasta = _fallos.get(k, (0, 0))
            if hasta and hasta <= time.time():
                n = 0
            n += 1
            limite = 20 if k.startswith("ip:") else 5  # por equipo se tolera mas que por usuario
            hasta = time.time() + 300 if n >= limite else 0
            _fallos[k] = (n, hasta)


def limpiar_fallos(claves):
    with _fallos_lock:
        for k in claves:
            _fallos.pop(k, None)


# ============================================================ enrutador
ROUTES = []


def ruta(metodo, patron, acceso="admin"):
    """acceso: None = publico, 'usuario' = cualquier sesion, 'admin' = solo administrador."""
    def deco(fn):
        ROUTES.append((metodo, re.compile("^" + patron + "$"), acceso, fn))
        return fn
    return deco


class Ctx:
    def __init__(self, conn, user, body, query, grupos, ip, https):
        self.conn = conn
        self.user = user
        self.body = body
        self.q = query
        self.m = grupos
        self.ip = ip
        self.https = https
        self.cookies_nuevas = []  # (nombre, valor, max_age)

    @property
    def admin(self):
        return bool(self.user and self.user["rol"] == "admin")


class Respuesta:
    def __init__(self, status=200, datos=None, cabeceras=None, raw=None, tipo=None):
        self.status = status
        self.datos = datos
        self.cabeceras = cabeceras or {}
        self.raw = raw
        self.tipo = tipo


def archivo(nombre, contenido, tipo):
    return Respuesta(200, raw=contenido, tipo=tipo,
                     cabeceras={"Content-Disposition": 'attachment; filename="%s"' % nombre})


def csv_bytes(cabecera, filas_):
    def limpio(v):
        if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
            return "'" + v
        return v
    s = io.StringIO()
    w = csv.writer(s)
    w.writerow(cabecera)
    for f in filas_:
        w.writerow([limpio(v) for v in f])
    return ("﻿" + s.getvalue()).encode("utf-8")


# ============================================================ estado, acceso
@ruta("GET", r"/api/estado", None)
def api_estado(c):
    n = c.conn.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]
    cfg = leer_config(c.conn)
    return {"configurado": n > 0, "version": VERSION, "usuario": c.user, "hoy": hoy(),
            "negocio": cfg["negocio"], "moneda": cfg["moneda"],
            "ticket_pie": cfg["ticket_pie"], "telefono": cfg["telefono"]}


@ruta("POST", r"/api/setup", None)
def api_setup(c):
    b = c.body
    negocio = to_texto(b, "negocio", 80, nombre="nombre del negocio")
    nombre = to_texto(b, "nombre", 80, nombre="su nombre")
    usuario = to_texto(b, "usuario", 30, nombre="usuario")
    if not RE_USUARIO.match(usuario):
        raise ApiError(400, "El usuario debe tener de 3 a 30 letras, numeros, punto, guion o guion bajo")
    validar_password(b.get("password"))
    moneda = to_texto(b, "moneda", 6, obligatorio=False) or "L"
    with tx(c.conn):
        if c.conn.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0] > 0:
            raise ApiError(409, "El sistema ya fue configurado")
        cur = c.conn.execute("INSERT INTO usuarios(nombre, usuario, password_hash, rol) VALUES(?,?,?, 'admin')",
                             (nombre, usuario, hash_password(b["password"])))
        guardar_config(c.conn, "negocio", negocio)
        guardar_config(c.conn, "moneda", moneda)
        token = crear_sesion(c.conn, cur.lastrowid)
    c.cookies_nuevas.append((COOKIE, token, CONFIG["horas_sesion"] * 3600))
    log.info("Sistema configurado. Administrador: %s", usuario)
    c.user = {"id": cur.lastrowid, "nombre": nombre, "usuario": usuario, "rol": "admin"}
    return api_estado(c)


@ruta("POST", r"/api/login", None)
def api_login(c):
    usuario = str(c.body.get("usuario") or "").strip()
    password = str(c.body.get("password") or "")
    claves = ["ip:" + c.ip, "u:" + usuario.lower()]
    espera = login_bloqueado(claves)
    if espera:
        raise ApiError(429, "Demasiados intentos. Espere %d minutos e intente de nuevo." % (espera // 60 + 1))
    r = c.conn.execute("SELECT * FROM usuarios WHERE usuario = ? AND activo = 1", (usuario,)).fetchone()
    ok = verificar_password(password, r["password_hash"]) if r else verificar_password(password, "pbkdf2$1000$00$00")
    if not r or not ok:
        registrar_fallo(claves)
        log.warning("Intento de acceso fallido: usuario=%s ip=%s", usuario, c.ip)
        raise ApiError(401, "Usuario o contrasena incorrectos")
    limpiar_fallos(claves)
    with tx(c.conn):
        token = crear_sesion(c.conn, r["id"])
    c.cookies_nuevas.append((COOKIE, token, CONFIG["horas_sesion"] * 3600))
    c.user = {"id": r["id"], "nombre": r["nombre"], "usuario": r["usuario"], "rol": r["rol"]}
    log.info("Inicio de sesion: %s", usuario)
    return api_estado(c)


@ruta("POST", r"/api/logout", "usuario")
def api_logout(c):
    c.conn.execute("DELETE FROM sesiones WHERE usuario_id = ? AND token = ?", (c.user["id"], c.token))
    c.cookies_nuevas.append((COOKIE, "", 0))
    return {"ok": True}


@ruta("POST", r"/api/cambiar-password", "usuario")
def api_cambiar_password(c):
    r = c.conn.execute("SELECT password_hash FROM usuarios WHERE id = ?", (c.user["id"],)).fetchone()
    if not verificar_password(str(c.body.get("actual") or ""), r["password_hash"]):
        raise ApiError(400, "La contrasena actual no es correcta")
    validar_password(c.body.get("nueva"))
    with tx(c.conn):
        c.conn.execute("UPDATE usuarios SET password_hash = ? WHERE id = ?", (hash_password(c.body["nueva"]), c.user["id"]))
        c.conn.execute("DELETE FROM sesiones WHERE usuario_id = ? AND token <> ?", (c.user["id"], c.token))
    return {"ok": True}


@ruta("GET", r"/api/config", "usuario")
def api_config_get(c):
    return leer_config(c.conn)


@ruta("PUT", r"/api/config")
def api_config_put(c):
    b = c.body
    with tx(c.conn):
        if "negocio" in b:
            guardar_config(c.conn, "negocio", to_texto(b, "negocio", 80, nombre="nombre del negocio"))
        if "moneda" in b:
            guardar_config(c.conn, "moneda", to_texto(b, "moneda", 6, nombre="moneda"))
        if "ticket_pie" in b:
            guardar_config(c.conn, "ticket_pie", to_texto(b, "ticket_pie", 120, obligatorio=False) or "")
        if "telefono" in b:
            guardar_config(c.conn, "telefono", to_texto(b, "telefono", 40, obligatorio=False) or "")
    return leer_config(c.conn)


# ============================================================ usuarios
@ruta("GET", r"/api/usuarios")
def usuarios_lista(c):
    return filas(c.conn, "SELECT id, nombre, usuario, rol, activo FROM usuarios ORDER BY nombre")


@ruta("POST", r"/api/usuarios")
def usuarios_crear(c):
    b = c.body
    nombre = to_texto(b, "nombre", 80)
    usuario = to_texto(b, "usuario", 30)
    if not RE_USUARIO.match(usuario):
        raise ApiError(400, "El usuario debe tener de 3 a 30 letras, numeros, punto, guion o guion bajo")
    rol = b.get("rol", "cajero")
    if rol not in ("admin", "cajero"):
        raise ApiError(400, "Rol invalido")
    validar_password(b.get("password"))
    with tx(c.conn):
        if c.conn.execute("SELECT 1 FROM usuarios WHERE usuario = ?", (usuario,)).fetchone():
            raise ApiError(409, "Ese nombre de usuario ya existe")
        cur = c.conn.execute("INSERT INTO usuarios(nombre, usuario, password_hash, rol) VALUES(?,?,?,?)",
                             (nombre, usuario, hash_password(b["password"]), rol))
    log.info("Usuario creado: %s (%s) por %s", usuario, rol, c.user["usuario"])
    return {"id": cur.lastrowid}


@ruta("PUT", r"/api/usuarios/(\d+)")
def usuarios_editar(c):
    uid = int(c.m[0])
    b = c.body
    with tx(c.conn):
        u = c.conn.execute("SELECT * FROM usuarios WHERE id = ?", (uid,)).fetchone()
        if not u:
            raise ApiError(404, "Usuario no encontrado")
        nombre = to_texto(b, "nombre", 80) if "nombre" in b else u["nombre"]
        rol = b.get("rol", u["rol"])
        activo = (1 if to_bool(b["activo"]) else 0) if "activo" in b else u["activo"]
        if rol not in ("admin", "cajero"):
            raise ApiError(400, "Rol invalido")
        if uid == c.user["id"] and (rol != "admin" or not activo):
            raise ApiError(400, "No puede quitarse a si mismo el acceso de administrador")
        if (u["rol"] == "admin" and u["activo"]) and (rol != "admin" or not activo):
            otros = c.conn.execute("SELECT COUNT(*) FROM usuarios WHERE rol='admin' AND activo=1 AND id<>?", (uid,)).fetchone()[0]
            if otros == 0:
                raise ApiError(400, "Debe quedar al menos un administrador activo")
        c.conn.execute("UPDATE usuarios SET nombre=?, rol=?, activo=? WHERE id=?", (nombre, rol, activo, uid))
        if b.get("password"):
            validar_password(b["password"])
            c.conn.execute("UPDATE usuarios SET password_hash=? WHERE id=?", (hash_password(b["password"]), uid))
            c.conn.execute("DELETE FROM sesiones WHERE usuario_id=?", (uid,))
        if not activo:
            c.conn.execute("DELETE FROM sesiones WHERE usuario_id=?", (uid,))
    return {"ok": True}


# ============================================================ categorias y proveedores
def obtener_o_crear_categoria(conn, nombre):
    r = conn.execute("SELECT id FROM categorias WHERE nombre = ?", (nombre,)).fetchone()
    if r:
        return r["id"]
    return conn.execute("INSERT INTO categorias(nombre) VALUES(?)", (nombre,)).lastrowid


@ruta("GET", r"/api/categorias", "usuario")
def categorias_lista(c):
    return filas(c.conn, "SELECT id, nombre FROM categorias ORDER BY nombre")


@ruta("POST", r"/api/categorias")
def categorias_crear(c):
    nombre = to_texto(c.body, "nombre", 60)
    with tx(c.conn):
        cid = obtener_o_crear_categoria(c.conn, nombre)
    return {"id": cid, "nombre": nombre}


@ruta("GET", r"/api/proveedores")
def proveedores_lista(c):
    return filas(c.conn, "SELECT id, nombre, telefono, notas, activo FROM proveedores WHERE activo = 1 ORDER BY nombre")


@ruta("POST", r"/api/proveedores")
def proveedores_crear(c):
    b = c.body
    with tx(c.conn):
        cur = c.conn.execute("INSERT INTO proveedores(nombre, telefono, notas) VALUES(?,?,?)",
                             (to_texto(b, "nombre", 100), to_texto(b, "telefono", 40, False), to_texto(b, "notas", 300, False)))
    return {"id": cur.lastrowid}


@ruta("PUT", r"/api/proveedores/(\d+)")
def proveedores_editar(c):
    b = c.body
    pid = int(c.m[0])
    with tx(c.conn):
        if not c.conn.execute("SELECT 1 FROM proveedores WHERE id=?", (pid,)).fetchone():
            raise ApiError(404, "Proveedor no encontrado")
        c.conn.execute("UPDATE proveedores SET nombre=?, telefono=?, notas=?, activo=? WHERE id=?",
                       (to_texto(b, "nombre", 100), to_texto(b, "telefono", 40, False), to_texto(b, "notas", 300, False),
                        0 if "activo" in b and not to_bool(b["activo"]) else 1, pid))
    return {"ok": True}


# ============================================================ productos
SQL_PRODUCTOS = """
SELECT p.id, p.nombre, p.categoria_id, c.nombre AS categoria, p.unidad, p.se_vende_por_peso,
       p.precio_venta, p.stock_minimo, p.dias_alerta_venc, p.unidad_compra, p.factor_conversion, p.activo,
       COALESCE((SELECT SUM(l.cantidad_actual) FROM lotes l WHERE l.producto_id = p.id
                 AND (l.fecha_vencimiento IS NULL OR l.fecha_vencimiento >= :hoy)), 0) AS stock,
       COALESCE((SELECT SUM(l.cantidad_actual) FROM lotes l WHERE l.producto_id = p.id
                 AND l.fecha_vencimiento < :hoy), 0) AS stock_vencido,
       (SELECT l.costo_unitario FROM lotes l WHERE l.producto_id = p.id ORDER BY l.id DESC LIMIT 1) AS ultimo_costo,
       (SELECT group_concat(cb.codigo, '|') FROM codigos_barras cb WHERE cb.producto_id = p.id) AS codigos
FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
"""


def fila_producto(r, admin):
    d = dict(r)
    d["se_vende_por_peso"] = bool(d["se_vende_por_peso"])
    d["activo"] = bool(d["activo"])
    d["codigos"] = d["codigos"].split("|") if d.get("codigos") else []
    d["stock"] = r3(d["stock"])
    d["stock_vencido"] = r3(d["stock_vencido"])
    if not admin:
        d.pop("ultimo_costo", None)
    return d


def consultar_productos(conn, admin, q=None, categoria_id=None, inactivos=False, limite=600, producto_id=None, codigo=None):
    cond, params = [], {"hoy": hoy()}
    if producto_id is not None:
        cond.append("p.id = :pid")
        params["pid"] = producto_id
    if codigo is not None:
        cond.append("p.id = (SELECT producto_id FROM codigos_barras WHERE codigo = :cod)")
        params["cod"] = codigo
    if not inactivos:
        cond.append("p.activo = 1")
    if categoria_id:
        cond.append("p.categoria_id = :cat")
        params["cat"] = categoria_id
    if q:
        for i, tok in enumerate(norm(q).split(" ")[:6]):
            cond.append("(p.nombre_norm LIKE :t%d ESCAPE '\\' OR EXISTS (SELECT 1 FROM codigos_barras cb "
                        "WHERE cb.producto_id = p.id AND cb.codigo LIKE :c%d ESCAPE '\\'))" % (i, i))
            params["t%d" % i] = "%" + like_esc(tok) + "%"
            params["c%d" % i] = like_esc(tok) + "%"
    sql = SQL_PRODUCTOS + (" WHERE " + " AND ".join(cond) if cond else "") + " ORDER BY p.nombre_norm LIMIT %d" % int(limite)
    return [fila_producto(r, admin) for r in conn.execute(sql, params).fetchall()]


def leer_producto(conn, b, parcial):
    """Valida y devuelve solo los campos recibidos (parcial) o todos con valores por defecto."""
    campos = {}

    def tiene(k):
        return k in b if parcial else True

    if tiene("nombre"):
        campos["nombre"] = to_texto(b, "nombre", 150, nombre="nombre del producto")
        campos["nombre_norm"] = norm(campos["nombre"])
    if "categoria" in b and b["categoria"]:
        campos["categoria_id"] = obtener_o_crear_categoria(conn, to_texto(b, "categoria", 60))
    elif "categoria_id" in b:
        cid = b["categoria_id"]
        if cid:
            cid = to_id(cid, "categoria")
            if not conn.execute("SELECT 1 FROM categorias WHERE id=?", (cid,)).fetchone():
                raise ApiError(400, "La categoria no existe")
        campos["categoria_id"] = cid or None
    if tiene("unidad"):
        campos["unidad"] = to_texto(b, "unidad", 20, obligatorio=False) or "unidad"
    if tiene("se_vende_por_peso"):
        campos["se_vende_por_peso"] = 1 if to_bool(b.get("se_vende_por_peso")) else 0
    if tiene("precio_venta"):
        campos["precio_venta"] = r2(to_num(b.get("precio_venta"), "precio de venta", 0, 10000000))
    if tiene("stock_minimo"):
        campos["stock_minimo"] = r3(to_num(b.get("stock_minimo"), "stock minimo", 0, 10000000, defecto=0))
    if tiene("dias_alerta_venc"):
        campos["dias_alerta_venc"] = int(to_num(b.get("dias_alerta_venc"), "dias de alerta", 0, 3650, defecto=30))
    if tiene("unidad_compra"):
        campos["unidad_compra"] = to_texto(b, "unidad_compra", 20, obligatorio=False)
    if tiene("factor_conversion"):
        campos["factor_conversion"] = to_num(b.get("factor_conversion"), "factor de conversion", 0.0001, 100000, defecto=1.0)
    return campos


@ruta("GET", r"/api/productos", "usuario")
def productos_lista(c):
    cat = int(c.q["categoria_id"]) if c.q.get("categoria_id", "").isdigit() else None
    return consultar_productos(c.conn, c.admin, q=c.q.get("q"), categoria_id=cat,
                               inactivos=c.admin and c.q.get("inactivos") == "1",
                               limite=min(int(c.q.get("limite", 600) or 600), 2000))


@ruta("GET", r"/api/productos/(\d+)", "usuario")
def productos_uno(c):
    r = consultar_productos(c.conn, c.admin, producto_id=int(c.m[0]), inactivos=True)
    if not r:
        raise ApiError(404, "Producto no encontrado")
    return r[0]


@ruta("GET", r"/api/buscar", "usuario")
def productos_por_codigo(c):
    codigo = str(c.q.get("codigo") or "").strip()
    if not codigo:
        raise ApiError(400, "Falta el codigo")
    r = consultar_productos(c.conn, c.admin, codigo=codigo)
    if not r:
        return {"no_encontrado": True, "codigo": codigo}
    return r[0]


@ruta("POST", r"/api/productos")
def productos_crear(c):
    b = c.body
    with tx(c.conn):
        campos = leer_producto(c.conn, b, parcial=False)
        cols = ", ".join(campos)
        cur = c.conn.execute("INSERT INTO productos(%s) VALUES(%s)" % (cols, ", ".join("?" * len(campos))), list(campos.values()))
        pid = cur.lastrowid
        codigos = [str(x).strip() for x in (b.get("codigos") or []) if str(x).strip()]
        if to_bool(b.get("generar_codigo")):
            codigos.append(codigo_interno(pid))
        for cod in codigos:
            agregar_codigo(c.conn, pid, cod)
    log.info("Producto creado: %s (id %d) por %s", campos["nombre"], pid, c.user["usuario"])
    return consultar_productos(c.conn, True, producto_id=pid, inactivos=True)[0]


@ruta("PUT", r"/api/productos/(\d+)")
def productos_editar(c):
    pid = int(c.m[0])
    b = c.body
    with tx(c.conn):
        antes = c.conn.execute("SELECT * FROM productos WHERE id = ?", (pid,)).fetchone()
        if not antes:
            raise ApiError(404, "Producto no encontrado")
        campos = leer_producto(c.conn, b, parcial=True)
        if "activo" in b:
            campos["activo"] = 1 if to_bool(b["activo"]) else 0
        if campos:
            c.conn.execute("UPDATE productos SET %s WHERE id = ?" % ", ".join("%s = ?" % k for k in campos),
                           list(campos.values()) + [pid])
        if "precio_venta" in campos and campos["precio_venta"] != antes["precio_venta"]:
            log.info("Precio cambiado: %s %.2f -> %.2f por %s", antes["nombre"], antes["precio_venta"],
                     campos["precio_venta"], c.user["usuario"])
    return consultar_productos(c.conn, True, producto_id=pid, inactivos=True)[0]


def agregar_codigo(conn, producto_id, codigo):
    if not RE_CODIGO.match(codigo):
        raise ApiError(400, "Codigo invalido '%s': use letras, numeros, punto, guion o barra (maximo 40)" % codigo)
    r = conn.execute("SELECT p.id, p.nombre FROM codigos_barras cb JOIN productos p ON p.id = cb.producto_id "
                     "WHERE cb.codigo = ?", (codigo,)).fetchone()
    if r:
        if r["id"] == producto_id:
            return
        raise ApiError(409, "El codigo %s ya pertenece a '%s'" % (codigo, r["nombre"]))
    conn.execute("INSERT INTO codigos_barras(codigo, producto_id) VALUES(?, ?)", (codigo, producto_id))


@ruta("POST", r"/api/productos/(\d+)/codigos")
def codigos_agregar(c):
    pid = int(c.m[0])
    with tx(c.conn):
        if not c.conn.execute("SELECT 1 FROM productos WHERE id = ?", (pid,)).fetchone():
            raise ApiError(404, "Producto no encontrado")
        if to_bool(c.body.get("generar")):
            cod = codigo_interno(pid)
        else:
            cod = to_texto(c.body, "codigo", 40)
        agregar_codigo(c.conn, pid, cod)
    return {"codigo": cod}


@ruta("DELETE", r"/api/codigos/(.+)")
def codigos_borrar(c):
    with tx(c.conn):
        c.conn.execute("DELETE FROM codigos_barras WHERE codigo = ?", (unquote(c.m[0]),))
    return {"ok": True}


# ============================================================ compras
@ruta("POST", r"/api/compras")
def compras_crear(c):
    b = c.body
    lineas = b.get("lineas")
    if not isinstance(lineas, list) or not lineas:
        raise ApiError(400, "La compra no tiene productos")
    if len(lineas) > 300:
        raise ApiError(400, "Demasiadas lineas en una compra")
    prov = int(b["proveedor_id"]) if str(b.get("proveedor_id") or "").isdigit() else None
    notas = to_texto(b, "notas", 300, False)
    fecha_hoy = hoy()
    total = Decimal("0")
    with tx(c.conn):
        if prov and not c.conn.execute("SELECT 1 FROM proveedores WHERE id=?", (prov,)).fetchone():
            raise ApiError(400, "El proveedor no existe")
        compra_id = c.conn.execute("INSERT INTO compras(proveedor_id, usuario_id, fecha, total, notas) VALUES(?,?,?,0,?)",
                                   (prov, c.user["id"], ahora(), notas)).lastrowid
        for i, ln in enumerate(lineas, 1):
            if not isinstance(ln, dict):
                raise ApiError(400, "Linea %d invalida" % i)
            prod = c.conn.execute("SELECT * FROM productos WHERE id = ? AND activo = 1", (to_id(ln.get("producto_id"), "producto"),)).fetchone()
            if not prod:
                raise ApiError(400, "Linea %d: el producto no existe o esta desactivado" % i)
            cant = to_num(ln.get("cantidad"), "cantidad", 0.001, 10000000)
            costo = to_num(ln.get("costo_unitario"), "costo", 0, 10000000)
            venc = to_fecha(ln.get("fecha_vencimiento"), "vencimiento")
            if venc and venc < fecha_hoy:
                raise ApiError(400, "Linea %d (%s): la fecha de vencimiento ya paso" % (i, prod["nombre"]))
            factor = prod["factor_conversion"] or 1.0
            cant_v = r3(D(cant) * D(factor))
            if not prod["se_vende_por_peso"] and abs(cant_v - round(cant_v)) > 1e-9:
                raise ApiError(400, "Linea %d (%s): la cantidad resultante (%s) debe ser un numero entero" % (i, prod["nombre"], cant_v))
            costo_v = round(costo / factor, 4)
            lote_id = c.conn.execute(
                "INSERT INTO lotes(producto_id, compra_id, cantidad_inicial, cantidad_actual, costo_unitario, fecha_vencimiento, fecha_ingreso) "
                "VALUES(?,?,?,?,?,?,?)", (prod["id"], compra_id, cant_v, cant_v, costo_v, venc, ahora())).lastrowid
            c.conn.execute("INSERT INTO movimientos_inventario(producto_id, lote_id, tipo, cantidad, fecha, usuario_id, motivo) "
                           "VALUES(?,?, 'compra', ?, ?, ?, ?)", (prod["id"], lote_id, cant_v, ahora(), c.user["id"], "Compra #%d" % compra_id))
            total += D(dinero(cant, costo))
        c.conn.execute("UPDATE compras SET total = ? WHERE id = ?", (float(total), compra_id))
    log.info("Compra #%d registrada (%d lineas, total %.2f) por %s", compra_id, len(lineas), float(total), c.user["usuario"])
    return {"id": compra_id, "total": float(total)}


@ruta("GET", r"/api/compras")
def compras_lista(c):
    desde = to_fecha(c.q.get("desde"), "desde") or (date.today() - timedelta(days=30)).isoformat()
    hasta = to_fecha(c.q.get("hasta"), "hasta") or hoy()
    return filas(c.conn, "SELECT c.id, c.fecha, c.total, c.notas, p.nombre AS proveedor, u.nombre AS usuario, "
                         "(SELECT COUNT(*) FROM lotes l WHERE l.compra_id = c.id) AS lineas "
                         "FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id JOIN usuarios u ON u.id = c.usuario_id "
                         "WHERE date(c.fecha) BETWEEN ? AND ? ORDER BY c.id DESC LIMIT 500", (desde, hasta))


# ============================================================ ventas
METODOS = ("efectivo", "tarjeta", "transferencia", "fiado")


def detalle_venta(conn, venta_id, admin):
    v = conn.execute("SELECT v.*, u.nombre AS usuario FROM ventas v JOIN usuarios u ON u.id = v.usuario_id WHERE v.id = ?", (venta_id,)).fetchone()
    if not v:
        raise ApiError(404, "Venta no encontrada")
    v = dict(v)
    items = filas(conn, "SELECT d.producto_id, p.nombre, p.unidad, d.precio_unitario, SUM(d.cantidad) AS cantidad, "
                        "SUM(d.subtotal) AS subtotal, SUM(d.cantidad * d.costo_unitario) AS costo, MAX(d.sin_stock) AS sin_stock "
                        "FROM detalle_ventas d JOIN productos p ON p.id = d.producto_id WHERE d.venta_id = ? "
                        "GROUP BY d.producto_id, d.precio_unitario ORDER BY MIN(d.id)", (venta_id,))
    for it in items:
        it["cantidad"] = r3(it["cantidad"])
        it["subtotal"] = r2(it["subtotal"])
        it["costo"] = r2(it["costo"])
        it["sin_stock"] = bool(it["sin_stock"])
        if not admin:
            it.pop("costo")
    v["lineas"] = items
    v["anulada"] = bool(v["anulada"])
    v["cambio"] = r2(v["recibido"] - v["total"]) if v["recibido"] is not None and v["metodo_pago"] == "efectivo" else None
    return v


@ruta("POST", r"/api/ventas", "usuario")
def ventas_crear(c):
    b = c.body
    lineas = b.get("lineas")
    if not isinstance(lineas, list) or not lineas:
        raise ApiError(400, "La venta no tiene productos")
    if len(lineas) > 300:
        raise ApiError(400, "Demasiadas lineas en una venta")
    metodo = b.get("metodo_pago", "efectivo")
    if metodo not in METODOS:
        raise ApiError(400, "Metodo de pago invalido")
    cliente = to_texto(b, "cliente", 80, obligatorio=(metodo == "fiado"), nombre="nombre del cliente (venta al fiado)") if metodo == "fiado" else None
    notas = to_texto(b, "notas", 200, False)
    forzar = to_bool(b.get("forzar"))
    fecha_hoy = hoy()
    faltantes = []
    with tx(c.conn):
        venta_id = c.conn.execute("INSERT INTO ventas(usuario_id, fecha, total, metodo_pago, cliente, notas) VALUES(?,?,0,?,?,?)",
                                  (c.user["id"], ahora(), metodo, cliente, notas)).lastrowid
        total = Decimal("0")
        for i, ln in enumerate(lineas, 1):
            if not isinstance(ln, dict):
                raise ApiError(400, "Linea %d invalida" % i)
            prod = c.conn.execute("SELECT * FROM productos WHERE id = ? AND activo = 1", (to_id(ln.get("producto_id"), "producto"),)).fetchone()
            if not prod:
                raise ApiError(400, "Linea %d: el producto no existe o esta desactivado" % i)
            cant = r3(to_num(ln.get("cantidad"), "cantidad", 0.001, 100000))
            if not prod["se_vende_por_peso"] and abs(cant - round(cant)) > 1e-9:
                raise ApiError(400, "%s se vende por unidad: la cantidad debe ser un numero entero" % prod["nombre"])
            precio = prod["precio_venta"]
            if c.admin and ln.get("precio") not in (None, ""):
                precio = r2(to_num(ln.get("precio"), "precio", 0, 10000000))
            total_linea = dinero(cant, precio)
            lotes = c.conn.execute(
                "SELECT id, cantidad_actual, costo_unitario FROM lotes WHERE producto_id = ? AND cantidad_actual > 0 "
                "AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ?) "
                "ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento, id", (prod["id"], fecha_hoy)).fetchall()
            restante = cant
            partes = []  # (lote_id, cantidad, costo, sin_stock)
            for lote in lotes:
                if restante <= 0:
                    break
                toma = r3(min(restante, lote["cantidad_actual"]))
                if toma <= 0:
                    continue
                partes.append((lote["id"], toma, lote["costo_unitario"], 0))
                c.conn.execute("UPDATE lotes SET cantidad_actual = ? WHERE id = ?", (r3(lote["cantidad_actual"] - toma), lote["id"]))
                restante = r3(restante - toma)
            if restante > 0:
                faltantes.append({"producto_id": prod["id"], "nombre": prod["nombre"], "unidad": prod["unidad"],
                                  "faltan": restante, "disponible": r3(cant - restante)})
                ult = c.conn.execute("SELECT costo_unitario FROM lotes WHERE producto_id = ? ORDER BY id DESC LIMIT 1", (prod["id"],)).fetchone()
                partes.append((None, restante, ult["costo_unitario"] if ult else 0.0, 1))
            acumulado = Decimal("0")
            for j, (lote_id, cantidad, costo, sin_stock) in enumerate(partes):
                if j == len(partes) - 1:
                    sub = r2(D(total_linea) - acumulado)
                else:
                    sub = dinero(cantidad, precio)
                    acumulado += D(sub)
                c.conn.execute("INSERT INTO detalle_ventas(venta_id, producto_id, lote_id, cantidad, precio_unitario, subtotal, costo_unitario, sin_stock) "
                               "VALUES(?,?,?,?,?,?,?,?)", (venta_id, prod["id"], lote_id, cantidad, precio, sub, costo, sin_stock))
                c.conn.execute("INSERT INTO movimientos_inventario(producto_id, lote_id, tipo, cantidad, fecha, usuario_id, motivo) "
                               "VALUES(?,?, 'venta', ?, ?, ?, ?)",
                               (prod["id"], lote_id, -cantidad, ahora(), c.user["id"],
                                "Venta #%d%s" % (venta_id, " (sin stock registrado)" if sin_stock else "")))
            total += D(total_linea)
        if faltantes and not forzar:
            raise ApiError(409, "No hay suficiente inventario registrado para algunos productos", codigo="stock_insuficiente", faltantes=faltantes)
        recibido = None
        if metodo == "efectivo" and b.get("recibido") not in (None, ""):
            recibido = r2(to_num(b.get("recibido"), "monto recibido", 0, 100000000))
            if D(recibido) < total:
                raise ApiError(400, "El monto recibido es menor que el total")
        c.conn.execute("UPDATE ventas SET total = ?, recibido = ? WHERE id = ?", (float(total), recibido, venta_id))
    log.info("Venta #%d: %.2f (%s) por %s%s", venta_id, float(total), metodo, c.user["usuario"], " [CON FALTANTE DE STOCK]" if faltantes else "")
    return detalle_venta(c.conn, venta_id, c.admin)


@ruta("GET", r"/api/ventas", "usuario")
def ventas_lista(c):
    desde = to_fecha(c.q.get("desde"), "desde") or hoy()
    hasta = to_fecha(c.q.get("hasta"), "hasta") or desde
    cond, params = "date(v.fecha) BETWEEN ? AND ?", [desde, hasta]
    if not c.admin:  # el cajero solo ve sus ventas de hoy
        cond += " AND v.usuario_id = ? AND date(v.fecha) = ?"
        params += [c.user["id"], hoy()]
    lista = filas(c.conn, "SELECT v.id, v.fecha, v.total, v.metodo_pago, v.cliente, v.anulada, v.fiado_pagado_fecha, u.nombre AS usuario, "
                          "(SELECT COUNT(DISTINCT d.producto_id) FROM detalle_ventas d WHERE d.venta_id = v.id) AS productos "
                          "FROM ventas v JOIN usuarios u ON u.id = v.usuario_id WHERE %s ORDER BY v.id DESC LIMIT 1000" % cond, params)
    por_metodo, total, n = {}, Decimal("0"), 0
    for v in lista:
        v["anulada"] = bool(v["anulada"])
        if not v["anulada"]:
            por_metodo[v["metodo_pago"]] = por_metodo.get(v["metodo_pago"], 0) + v["total"]
            total += D(v["total"])
            n += 1
    return {"ventas": lista, "total": float(total), "cantidad": n, "por_metodo": {k: r2(x) for k, x in por_metodo.items()}}


@ruta("GET", r"/api/ventas/(\d+)", "usuario")
def ventas_uno(c):
    v = detalle_venta(c.conn, int(c.m[0]), c.admin)
    if not c.admin and (v["usuario_id"] != c.user["id"] or v["fecha"][:10] != hoy()):
        raise ApiError(403, "No tiene permiso para ver esta venta")
    return v


@ruta("POST", r"/api/ventas/(\d+)/anular")
def ventas_anular(c):
    vid = int(c.m[0])
    motivo = to_texto(c.body, "motivo", 200, nombre="motivo de la anulacion")
    with tx(c.conn):
        v = c.conn.execute("SELECT * FROM ventas WHERE id = ?", (vid,)).fetchone()
        if not v:
            raise ApiError(404, "Venta no encontrada")
        if v["anulada"]:
            raise ApiError(409, "Esta venta ya estaba anulada")
        for d in c.conn.execute("SELECT * FROM detalle_ventas WHERE venta_id = ?", (vid,)).fetchall():
            if d["lote_id"]:
                lote = c.conn.execute("SELECT cantidad_actual FROM lotes WHERE id = ?", (d["lote_id"],)).fetchone()
                c.conn.execute("UPDATE lotes SET cantidad_actual = ? WHERE id = ?", (r3(lote["cantidad_actual"] + d["cantidad"]), d["lote_id"]))
            c.conn.execute("INSERT INTO movimientos_inventario(producto_id, lote_id, tipo, cantidad, fecha, usuario_id, motivo) "
                           "VALUES(?,?, 'anulacion', ?, ?, ?, ?)",
                           (d["producto_id"], d["lote_id"], d["cantidad"] if d["lote_id"] else 0, ahora(), c.user["id"],
                            "Anulacion de venta #%d: %s" % (vid, motivo)))
        c.conn.execute("UPDATE ventas SET anulada=1, anulada_por=?, anulada_fecha=?, anulada_motivo=? WHERE id=?",
                       (c.user["id"], ahora(), motivo, vid))
    log.info("Venta #%d anulada por %s: %s", vid, c.user["usuario"], motivo)
    return {"ok": True}


@ruta("GET", r"/api/fiados", "usuario")
def fiados_lista(c):
    lista = filas(c.conn, "SELECT v.id, v.fecha, v.total, v.cliente FROM ventas v WHERE v.metodo_pago = 'fiado' "
                          "AND v.anulada = 0 AND v.fiado_pagado_fecha IS NULL ORDER BY v.cliente COLLATE NOCASE, v.id")
    clientes = {}
    for v in lista:
        k = norm(v["cliente"])
        g = clientes.setdefault(k, {"cliente": v["cliente"], "total": Decimal("0"), "ventas": []})
        g["total"] += D(v["total"])
        g["ventas"].append(v)
    salida = [{"cliente": g["cliente"], "total": float(g["total"]), "ventas": g["ventas"]} for g in clientes.values()]
    return {"clientes": salida, "total": float(sum(D(g["total"]) for g in salida))}


@ruta("POST", r"/api/fiados/cobrar", "usuario")
def fiados_cobrar(c):
    ids = c.body.get("ids")
    if not isinstance(ids, list) or not ids:
        raise ApiError(400, "No se indicaron ventas")
    with tx(c.conn):
        for i in ids:
            c.conn.execute("UPDATE ventas SET fiado_pagado_fecha = ? WHERE id = ? AND metodo_pago = 'fiado' AND anulada = 0 "
                           "AND fiado_pagado_fecha IS NULL", (ahora(), to_id(i, "venta")))
    log.info("Fiados cobrados (%s) por %s", ids, c.user["usuario"])
    return {"ok": True}


# ============================================================ inventario
@ruta("GET", r"/api/inventario/lotes")
def lotes_lista(c):
    pid = to_id(c.q.get("producto_id"), "producto_id")
    todos = c.q.get("todos") == "1"
    return filas(c.conn, "SELECT id, cantidad_inicial, cantidad_actual, costo_unitario, fecha_vencimiento, fecha_ingreso, "
                         "CASE WHEN fecha_vencimiento IS NOT NULL AND fecha_vencimiento < ? THEN 1 ELSE 0 END AS vencido "
                         "FROM lotes WHERE producto_id = ? %s ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento, id"
                         % ("" if todos else "AND cantidad_actual > 0"), (hoy(), pid))


@ruta("POST", r"/api/inventario/ajuste")
def inventario_ajuste(c):
    b = c.body
    lote_id = to_id(b.get("lote_id"), "lote")
    tipo = b.get("tipo")
    if tipo not in ("merma", "vencido", "ajuste"):
        raise ApiError(400, "Tipo de ajuste invalido")
    motivo = to_texto(b, "motivo", 200, obligatorio=(tipo != "vencido"), nombre="motivo")
    with tx(c.conn):
        lote = c.conn.execute("SELECT * FROM lotes WHERE id = ?", (lote_id,)).fetchone()
        if not lote:
            raise ApiError(404, "Lote no encontrado")
        cantidad = r3(to_num(b.get("cantidad"), "cantidad", 0, 10000000))
        actual = lote["cantidad_actual"]
        if tipo == "ajuste":
            nueva = cantidad
        else:
            if cantidad <= 0:
                raise ApiError(400, "La cantidad debe ser mayor que cero")
            if cantidad > actual + 1e-9:
                raise ApiError(400, "Solo quedan %s en ese lote" % actual)
            nueva = r3(actual - cantidad)
        diff = r3(nueva - actual)
        if diff == 0:
            return {"ok": True, "cambio": 0}
        c.conn.execute("UPDATE lotes SET cantidad_actual = ? WHERE id = ?", (nueva, lote_id))
        c.conn.execute("INSERT INTO movimientos_inventario(producto_id, lote_id, tipo, cantidad, fecha, usuario_id, motivo) VALUES(?,?,?,?,?,?,?)",
                       (lote["producto_id"], lote_id, tipo, diff, ahora(), c.user["id"], motivo))
    log.info("Ajuste de inventario (%s) lote %d: %+g por %s", tipo, lote_id, diff, c.user["usuario"])
    return {"ok": True, "cambio": diff}


@ruta("GET", r"/api/inventario/movimientos")
def movimientos_lista(c):
    cond, params = [], []
    if c.q.get("producto_id", "").isdigit():
        cond.append("m.producto_id = ?")
        params.append(int(c.q["producto_id"]))
    limite = min(int(c.q.get("limite", 200) or 200), 1000)
    return filas(c.conn, "SELECT m.id, m.fecha, p.nombre AS producto, p.unidad, m.tipo, m.cantidad, m.motivo, u.nombre AS usuario, m.lote_id "
                         "FROM movimientos_inventario m JOIN productos p ON p.id = m.producto_id LEFT JOIN usuarios u ON u.id = m.usuario_id "
                         "%s ORDER BY m.id DESC LIMIT %d" % ("WHERE " + " AND ".join(cond) if cond else "", limite), params)


@ruta("GET", r"/api/alertas", "usuario")
def alertas(c):
    h = hoy()
    venc = filas(c.conn, "SELECT p.id AS producto_id, p.nombre, p.unidad, l.id AS lote_id, l.cantidad_actual AS cantidad, "
                         "l.fecha_vencimiento, CAST(julianday(l.fecha_vencimiento) - julianday(:h) AS INTEGER) AS dias "
                         "FROM lotes l JOIN productos p ON p.id = l.producto_id "
                         "WHERE l.cantidad_actual > 0 AND l.fecha_vencimiento IS NOT NULL "
                         "AND l.fecha_vencimiento <= date(:h, '+' || p.dias_alerta_venc || ' day') ORDER BY l.fecha_vencimiento", {"h": h})
    for v in venc:
        v["estado"] = "vencido" if v["dias"] < 0 else "por_vencer"
    bajo = [p for p in consultar_productos(c.conn, c.admin, limite=2000) if p["stock_minimo"] > 0 and p["stock"] <= p["stock_minimo"]]
    sin_stock = 0
    if c.admin:
        sin_stock = c.conn.execute("SELECT COUNT(*) FROM detalle_ventas d JOIN ventas v ON v.id = d.venta_id WHERE d.sin_stock = 1 "
                                   "AND v.anulada = 0 AND date(v.fecha) >= date(?, '-30 day')", (h,)).fetchone()[0]
    return {"vencimientos": venc, "stock_bajo": [{"id": p["id"], "nombre": p["nombre"], "unidad": p["unidad"], "stock": p["stock"],
                                                  "stock_minimo": p["stock_minimo"]} for p in bajo],
            "ventas_sin_stock": sin_stock,
            "resumen": {"vencidos": sum(1 for v in venc if v["estado"] == "vencido"),
                        "por_vencer": sum(1 for v in venc if v["estado"] == "por_vencer"),
                        "stock_bajo": len(bajo)}}


# ============================================================ gastos
@ruta("GET", r"/api/gastos")
def gastos_lista(c):
    desde = to_fecha(c.q.get("desde"), "desde") or hoy()[:8] + "01"
    hasta = to_fecha(c.q.get("hasta"), "hasta") or hoy()
    lista = filas(c.conn, "SELECT g.id, g.fecha, g.concepto, g.monto, u.nombre AS usuario FROM gastos g LEFT JOIN usuarios u ON u.id = g.usuario_id "
                          "WHERE g.fecha BETWEEN ? AND ? ORDER BY g.fecha DESC, g.id DESC", (desde, hasta))
    return {"gastos": lista, "total": r2(sum(D(g["monto"]) for g in lista))}


@ruta("POST", r"/api/gastos")
def gastos_crear(c):
    b = c.body
    with tx(c.conn):
        cur = c.conn.execute("INSERT INTO gastos(fecha, concepto, monto, usuario_id) VALUES(?,?,?,?)",
                             (to_fecha(b.get("fecha"), "fecha") or hoy(), to_texto(b, "concepto", 150),
                              r2(to_num(b.get("monto"), "monto", 0, 100000000)), c.user["id"]))
    return {"id": cur.lastrowid}


@ruta("DELETE", r"/api/gastos/(\d+)")
def gastos_borrar(c):
    with tx(c.conn):
        c.conn.execute("DELETE FROM gastos WHERE id = ?", (int(c.m[0]),))
    log.info("Gasto %s eliminado por %s", c.m[0], c.user["usuario"])
    return {"ok": True}


# ============================================================ reportes
@ruta("GET", r"/api/reportes/resumen")
def reporte_resumen(c):
    desde = to_fecha(c.q.get("desde"), "desde") or hoy()
    hasta = to_fecha(c.q.get("hasta"), "hasta") or desde
    p = (desde, hasta)
    v = c.conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM ventas WHERE anulada = 0 AND date(fecha) BETWEEN ? AND ?", p).fetchone()
    cst = c.conn.execute("SELECT COALESCE(SUM(d.cantidad * d.costo_unitario),0) FROM detalle_ventas d JOIN ventas v ON v.id = d.venta_id "
                         "WHERE v.anulada = 0 AND date(v.fecha) BETWEEN ? AND ?", p).fetchone()[0]
    gastos = c.conn.execute("SELECT COALESCE(SUM(monto),0) FROM gastos WHERE fecha BETWEEN ? AND ?", p).fetchone()[0]
    ganancia = r2(D(v["total"]) - D(cst))
    por_dia = filas(c.conn, "SELECT date(v.fecha) AS dia, SUM(d.subtotal) AS ventas, SUM(d.cantidad * d.costo_unitario) AS costo "
                            "FROM detalle_ventas d JOIN ventas v ON v.id = d.venta_id WHERE v.anulada = 0 AND date(v.fecha) BETWEEN ? AND ? "
                            "GROUP BY date(v.fecha) ORDER BY dia", p)
    for d in por_dia:
        d["ventas"], d["costo"] = r2(d["ventas"]), r2(d["costo"])
        d["ganancia"] = r2(D(d["ventas"]) - D(d["costo"]))
    top = filas(c.conn, "SELECT p.id, p.nombre, p.unidad, SUM(d.cantidad) AS cantidad, SUM(d.subtotal) AS ventas, "
                        "SUM(d.subtotal - d.cantidad * d.costo_unitario) AS ganancia "
                        "FROM detalle_ventas d JOIN ventas v ON v.id = d.venta_id JOIN productos p ON p.id = d.producto_id "
                        "WHERE v.anulada = 0 AND date(v.fecha) BETWEEN ? AND ? GROUP BY p.id ORDER BY ventas DESC LIMIT 10", p)
    for t in top:
        t["cantidad"], t["ventas"], t["ganancia"] = r3(t["cantidad"]), r2(t["ventas"]), r2(t["ganancia"])
    por_metodo = filas(c.conn, "SELECT metodo_pago, COUNT(*) AS n, SUM(total) AS total FROM ventas WHERE anulada = 0 "
                               "AND date(fecha) BETWEEN ? AND ? GROUP BY metodo_pago", p)
    for m in por_metodo:
        m["total"] = r2(m["total"])
    inv = c.conn.execute("SELECT COALESCE(SUM(cantidad_actual * costo_unitario),0), "
                         "COALESCE(SUM(CASE WHEN fecha_vencimiento < ? THEN cantidad_actual * costo_unitario ELSE 0 END),0) "
                         "FROM lotes WHERE cantidad_actual > 0", (hoy(),)).fetchone()
    sin_rot = filas(c.conn, "SELECT p.id, p.nombre, p.unidad, SUM(l.cantidad_actual) AS stock, SUM(l.cantidad_actual * l.costo_unitario) AS valor "
                            "FROM productos p JOIN lotes l ON l.producto_id = p.id AND l.cantidad_actual > 0 WHERE p.activo = 1 AND NOT EXISTS "
                            "(SELECT 1 FROM detalle_ventas d JOIN ventas v2 ON v2.id = d.venta_id WHERE d.producto_id = p.id AND v2.anulada = 0 "
                            "AND date(v2.fecha) >= date(?, '-60 day')) GROUP BY p.id ORDER BY valor DESC LIMIT 20", (hoy(),))
    for s in sin_rot:
        s["stock"], s["valor"] = r3(s["stock"]), r2(s["valor"])
    fiados = c.conn.execute("SELECT COALESCE(SUM(total),0) FROM ventas WHERE metodo_pago='fiado' AND anulada=0 AND fiado_pagado_fecha IS NULL").fetchone()[0]
    return {"desde": desde, "hasta": hasta, "num_ventas": v["n"], "ventas": r2(v["total"]), "costo": r2(cst),
            "ganancia_bruta": ganancia, "gastos": r2(gastos), "utilidad": r2(D(ganancia) - D(gastos)),
            "ticket_promedio": r2(D(v["total"]) / v["n"]) if v["n"] else 0, "por_dia": por_dia, "top_productos": top,
            "por_metodo": por_metodo, "valor_inventario": r2(inv[0]), "valor_vencido": r2(inv[1]),
            "sin_rotacion": sin_rot, "fiados_por_cobrar": r2(fiados)}


@ruta("GET", r"/api/exportar/(productos|ventas|inventario|gastos)\.csv")
def exportar(c):
    tipo = c.m[0]
    desde = to_fecha(c.q.get("desde"), "desde") or "2000-01-01"
    hasta = to_fecha(c.q.get("hasta"), "hasta") or "2100-01-01"
    if tipo == "productos":
        cab = ["id", "nombre", "categoria", "unidad", "precio_venta", "stock", "stock_minimo", "ultimo_costo", "codigos"]
        datos = [[p["id"], p["nombre"], p["categoria"] or "", p["unidad"], p["precio_venta"], p["stock"], p["stock_minimo"],
                  p.get("ultimo_costo") if p.get("ultimo_costo") is not None else "", " ".join(p["codigos"])]
                 for p in consultar_productos(c.conn, True, inactivos=True, limite=100000)]
    elif tipo == "ventas":
        cab = ["venta", "fecha", "cajero", "metodo_pago", "cliente", "anulada", "producto", "cantidad", "precio", "subtotal", "costo"]
        datos = [list(r) for r in c.conn.execute(
            "SELECT v.id, v.fecha, u.nombre, v.metodo_pago, COALESCE(v.cliente,''), v.anulada, p.nombre, SUM(d.cantidad), d.precio_unitario, "
            "SUM(d.subtotal), ROUND(SUM(d.cantidad * d.costo_unitario), 2) FROM ventas v JOIN usuarios u ON u.id = v.usuario_id "
            "JOIN detalle_ventas d ON d.venta_id = v.id JOIN productos p ON p.id = d.producto_id WHERE date(v.fecha) BETWEEN ? AND ? "
            "GROUP BY v.id, d.producto_id, d.precio_unitario ORDER BY v.id", (desde, hasta))]
    elif tipo == "inventario":
        cab = ["producto", "lote", "ingreso", "vence", "cantidad_inicial", "cantidad_actual", "costo_unitario", "valor"]
        datos = [list(r) for r in c.conn.execute(
            "SELECT p.nombre, l.id, l.fecha_ingreso, COALESCE(l.fecha_vencimiento,''), l.cantidad_inicial, l.cantidad_actual, l.costo_unitario, "
            "ROUND(l.cantidad_actual * l.costo_unitario, 2) FROM lotes l JOIN productos p ON p.id = l.producto_id WHERE l.cantidad_actual > 0 "
            "ORDER BY p.nombre_norm, l.fecha_vencimiento")]
    else:
        cab = ["fecha", "concepto", "monto"]
        datos = [list(r) for r in c.conn.execute("SELECT fecha, concepto, monto FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha", (desde, hasta))]
    return archivo("bodega-%s-%s.csv" % (tipo, hoy()), csv_bytes(cab, datos), "text/csv; charset=utf-8")


# ============================================================ respaldos
def hacer_respaldo(destino):
    origen = sqlite3.connect(DB_PATH)
    try:
        dst = sqlite3.connect(destino)
        try:
            origen.backup(dst)
        finally:
            dst.close()
    finally:
        origen.close()


def respaldo_diario(forzar=False):
    nombre = "bodega-%s.db" % hoy()
    destino = os.path.join(DIR_RESPALDOS, nombre)
    creado = False
    if forzar or not os.path.exists(destino):
        tmp = destino + ".tmp"
        hacer_respaldo(tmp)
        os.replace(tmp, destino)
        creado = True
        log.info("Respaldo creado: %s", destino)
    archivos = sorted(f for f in os.listdir(DIR_RESPALDOS) if re.match(r"^bodega-\d{4}-\d{2}-\d{2}\.db$", f))
    for viejo in archivos[:-max(1, int(CONFIG["respaldos_dias"]))]:
        try:
            os.remove(os.path.join(DIR_RESPALDOS, viejo))
        except OSError:
            pass
    return nombre, creado


def hilo_respaldos():
    while True:
        try:
            respaldo_diario()
        except Exception:
            log.exception("Fallo el respaldo automatico")
        time.sleep(1800)


@ruta("GET", r"/api/respaldo/lista")
def respaldo_lista(c):
    out = []
    for f in sorted(os.listdir(DIR_RESPALDOS), reverse=True):
        if re.match(r"^bodega-\d{4}-\d{2}-\d{2}\.db$", f):
            st = os.stat(os.path.join(DIR_RESPALDOS, f))
            out.append({"nombre": f, "tamano": st.st_size, "fecha": datetime.fromtimestamp(st.st_mtime).strftime(FMT)})
    return {"carpeta": DIR_RESPALDOS, "respaldos": out}


@ruta("POST", r"/api/respaldo/crear")
def respaldo_crear(c):
    nombre, _ = respaldo_diario(forzar=True)
    return {"nombre": nombre, "carpeta": DIR_RESPALDOS}


@ruta("GET", r"/api/respaldo/descargar")
def respaldo_descargar(c):
    tmp = os.path.join(CONFIG["carpeta_datos"], "descarga-%s.tmp" % secrets.token_hex(4))
    try:
        hacer_respaldo(tmp)
        with open(tmp, "rb") as f:
            datos = f.read()
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    log.info("Respaldo descargado por %s", c.user["usuario"])
    return archivo("bodega-giselle-%s.db" % datetime.now().strftime("%Y-%m-%d_%H%M"), datos, "application/octet-stream")


# ============================================================ servidor HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "BodegaGiselle/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self._manejar("GET")

    def do_POST(self):
        self._manejar("POST")

    def do_PUT(self):
        self._manejar("PUT")

    def do_DELETE(self):
        self._manejar("DELETE")

    # -- respuesta
    def _enviar(self, status, raw, tipo, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _json(self, status, datos, extra=None):
        raw = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self._enviar(status, raw, "application/json; charset=utf-8", extra)

    def _error(self, status, mensaje, **extra):
        d = {"error": mensaje}
        d.update(extra)
        self._json(status, d)

    # -- logica
    def _manejar(self, metodo):
        conn = None
        try:
            url = urlparse(self.path)
            path = url.path
            query = {k: v[0] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
            try:
                largo = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                largo = 0
            if largo > MAX_BODY:
                self.close_connection = True
                return self._error(413, "Solicitud demasiado grande")
            raw = self.rfile.read(largo) if largo else b""

            if metodo == "GET" and (path in ("/", "/index.html") or path.startswith("/static/")):
                nombre = "index.html" if path in ("/", "/index.html") else path[len("/static/"):]
                if not re.match(r"^[a-z0-9_-]+\.(html|js|css|svg|png|ico)$", nombre):  # sin rutas: evita salirse de la carpeta
                    return self._error(404, "No encontrado")
                try:
                    with open(os.path.join(RES_DIR, "static", nombre), "rb") as f:
                        contenido = f.read()
                except OSError:
                    return self._error(404, "No encontrado")
                tipos = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                         "svg": "image/svg+xml", "png": "image/png", "ico": "image/x-icon"}
                return self._enviar(200, contenido, tipos[nombre.rsplit(".", 1)[1]], [
                    ("Content-Security-Policy",
                     "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                     "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")])
            if metodo == "GET" and path == "/favicon.ico":
                return self._enviar(204, b"", "image/x-icon")
            if not path.startswith("/api/"):
                return self._error(404, "No encontrado")

            if metodo != "GET":
                origen = self.headers.get("Origin")
                if origen and urlparse(origen).netloc != self.headers.get("Host"):
                    return self._error(403, "Origen no permitido")

            cuerpo = {}
            if raw:
                try:
                    cuerpo = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return self._error(400, "JSON invalido")
                if not isinstance(cuerpo, dict):
                    return self._error(400, "Se esperaba un objeto JSON")

            destino, hay_ruta = None, False
            for m_, rx, acceso, fn in ROUTES:
                mt = rx.match(path)
                if mt:
                    hay_ruta = True
                    if m_ == metodo:
                        destino = (mt, acceso, fn)
                        break
            if not destino:
                return self._error(405 if hay_ruta else 404, "Ruta no valida")
            mt, acceso, fn = destino

            conn = conectar()
            token = None
            if self.headers.get("Cookie"):
                try:
                    ck = http.cookies.SimpleCookie(self.headers["Cookie"])
                    token = ck[COOKIE].value if COOKIE in ck else None
                except http.cookies.CookieError:
                    token = None
            user = usuario_de_sesion(conn, token)
            if acceso and not user:
                return self._error(401, "Debe iniciar sesion", codigo="sin_sesion")
            if acceso == "admin" and user["rol"] != "admin":
                return self._error(403, "Solo el administrador puede hacer esto")

            ip = self.client_address[0]
            https = (self.headers.get("X-Forwarded-Proto") == "https")
            ctx = Ctx(conn, user, cuerpo, query, mt.groups(), ip, https)
            ctx.token = hash_token(token) if token else None
            res = fn(ctx)

            extra = []
            for nombre, valor, edad in ctx.cookies_nuevas:
                extra.append(("Set-Cookie", "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d%s" %
                              (nombre, valor, edad, "; Secure" if https else "")))
            if isinstance(res, Respuesta):
                if res.raw is not None:
                    return self._enviar(res.status, res.raw, res.tipo or "application/octet-stream",
                                        extra + list(res.cabeceras.items()))
                return self._json(res.status, res.datos, extra)
            return self._json(200, res, extra)
        except ApiError as e:
            self._error(e.status, e.mensaje, **e.extra)
        except sqlite3.IntegrityError as e:
            log.warning("Error de integridad: %s", e)
            self._error(409, "Los datos no son validos o ya existen (%s)" % e)
        except sqlite3.OperationalError as e:
            log.exception("Error de base de datos")
            self._error(503, "La base de datos esta ocupada o no disponible, intente de nuevo (%s)" % e)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error("Error inesperado en %s %s\n%s", metodo, self.path, traceback.format_exc())
            try:
                self._error(500, "Error interno del servidor. Revise el archivo bodega.log")
            except Exception:
                pass
        finally:
            if conn:
                conn.close()


# ============================================================ arranque
def cargar_config(ruta_ini):
    if ruta_ini and os.path.exists(ruta_ini):
        cp = configparser.ConfigParser()
        cp.read(ruta_ini, encoding="utf-8")
        g = cp.get
        CONFIG["host"] = g("servidor", "host", fallback=CONFIG["host"]).strip()
        CONFIG["puerto"] = cp.getint("servidor", "puerto", fallback=CONFIG["puerto"])
        carpeta = g("datos", "carpeta", fallback="").strip()
        if carpeta:
            CONFIG["carpeta_datos"] = carpeta if os.path.isabs(carpeta) else os.path.join(os.path.dirname(os.path.abspath(ruta_ini)), carpeta)
        CONFIG["respaldos_dias"] = cp.getint("datos", "respaldos_dias", fallback=CONFIG["respaldos_dias"])
        CONFIG["negocio"] = g("negocio", "nombre", fallback=CONFIG["negocio"]).strip()
        CONFIG["moneda"] = g("negocio", "moneda", fallback=CONFIG["moneda"]).strip()
        CONFIG["horas_sesion"] = cp.getint("seguridad", "horas_sesion", fallback=CONFIG["horas_sesion"])


def configurar_logs():
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    log.setLevel(logging.INFO)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    log.addHandler(sh)
    try:
        fh = logging.handlers.RotatingFileHandler(os.path.join(CONFIG["carpeta_datos"], "bodega.log"),
                                                  maxBytes=1000000, backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
    except OSError as e:
        print("Aviso: no se pudo crear el archivo de registro:", e)


def restaurar(archivo_db):
    if not os.path.isfile(archivo_db):
        sys.exit("No existe el archivo: %s" % archivo_db)
    try:
        c = sqlite3.connect(archivo_db)
        ok = c.execute("PRAGMA integrity_check").fetchone()[0]
        c.execute("SELECT COUNT(*) FROM productos")
        c.close()
    except sqlite3.Error as e:
        sys.exit("El archivo no es un respaldo valido de Bodega Giselle: %s" % e)
    if ok != "ok":
        sys.exit("El respaldo esta danado: %s" % ok)
    if os.path.exists(DB_PATH):
        copia = DB_PATH + ".antes-de-restaurar-" + datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(DB_PATH, copia)
        print("Se guardo una copia de la base actual en:", copia)
    for suf in ("-wal", "-shm"):
        if os.path.exists(DB_PATH + suf):
            os.remove(DB_PATH + suf)
    shutil.copy2(archivo_db, DB_PATH)
    print("Base de datos restaurada desde:", archivo_db)


def main():
    global DB_PATH, DIR_RESPALDOS
    ap = argparse.ArgumentParser(description="Bodega Giselle - inventario y ventas")
    ap.add_argument("--config", help="ruta de config.ini")
    ap.add_argument("--host")
    ap.add_argument("--puerto", type=int)
    ap.add_argument("--datos", help="carpeta de datos")
    ap.add_argument("--abrir", action="store_true", help="abrir el navegador al iniciar")
    ap.add_argument("--respaldo", action="store_true", help="crear un respaldo y salir")
    ap.add_argument("--restaurar", metavar="ARCHIVO", help="restaurar la base de datos desde un respaldo")
    ap.add_argument("--version", action="store_true")
    a = ap.parse_args()
    if a.version:
        print(VERSION)
        return
    cargar_config(a.config or os.path.join(APP_DIR, "config.ini"))
    if a.host:
        CONFIG["host"] = a.host
    if a.puerto:
        CONFIG["puerto"] = a.puerto
    if a.datos:
        CONFIG["carpeta_datos"] = os.path.abspath(a.datos)
    DB_PATH = os.path.join(CONFIG["carpeta_datos"], "bodega.db")
    DIR_RESPALDOS = os.path.join(CONFIG["carpeta_datos"], "respaldos")
    os.makedirs(CONFIG["carpeta_datos"], exist_ok=True)

    if a.restaurar:
        restaurar(a.restaurar)
        return
    configurar_logs()
    init_db()
    if a.respaldo:
        nombre, _ = respaldo_diario(forzar=True)
        print("Respaldo creado:", os.path.join(DIR_RESPALDOS, nombre))
        return

    try:
        servidor = ThreadingHTTPServer((CONFIG["host"], CONFIG["puerto"]), Handler)
    except OSError as e:
        log.error("No se pudo abrir el puerto %s en %s: %s. Puede que el programa ya este abierto.", CONFIG["puerto"], CONFIG["host"], e)
        sys.exit(1)
    servidor.daemon_threads = True
    threading.Thread(target=hilo_respaldos, daemon=True).start()

    pidfile = os.path.join(CONFIG["carpeta_datos"], "servidor.pid")
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))

    def detener(*_):
        log.info("Deteniendo el servidor...")
        threading.Thread(target=servidor.shutdown, daemon=True).start()
    for s in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, s):
            try:
                signal.signal(getattr(signal, s), detener)
            except (ValueError, OSError):
                pass

    visible = "localhost" if CONFIG["host"] in ("0.0.0.0", "127.0.0.1", "::") else CONFIG["host"]
    url = "http://%s:%d" % (visible, CONFIG["puerto"])
    log.info("Bodega Giselle %s en marcha: %s", VERSION, url)
    log.info("Datos en: %s", CONFIG["carpeta_datos"])
    if CONFIG["host"] not in ("127.0.0.1", "localhost"):
        log.info("El servidor acepta conexiones de otros equipos de la red.")
    if a.abrir:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        servidor.serve_forever()
    finally:
        servidor.server_close()
        try:
            os.remove(pidfile)
        except OSError:
            pass
        log.info("Servidor detenido.")


if __name__ == "__main__":
    main()
