/* ============================================================
   Servidor simulado para la versión web de prueba.
   Reemplaza fetch('/api/...') y guarda todo en el navegador (localStorage).
   Es un puerto a JavaScript de la lógica de app/servidor.py.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'bg_demo_db_v1', TOK = 'bg_demo_sesion_v1';
  const HORAS_SESION = 12;
  class ApiErr extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; } }

  /* ---------- utilidades ---------- */
  const p2 = n => String(n).padStart(2, '0');
  const ahora = () => { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
  const hoy = () => ahora().slice(0, 10);
  const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  const difDias = (a, b) => Math.trunc((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
  const norm = t => String(t == null ? '' : t).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const rn = (x, k) => { const n = Number(x); if (!n) return 0; const f = Math.pow(10, k); return Math.sign(n) * Math.round((Math.abs(n) + 1e-9) * f) / f; };
  const r2 = x => rn(x, 2), r3 = x => rn(x, 3);
  const dinero = (c, p) => r2(c * p);
  const clone = o => JSON.parse(JSON.stringify(o));
  const RE_CODIGO = /^[A-Za-z0-9._\-/]{1,40}$/, RE_USUARIO = /^[A-Za-z0-9._-]{3,30}$/;

  const toNum = (v, campo, min, max, def) => {
    if (v === null || v === undefined || v === '') { if (def !== undefined) return def; throw new ApiErr(400, 'Falta el numero: ' + campo); }
    if (typeof v === 'boolean') throw new ApiErr(400, 'Numero invalido: ' + campo);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ApiErr(400, 'Numero invalido: ' + campo);
    if (min !== undefined && min !== null && n < min) throw new ApiErr(400, campo + ' no puede ser menor que ' + min);
    if (max !== undefined && max !== null && n > max) throw new ApiErr(400, campo + ' no puede ser mayor que ' + max);
    return n;
  };
  const toId = (v, campo) => { const n = parseInt(v, 10); if (!(n > 0)) throw new ApiErr(400, 'Identificador invalido: ' + (campo || 'id')); return n; };
  const toTexto = (d, campo, maxlen, obligatorio, nombre) => {
    if (obligatorio === undefined) obligatorio = true;
    const v = d[campo];
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) { if (obligatorio) throw new ApiErr(400, 'Falta el campo: ' + (nombre || campo)); return null; }
    const s = String(v).trim();
    if (s.length > (maxlen || 150)) throw new ApiErr(400, (nombre || campo) + ' es demasiado largo (maximo ' + (maxlen || 150) + ')');
    return s;
  };
  const toFecha = (v, campo, obligatorio) => {
    if (!v) { if (obligatorio) throw new ApiErr(400, 'Falta la fecha: ' + campo); return null; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(Date.parse(v))) throw new ApiErr(400, 'Fecha invalida en ' + campo + ' (use AAAA-MM-DD)');
    const y = +String(v).slice(0, 4);
    if (y < 2000 || y > 2100) throw new ApiErr(400, 'Fecha fuera de rango en ' + campo);
    return String(v);
  };
  const toBool = v => v === true || v === 1 || ['1', 'true', 'True', 'si', 'on'].includes(v);
  const ean13Digito = doce => { let s = 0; for (let i = 0; i < doce.length; i++) s += +doce[i] * (i % 2 ? 3 : 1); return String((10 - s % 10) % 10); };
  const codigoInterno = id => { const b = '2' + String(id).padStart(11, '0'); return b + ean13Digito(b); };

  async function hashPass(p, salt) {
    salt = salt || Math.random().toString(36).slice(2) + Date.now().toString(36);
    let h;
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + p));
      h = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { let x = 5381; const s = salt + '|' + p; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; h = 'f' + (x >>> 0).toString(16); }
    return 'demo$' + salt + '$' + h;
  }
  async function verificarPass(p, alm) { const s = String(alm).split('$'); if (s.length !== 3) return false; return (await hashPass(p, s[1])) === alm; }
  const validarPass = p => { if (typeof p !== 'string' || p.length < 6) throw new ApiErr(400, 'La contrasena debe tener al menos 6 caracteres'); if (p.length > 100) throw new ApiErr(400, 'La contrasena es demasiado larga'); };

  /* ---------- almacenamiento ---------- */
  const TABLAS = ['usuarios', 'categorias', 'proveedores', 'productos', 'codigos', 'compras', 'lotes', 'ventas', 'detalle', 'movs', 'gastos', 'respaldos'];
  function vacia() { const d = { config: {} }; TABLAS.forEach(t => { d[t] = []; }); d.seq = {}; return d; }
  let DB = (() => { try { const t = localStorage.getItem(KEY); if (t) { const d = JSON.parse(t); if (d && d.seq) return d; } } catch (e) { /* sin almacenamiento */ } return vacia(); })();
  let sesionMem = null;
  const guardar = () => { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { /* sigue en memoria */ } };
  const nextId = t => { DB.seq[t] = (DB.seq[t] || 0) + 1; return DB.seq[t]; };
  const ins = (t, o) => { o.id = nextId(t); DB[t].push(o); return o; };
  const porId = (t, id) => DB[t].find(x => x.id === id);
  const leerSesion = () => { try { const t = localStorage.getItem(TOK); if (t) return JSON.parse(t); } catch (e) { /* ignorar */ } return sesionMem; };
  const ponerSesion = s => { sesionMem = s; try { if (s) localStorage.setItem(TOK, JSON.stringify(s)); else localStorage.removeItem(TOK); } catch (e) { /* ignorar */ } };

  function leerConfig() { return Object.assign({ negocio: 'Bodega Giselle', moneda: 'L', ticket_pie: 'Gracias por su compra', telefono: '' }, DB.config); }
  function usuarioDeSesion() {
    const s = leerSesion();
    if (!s || !s.uid || s.exp <= Date.now()) return null;
    const u = porId('usuarios', s.uid);
    if (!u || !u.activo) return null;
    return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol };
  }
  const nombreUsuario = id => { const u = porId('usuarios', id); return u ? u.nombre : null; };

  /* ---------- productos ---------- */
  const stockLotes = (pid, h) => DB.lotes.filter(l => l.producto_id === pid && (!l.fecha_vencimiento || l.fecha_vencimiento >= h)).reduce((s, l) => s + l.cantidad_actual, 0);
  function filaProducto(p, admin, h) {
    const cat = p.categoria_id ? porId('categorias', p.categoria_id) : null;
    const lotes = DB.lotes.filter(l => l.producto_id === p.id);
    const ult = lotes.length ? lotes.reduce((a, b) => (b.id > a.id ? b : a)).costo_unitario : null;
    const d = {
      id: p.id, nombre: p.nombre, categoria_id: p.categoria_id || null, categoria: cat ? cat.nombre : null, unidad: p.unidad,
      se_vende_por_peso: !!p.se_vende_por_peso, precio_venta: p.precio_venta, stock_minimo: p.stock_minimo, dias_alerta_venc: p.dias_alerta_venc,
      unidad_compra: p.unidad_compra || null, factor_conversion: p.factor_conversion, activo: !!p.activo,
      stock: r3(stockLotes(p.id, h)), stock_vencido: r3(lotes.filter(l => l.fecha_vencimiento && l.fecha_vencimiento < h).reduce((s, l) => s + l.cantidad_actual, 0)),
      ultimo_costo: ult, codigos: DB.codigos.filter(c => c.producto_id === p.id).map(c => c.codigo)
    };
    if (!admin) delete d.ultimo_costo;
    return d;
  }
  function consultarProductos(admin, o) {
    o = o || {}; const h = hoy();
    let lista = DB.productos.slice();
    if (o.producto_id != null) lista = lista.filter(p => p.id === o.producto_id);
    if (o.codigo != null) { const c = DB.codigos.find(x => x.codigo === o.codigo); lista = c ? lista.filter(p => p.id === c.producto_id) : []; }
    if (!o.inactivos) lista = lista.filter(p => p.activo);
    if (o.categoria_id) lista = lista.filter(p => p.categoria_id === o.categoria_id);
    if (o.q) {
      const toks = norm(o.q).split(' ').slice(0, 6);
      lista = lista.filter(p => toks.every(t => p.nombre_norm.includes(t) || DB.codigos.some(c => c.producto_id === p.id && c.codigo.toLowerCase().startsWith(t))));
    }
    lista.sort((a, b) => (a.nombre_norm < b.nombre_norm ? -1 : a.nombre_norm > b.nombre_norm ? 1 : 0));
    return lista.slice(0, o.limite || 600).map(p => filaProducto(p, admin, h));
  }
  function obtenerOCrearCategoria(nombre) {
    const c = DB.categorias.find(x => x.nombre.toLowerCase() === nombre.toLowerCase());
    return c ? c.id : ins('categorias', { nombre }).id;
  }
  function leerProducto(b, parcial) {
    const c = {}; const tiene = k => (parcial ? k in b : true);
    if (tiene('nombre')) { c.nombre = toTexto(b, 'nombre', 150, true, 'nombre del producto'); c.nombre_norm = norm(c.nombre); }
    if ('categoria' in b && b.categoria) c.categoria_id = obtenerOCrearCategoria(toTexto(b, 'categoria', 60));
    else if ('categoria_id' in b) {
      let cid = b.categoria_id;
      if (cid) { cid = toId(cid, 'categoria'); if (!porId('categorias', cid)) throw new ApiErr(400, 'La categoria no existe'); }
      c.categoria_id = cid || null;
    }
    if (tiene('unidad')) c.unidad = toTexto(b, 'unidad', 20, false) || 'unidad';
    if (tiene('se_vende_por_peso')) c.se_vende_por_peso = toBool(b.se_vende_por_peso) ? 1 : 0;
    if (tiene('precio_venta')) c.precio_venta = r2(toNum(b.precio_venta, 'precio de venta', 0, 10000000));
    if (tiene('stock_minimo')) c.stock_minimo = r3(toNum(b.stock_minimo, 'stock minimo', 0, 10000000, 0));
    if (tiene('dias_alerta_venc')) c.dias_alerta_venc = Math.trunc(toNum(b.dias_alerta_venc, 'dias de alerta', 0, 3650, 30));
    if (tiene('unidad_compra')) c.unidad_compra = toTexto(b, 'unidad_compra', 20, false);
    if (tiene('factor_conversion')) c.factor_conversion = toNum(b.factor_conversion, 'factor de conversion', 0.0001, 100000, 1.0);
    return c;
  }
  function agregarCodigo(pid, codigo) {
    if (!RE_CODIGO.test(codigo)) throw new ApiErr(400, "Codigo invalido '" + codigo + "': use letras, numeros, punto, guion o barra (maximo 40)");
    const r = DB.codigos.find(c => c.codigo === codigo);
    if (r) { if (r.producto_id === pid) return; throw new ApiErr(409, 'El codigo ' + codigo + " ya pertenece a '" + porId('productos', r.producto_id).nombre + "'"); }
    DB.codigos.push({ codigo, producto_id: pid });
  }

  /* ---------- ventas ---------- */
  const METODOS = ['efectivo', 'tarjeta', 'transferencia', 'fiado'];
  function detalleVenta(id, admin) {
    const v0 = porId('ventas', id);
    if (!v0) throw new ApiErr(404, 'Venta no encontrada');
    const v = clone(v0); v.usuario = nombreUsuario(v.usuario_id);
    const grupos = new Map();
    DB.detalle.filter(d => d.venta_id === id).forEach(d => {
      const k = d.producto_id + '|' + d.precio_unitario;
      if (!grupos.has(k)) { const p = porId('productos', d.producto_id); grupos.set(k, { producto_id: d.producto_id, nombre: p.nombre, unidad: p.unidad, precio_unitario: d.precio_unitario, cantidad: 0, subtotal: 0, costo: 0, sin_stock: false }); }
      const g = grupos.get(k); g.cantidad += d.cantidad; g.subtotal += d.subtotal; g.costo += d.cantidad * d.costo_unitario; if (d.sin_stock) g.sin_stock = true;
    });
    v.lineas = Array.from(grupos.values()).map(g => { g.cantidad = r3(g.cantidad); g.subtotal = r2(g.subtotal); g.costo = r2(g.costo); if (!admin) delete g.costo; return g; });
    v.anulada = !!v.anulada;
    v.cambio = v.recibido !== null && v.recibido !== undefined && v.metodo_pago === 'efectivo' ? r2(v.recibido - v.total) : null;
    return v;
  }
  const mov = (pid, lid, tipo, cant, uid, motivo) => ins('movs', { producto_id: pid, lote_id: lid, tipo, cantidad: cant, fecha: ahora(), usuario_id: uid, motivo });

  /* ---------- rutas ---------- */
  const ROUTES = [];
  const ruta = (m, rx, acceso, fn) => ROUTES.push([m, new RegExp('^' + rx + '$'), acceso, fn]);
  const estado = c => { const cfg = leerConfig(); return { configurado: DB.usuarios.length > 0, version: '1.0.0-prueba', usuario: c.user, hoy: hoy(), negocio: cfg.negocio, moneda: cfg.moneda, ticket_pie: cfg.ticket_pie, telefono: cfg.telefono }; };
  const nuevaSesion = uid => ponerSesion({ uid, exp: Date.now() + HORAS_SESION * 36e5 });

  ruta('GET', '/api/estado', null, async c => estado(c));
  ruta('POST', '/api/setup', null, async c => {
    const b = c.body;
    const negocio = toTexto(b, 'negocio', 80, true, 'nombre del negocio'), nombre = toTexto(b, 'nombre', 80, true, 'su nombre'), usuario = toTexto(b, 'usuario', 30, true, 'usuario');
    if (!RE_USUARIO.test(usuario)) throw new ApiErr(400, 'El usuario debe tener de 3 a 30 letras, numeros, punto, guion o guion bajo');
    validarPass(b.password);
    const moneda = toTexto(b, 'moneda', 6, false) || 'L';
    if (DB.usuarios.length) throw new ApiErr(409, 'El sistema ya fue configurado');
    const u = ins('usuarios', { nombre, usuario, password_hash: await hashPass(b.password), rol: 'admin', activo: 1 });
    DB.config.negocio = negocio; DB.config.moneda = moneda;
    nuevaSesion(u.id); c.user = { id: u.id, nombre, usuario, rol: 'admin' };
    return estado(c);
  });
  ruta('POST', '/api/login', null, async c => {
    const usuario = String(c.body.usuario || '').trim(), pass = String(c.body.password || '');
    const u = DB.usuarios.find(x => x.usuario.toLowerCase() === usuario.toLowerCase() && x.activo);
    if (!u || !(await verificarPass(pass, u.password_hash))) throw new ApiErr(401, 'Usuario o contrasena incorrectos');
    nuevaSesion(u.id); c.user = { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol };
    return estado(c);
  });
  ruta('POST', '/api/logout', 'usuario', async () => { ponerSesion(null); return { ok: true }; });
  ruta('POST', '/api/cambiar-password', 'usuario', async c => {
    const u = porId('usuarios', c.user.id);
    if (!(await verificarPass(String(c.body.actual || ''), u.password_hash))) throw new ApiErr(400, 'La contrasena actual no es correcta');
    validarPass(c.body.nueva); u.password_hash = await hashPass(c.body.nueva);
    return { ok: true };
  });
  ruta('GET', '/api/config', 'usuario', async () => leerConfig());
  ruta('PUT', '/api/config', 'admin', async c => {
    const b = c.body;
    if ('negocio' in b) DB.config.negocio = toTexto(b, 'negocio', 80, true, 'nombre del negocio');
    if ('moneda' in b) DB.config.moneda = toTexto(b, 'moneda', 6, true, 'moneda');
    if ('ticket_pie' in b) DB.config.ticket_pie = toTexto(b, 'ticket_pie', 120, false) || '';
    if ('telefono' in b) DB.config.telefono = toTexto(b, 'telefono', 40, false) || '';
    return leerConfig();
  });

  ruta('GET', '/api/usuarios', 'admin', async () => DB.usuarios.slice().sort((a, b) => norm(a.nombre).localeCompare(norm(b.nombre))).map(u => ({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, activo: u.activo })));
  ruta('POST', '/api/usuarios', 'admin', async c => {
    const b = c.body, nombre = toTexto(b, 'nombre', 80), usuario = toTexto(b, 'usuario', 30);
    if (!RE_USUARIO.test(usuario)) throw new ApiErr(400, 'El usuario debe tener de 3 a 30 letras, numeros, punto, guion o guion bajo');
    const rol = b.rol || 'cajero';
    if (!['admin', 'cajero'].includes(rol)) throw new ApiErr(400, 'Rol invalido');
    validarPass(b.password);
    if (DB.usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase())) throw new ApiErr(409, 'Ese nombre de usuario ya existe');
    return { id: ins('usuarios', { nombre, usuario, password_hash: await hashPass(b.password), rol, activo: 1 }).id };
  });
  ruta('PUT', '/api/usuarios/(\\d+)', 'admin', async c => {
    const uid = +c.m[0], b = c.body, u = porId('usuarios', uid);
    if (!u) throw new ApiErr(404, 'Usuario no encontrado');
    const nombre = 'nombre' in b ? toTexto(b, 'nombre', 80) : u.nombre, rol = b.rol || u.rol;
    const activo = 'activo' in b ? (toBool(b.activo) ? 1 : 0) : u.activo;
    if (!['admin', 'cajero'].includes(rol)) throw new ApiErr(400, 'Rol invalido');
    if (uid === c.user.id && (rol !== 'admin' || !activo)) throw new ApiErr(400, 'No puede quitarse a si mismo el acceso de administrador');
    if (u.rol === 'admin' && u.activo && (rol !== 'admin' || !activo) && !DB.usuarios.some(x => x.rol === 'admin' && x.activo && x.id !== uid)) throw new ApiErr(400, 'Debe quedar al menos un administrador activo');
    u.nombre = nombre; u.rol = rol; u.activo = activo;
    if (b.password) { validarPass(b.password); u.password_hash = await hashPass(b.password); }
    return { ok: true };
  });

  ruta('GET', '/api/categorias', 'usuario', async () => DB.categorias.slice().sort((a, b) => norm(a.nombre).localeCompare(norm(b.nombre))).map(c => ({ id: c.id, nombre: c.nombre })));
  ruta('POST', '/api/categorias', 'admin', async c => { const n = toTexto(c.body, 'nombre', 60); return { id: obtenerOCrearCategoria(n), nombre: n }; });
  ruta('GET', '/api/proveedores', 'admin', async () => DB.proveedores.filter(p => p.activo).sort((a, b) => norm(a.nombre).localeCompare(norm(b.nombre))));
  ruta('POST', '/api/proveedores', 'admin', async c => ({ id: ins('proveedores', { nombre: toTexto(c.body, 'nombre', 100), telefono: toTexto(c.body, 'telefono', 40, false), notas: toTexto(c.body, 'notas', 300, false), activo: 1 }).id }));
  ruta('PUT', '/api/proveedores/(\\d+)', 'admin', async c => {
    const p = porId('proveedores', +c.m[0]); if (!p) throw new ApiErr(404, 'Proveedor no encontrado');
    p.nombre = toTexto(c.body, 'nombre', 100); p.telefono = toTexto(c.body, 'telefono', 40, false); p.notas = toTexto(c.body, 'notas', 300, false); p.activo = 'activo' in c.body && !toBool(c.body.activo) ? 0 : 1;
    return { ok: true };
  });

  ruta('GET', '/api/productos', 'usuario', async c => consultarProductos(c.admin, { q: c.q.q, categoria_id: /^\d+$/.test(c.q.categoria_id || '') ? +c.q.categoria_id : null, inactivos: c.admin && c.q.inactivos === '1', limite: Math.min(parseInt(c.q.limite || 600, 10) || 600, 2000) }));
  ruta('GET', '/api/productos/(\\d+)', 'usuario', async c => { const r = consultarProductos(c.admin, { producto_id: +c.m[0], inactivos: true }); if (!r.length) throw new ApiErr(404, 'Producto no encontrado'); return r[0]; });
  ruta('GET', '/api/buscar', 'usuario', async c => {
    const codigo = String(c.q.codigo || '').trim(); if (!codigo) throw new ApiErr(400, 'Falta el codigo');
    const r = consultarProductos(c.admin, { codigo }); return r.length ? r[0] : { no_encontrado: true, codigo };
  });
  ruta('POST', '/api/productos', 'admin', async c => {
    const b = c.body, campos = leerProducto(b, false);
    const p = ins('productos', Object.assign({ unidad_compra: null, activo: 1 }, campos));
    const codigos = (b.codigos || []).map(x => String(x).trim()).filter(Boolean);
    if (toBool(b.generar_codigo)) codigos.push(codigoInterno(p.id));
    codigos.forEach(cod => agregarCodigo(p.id, cod));
    return consultarProductos(true, { producto_id: p.id, inactivos: true })[0];
  });
  ruta('PUT', '/api/productos/(\\d+)', 'admin', async c => {
    const pid = +c.m[0], p = porId('productos', pid); if (!p) throw new ApiErr(404, 'Producto no encontrado');
    const campos = leerProducto(c.body, true); if ('activo' in c.body) campos.activo = toBool(c.body.activo) ? 1 : 0;
    Object.assign(p, campos);
    return consultarProductos(true, { producto_id: pid, inactivos: true })[0];
  });
  ruta('POST', '/api/productos/(\\d+)/codigos', 'admin', async c => {
    const pid = +c.m[0]; if (!porId('productos', pid)) throw new ApiErr(404, 'Producto no encontrado');
    const cod = toBool(c.body.generar) ? codigoInterno(pid) : toTexto(c.body, 'codigo', 40);
    agregarCodigo(pid, cod); return { codigo: cod };
  });
  ruta('DELETE', '/api/codigos/(.+)', 'admin', async c => { const cod = decodeURIComponent(c.m[0]); DB.codigos = DB.codigos.filter(x => x.codigo !== cod); return { ok: true }; });

  ruta('POST', '/api/compras', 'admin', async c => {
    const b = c.body, lineas = b.lineas;
    if (!Array.isArray(lineas) || !lineas.length) throw new ApiErr(400, 'La compra no tiene productos');
    if (lineas.length > 300) throw new ApiErr(400, 'Demasiadas lineas en una compra');
    const prov = /^\d+$/.test(String(b.proveedor_id || '')) ? +b.proveedor_id : null, notas = toTexto(b, 'notas', 300, false), fh = hoy();
    if (prov && !porId('proveedores', prov)) throw new ApiErr(400, 'El proveedor no existe');
    const compra = ins('compras', { proveedor_id: prov, usuario_id: c.user.id, fecha: ahora(), total: 0, notas });
    let total = 0;
    lineas.forEach((ln, i0) => {
      const i = i0 + 1; if (!ln || typeof ln !== 'object') throw new ApiErr(400, 'Linea ' + i + ' invalida');
      const prod = porId('productos', toId(ln.producto_id, 'producto'));
      if (!prod || !prod.activo) throw new ApiErr(400, 'Linea ' + i + ': el producto no existe o esta desactivado');
      const cant = toNum(ln.cantidad, 'cantidad', 0.001, 10000000), costo = toNum(ln.costo_unitario, 'costo', 0, 10000000), venc = toFecha(ln.fecha_vencimiento, 'vencimiento');
      if (venc && venc < fh) throw new ApiErr(400, 'Linea ' + i + ' (' + prod.nombre + '): la fecha de vencimiento ya paso');
      const factor = prod.factor_conversion || 1, cantV = r3(cant * factor);
      if (!prod.se_vende_por_peso && Math.abs(cantV - Math.round(cantV)) > 1e-9) throw new ApiErr(400, 'Linea ' + i + ' (' + prod.nombre + '): la cantidad resultante (' + cantV + ') debe ser un numero entero');
      const lote = ins('lotes', { producto_id: prod.id, compra_id: compra.id, cantidad_inicial: cantV, cantidad_actual: cantV, costo_unitario: Math.round(costo / factor * 1e4) / 1e4, fecha_vencimiento: venc, fecha_ingreso: ahora() });
      mov(prod.id, lote.id, 'compra', cantV, c.user.id, 'Compra #' + compra.id);
      total += dinero(cant, costo);
    });
    compra.total = r2(total);
    return { id: compra.id, total: compra.total };
  });
  ruta('GET', '/api/compras', 'admin', async c => {
    const desde = toFecha(c.q.desde, 'desde') || sumarDias(hoy(), -30), hasta = toFecha(c.q.hasta, 'hasta') || hoy();
    return DB.compras.filter(x => x.fecha.slice(0, 10) >= desde && x.fecha.slice(0, 10) <= hasta).sort((a, b) => b.id - a.id).slice(0, 500).map(x => ({
      id: x.id, fecha: x.fecha, total: x.total, notas: x.notas, proveedor: x.proveedor_id ? porId('proveedores', x.proveedor_id).nombre : null,
      usuario: nombreUsuario(x.usuario_id), lineas: DB.lotes.filter(l => l.compra_id === x.id).length }));
  });

  ruta('POST', '/api/ventas', 'usuario', async c => {
    const b = c.body, lineas = b.lineas;
    if (!Array.isArray(lineas) || !lineas.length) throw new ApiErr(400, 'La venta no tiene productos');
    if (lineas.length > 300) throw new ApiErr(400, 'Demasiadas lineas en una venta');
    const metodo = b.metodo_pago || 'efectivo';
    if (!METODOS.includes(metodo)) throw new ApiErr(400, 'Metodo de pago invalido');
    const cliente = metodo === 'fiado' ? toTexto(b, 'cliente', 80, true, 'nombre del cliente (venta al fiado)') : null;
    const notas = toTexto(b, 'notas', 200, false), forzar = toBool(b.forzar), fh = hoy(), faltantes = [];
    const venta = ins('ventas', { usuario_id: c.user.id, fecha: ahora(), total: 0, metodo_pago: metodo, recibido: null, cliente, fiado_pagado_fecha: null, notas, anulada: 0, anulada_por: null, anulada_fecha: null, anulada_motivo: null });
    let total = 0;
    lineas.forEach((ln, i0) => {
      const i = i0 + 1; if (!ln || typeof ln !== 'object') throw new ApiErr(400, 'Linea ' + i + ' invalida');
      const prod = porId('productos', toId(ln.producto_id, 'producto'));
      if (!prod || !prod.activo) throw new ApiErr(400, 'Linea ' + i + ': el producto no existe o esta desactivado');
      const cant = r3(toNum(ln.cantidad, 'cantidad', 0.001, 100000));
      if (!prod.se_vende_por_peso && Math.abs(cant - Math.round(cant)) > 1e-9) throw new ApiErr(400, prod.nombre + ' se vende por unidad: la cantidad debe ser un numero entero');
      let precio = prod.precio_venta;
      if (c.admin && ln.precio !== null && ln.precio !== undefined && ln.precio !== '') precio = r2(toNum(ln.precio, 'precio', 0, 10000000));
      const totalLinea = dinero(cant, precio);
      const lotes = DB.lotes.filter(l => l.producto_id === prod.id && l.cantidad_actual > 0 && (!l.fecha_vencimiento || l.fecha_vencimiento >= fh))
        .sort((a, b) => ((a.fecha_vencimiento === null) - (b.fecha_vencimiento === null)) || ((a.fecha_vencimiento || '') < (b.fecha_vencimiento || '') ? -1 : (a.fecha_vencimiento || '') > (b.fecha_vencimiento || '') ? 1 : 0) || a.id - b.id);
      let restante = cant; const partes = [];
      for (const lote of lotes) {
        if (restante <= 0) break;
        const toma = r3(Math.min(restante, lote.cantidad_actual)); if (toma <= 0) continue;
        partes.push([lote.id, toma, lote.costo_unitario, 0]); lote.cantidad_actual = r3(lote.cantidad_actual - toma); restante = r3(restante - toma);
      }
      if (restante > 0) {
        faltantes.push({ producto_id: prod.id, nombre: prod.nombre, unidad: prod.unidad, faltan: restante, disponible: r3(cant - restante) });
        const ls = DB.lotes.filter(l => l.producto_id === prod.id); const ult = ls.length ? ls.reduce((a, b) => (b.id > a.id ? b : a)) : null;
        partes.push([null, restante, ult ? ult.costo_unitario : 0, 1]);
      }
      let acum = 0;
      partes.forEach(([lid, cantidad, costo, sin], j) => {
        let sub; if (j === partes.length - 1) sub = r2(totalLinea - acum); else { sub = dinero(cantidad, precio); acum += sub; }
        ins('detalle', { venta_id: venta.id, producto_id: prod.id, lote_id: lid, cantidad, precio_unitario: precio, subtotal: sub, costo_unitario: costo, sin_stock: sin });
        mov(prod.id, lid, 'venta', -cantidad, c.user.id, 'Venta #' + venta.id + (sin ? ' (sin stock registrado)' : ''));
      });
      total += totalLinea;
    });
    if (faltantes.length && !forzar) throw new ApiErr(409, 'No hay suficiente inventario registrado para algunos productos', { codigo: 'stock_insuficiente', faltantes });
    let recibido = null;
    if (metodo === 'efectivo' && b.recibido !== null && b.recibido !== undefined && b.recibido !== '') {
      recibido = r2(toNum(b.recibido, 'monto recibido', 0, 100000000));
      if (recibido < r2(total)) throw new ApiErr(400, 'El monto recibido es menor que el total');
    }
    venta.total = r2(total); venta.recibido = recibido;
    return detalleVenta(venta.id, c.admin);
  });
  ruta('GET', '/api/ventas', 'usuario', async c => {
    const desde = toFecha(c.q.desde, 'desde') || hoy(), hasta = toFecha(c.q.hasta, 'hasta') || desde;
    let lista = DB.ventas.filter(v => v.fecha.slice(0, 10) >= desde && v.fecha.slice(0, 10) <= hasta);
    if (!c.admin) lista = lista.filter(v => v.usuario_id === c.user.id && v.fecha.slice(0, 10) === hoy());
    lista = lista.sort((a, b) => b.id - a.id).slice(0, 1000).map(v => ({ id: v.id, fecha: v.fecha, total: v.total, metodo_pago: v.metodo_pago, cliente: v.cliente, anulada: !!v.anulada, fiado_pagado_fecha: v.fiado_pagado_fecha, usuario: nombreUsuario(v.usuario_id), productos: new Set(DB.detalle.filter(d => d.venta_id === v.id).map(d => d.producto_id)).size }));
    const pm = {}; let total = 0, n = 0;
    lista.forEach(v => { if (!v.anulada) { pm[v.metodo_pago] = (pm[v.metodo_pago] || 0) + v.total; total += v.total; n++; } });
    const por = {}; Object.keys(pm).forEach(k => { por[k] = r2(pm[k]); });
    return { ventas: lista, total: r2(total), cantidad: n, por_metodo: por };
  });
  ruta('GET', '/api/ventas/(\\d+)', 'usuario', async c => {
    const v = detalleVenta(+c.m[0], c.admin);
    if (!c.admin && (v.usuario_id !== c.user.id || v.fecha.slice(0, 10) !== hoy())) throw new ApiErr(403, 'No tiene permiso para ver esta venta');
    return v;
  });
  ruta('POST', '/api/ventas/(\\d+)/anular', 'admin', async c => {
    const vid = +c.m[0], motivo = toTexto(c.body, 'motivo', 200, true, 'motivo de la anulacion'), v = porId('ventas', vid);
    if (!v) throw new ApiErr(404, 'Venta no encontrada'); if (v.anulada) throw new ApiErr(409, 'Esta venta ya estaba anulada');
    DB.detalle.filter(d => d.venta_id === vid).forEach(d => {
      if (d.lote_id) { const l = porId('lotes', d.lote_id); l.cantidad_actual = r3(l.cantidad_actual + d.cantidad); }
      mov(d.producto_id, d.lote_id, 'anulacion', d.lote_id ? d.cantidad : 0, c.user.id, 'Anulacion de venta #' + vid + ': ' + motivo);
    });
    Object.assign(v, { anulada: 1, anulada_por: c.user.id, anulada_fecha: ahora(), anulada_motivo: motivo });
    return { ok: true };
  });
  ruta('GET', '/api/fiados', 'usuario', async () => {
    const lista = DB.ventas.filter(v => v.metodo_pago === 'fiado' && !v.anulada && !v.fiado_pagado_fecha).sort((a, b) => norm(a.cliente).localeCompare(norm(b.cliente)) || a.id - b.id);
    const cl = new Map();
    lista.forEach(v => { const k = norm(v.cliente); if (!cl.has(k)) cl.set(k, { cliente: v.cliente, total: 0, ventas: [] }); const g = cl.get(k); g.total += v.total; g.ventas.push({ id: v.id, fecha: v.fecha, total: v.total, cliente: v.cliente }); });
    const out = Array.from(cl.values()); return { clientes: out, total: r2(out.reduce((s, g) => s + g.total, 0)) };
  });
  ruta('POST', '/api/fiados/cobrar', 'usuario', async c => {
    const ids = c.body.ids; if (!Array.isArray(ids) || !ids.length) throw new ApiErr(400, 'No se indicaron ventas');
    ids.forEach(i => { const v = porId('ventas', toId(i, 'venta')); if (v && v.metodo_pago === 'fiado' && !v.anulada && !v.fiado_pagado_fecha) v.fiado_pagado_fecha = ahora(); });
    return { ok: true };
  });

  ruta('GET', '/api/inventario/lotes', 'admin', async c => {
    const pid = toId(c.q.producto_id, 'producto_id'), todos = c.q.todos === '1', h = hoy();
    return DB.lotes.filter(l => l.producto_id === pid && (todos || l.cantidad_actual > 0))
      .sort((a, b) => ((a.fecha_vencimiento === null) - (b.fecha_vencimiento === null)) || ((a.fecha_vencimiento || '') < (b.fecha_vencimiento || '') ? -1 : (a.fecha_vencimiento || '') > (b.fecha_vencimiento || '') ? 1 : 0) || a.id - b.id)
      .map(l => ({ id: l.id, cantidad_inicial: l.cantidad_inicial, cantidad_actual: l.cantidad_actual, costo_unitario: l.costo_unitario, fecha_vencimiento: l.fecha_vencimiento, fecha_ingreso: l.fecha_ingreso, vencido: l.fecha_vencimiento && l.fecha_vencimiento < h ? 1 : 0 }));
  });
  ruta('POST', '/api/inventario/ajuste', 'admin', async c => {
    const b = c.body, lote = porId('lotes', toId(b.lote_id, 'lote')), tipo = b.tipo;
    if (!['merma', 'vencido', 'ajuste'].includes(tipo)) throw new ApiErr(400, 'Tipo de ajuste invalido');
    const motivo = toTexto(b, 'motivo', 200, tipo !== 'vencido', 'motivo');
    if (!lote) throw new ApiErr(404, 'Lote no encontrado');
    const cantidad = r3(toNum(b.cantidad, 'cantidad', 0, 10000000)), actual = lote.cantidad_actual; let nueva;
    if (tipo === 'ajuste') nueva = cantidad; else {
      if (cantidad <= 0) throw new ApiErr(400, 'La cantidad debe ser mayor que cero');
      if (cantidad > actual + 1e-9) throw new ApiErr(400, 'Solo quedan ' + actual + ' en ese lote');
      nueva = r3(actual - cantidad);
    }
    const diff = r3(nueva - actual); if (diff === 0) return { ok: true, cambio: 0 };
    lote.cantidad_actual = nueva; mov(lote.producto_id, lote.id, tipo, diff, c.user.id, motivo);
    return { ok: true, cambio: diff };
  });
  ruta('GET', '/api/inventario/movimientos', 'admin', async c => {
    const pid = /^\d+$/.test(c.q.producto_id || '') ? +c.q.producto_id : null, lim = Math.min(parseInt(c.q.limite || 200, 10) || 200, 1000);
    return DB.movs.filter(m => pid === null || m.producto_id === pid).sort((a, b) => b.id - a.id).slice(0, lim).map(m => { const p = porId('productos', m.producto_id); return { id: m.id, fecha: m.fecha, producto: p.nombre, unidad: p.unidad, tipo: m.tipo, cantidad: m.cantidad, motivo: m.motivo, usuario: m.usuario_id ? nombreUsuario(m.usuario_id) : null, lote_id: m.lote_id }; });
  });
  ruta('GET', '/api/alertas', 'usuario', async c => {
    const h = hoy();
    const venc = DB.lotes.filter(l => { const p = porId('productos', l.producto_id); return l.cantidad_actual > 0 && l.fecha_vencimiento && l.fecha_vencimiento <= sumarDias(h, p.dias_alerta_venc); })
      .sort((a, b) => (a.fecha_vencimiento < b.fecha_vencimiento ? -1 : a.fecha_vencimiento > b.fecha_vencimiento ? 1 : 0))
      .map(l => { const p = porId('productos', l.producto_id), dias = difDias(l.fecha_vencimiento, h); return { producto_id: p.id, nombre: p.nombre, unidad: p.unidad, lote_id: l.id, cantidad: l.cantidad_actual, fecha_vencimiento: l.fecha_vencimiento, dias, estado: dias < 0 ? 'vencido' : 'por_vencer' }; });
    const bajo = consultarProductos(c.admin, { limite: 2000 }).filter(p => p.stock_minimo > 0 && p.stock <= p.stock_minimo);
    let sin = 0;
    if (c.admin) sin = DB.detalle.filter(d => d.sin_stock && (() => { const v = porId('ventas', d.venta_id); return !v.anulada && v.fecha.slice(0, 10) >= sumarDias(h, -30); })()).length;
    return { vencimientos: venc, stock_bajo: bajo.map(p => ({ id: p.id, nombre: p.nombre, unidad: p.unidad, stock: p.stock, stock_minimo: p.stock_minimo })), ventas_sin_stock: sin,
      resumen: { vencidos: venc.filter(v => v.estado === 'vencido').length, por_vencer: venc.filter(v => v.estado === 'por_vencer').length, stock_bajo: bajo.length } };
  });

  ruta('GET', '/api/gastos', 'admin', async c => {
    const desde = toFecha(c.q.desde, 'desde') || hoy().slice(0, 8) + '01', hasta = toFecha(c.q.hasta, 'hasta') || hoy();
    const lista = DB.gastos.filter(g => g.fecha >= desde && g.fecha <= hasta).sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : b.id - a.id)).map(g => ({ id: g.id, fecha: g.fecha, concepto: g.concepto, monto: g.monto, usuario: g.usuario_id ? nombreUsuario(g.usuario_id) : null }));
    return { gastos: lista, total: r2(lista.reduce((s, g) => s + g.monto, 0)) };
  });
  ruta('POST', '/api/gastos', 'admin', async c => ({ id: ins('gastos', { fecha: toFecha(c.body.fecha, 'fecha') || hoy(), concepto: toTexto(c.body, 'concepto', 150), monto: r2(toNum(c.body.monto, 'monto', 0, 100000000)), usuario_id: c.user.id }).id }));
  ruta('DELETE', '/api/gastos/(\\d+)', 'admin', async c => { DB.gastos = DB.gastos.filter(g => g.id !== +c.m[0]); return { ok: true }; });

  ruta('GET', '/api/reportes/resumen', 'admin', async c => {
    const desde = toFecha(c.q.desde, 'desde') || hoy(), hasta = toFecha(c.q.hasta, 'hasta') || desde, h = hoy();
    const enP = f => f.slice(0, 10) >= desde && f.slice(0, 10) <= hasta;
    const vs = DB.ventas.filter(v => !v.anulada && enP(v.fecha)), ids = new Set(vs.map(v => v.id));
    const det = DB.detalle.filter(d => ids.has(d.venta_id)), fechaDe = d => porId('ventas', d.venta_id).fecha.slice(0, 10);
    const totalV = vs.reduce((s, v) => s + v.total, 0), costo = det.reduce((s, d) => s + d.cantidad * d.costo_unitario, 0);
    const gastos = DB.gastos.filter(g => g.fecha >= desde && g.fecha <= hasta).reduce((s, g) => s + g.monto, 0), ganancia = r2(totalV - costo);
    const dias = {}; det.forEach(d => { const k = fechaDe(d); dias[k] = dias[k] || { dia: k, ventas: 0, costo: 0 }; dias[k].ventas += d.subtotal; dias[k].costo += d.cantidad * d.costo_unitario; });
    const por_dia = Object.keys(dias).sort().map(k => { const x = dias[k]; x.ventas = r2(x.ventas); x.costo = r2(x.costo); x.ganancia = r2(x.ventas - x.costo); return x; });
    const tp = {}; det.forEach(d => { const p = porId('productos', d.producto_id); const t = tp[p.id] = tp[p.id] || { id: p.id, nombre: p.nombre, unidad: p.unidad, cantidad: 0, ventas: 0, ganancia: 0 }; t.cantidad += d.cantidad; t.ventas += d.subtotal; t.ganancia += d.subtotal - d.cantidad * d.costo_unitario; });
    const top = Object.values(tp).sort((a, b) => b.ventas - a.ventas).slice(0, 10).map(t => ({ id: t.id, nombre: t.nombre, unidad: t.unidad, cantidad: r3(t.cantidad), ventas: r2(t.ventas), ganancia: r2(t.ganancia) }));
    const pm = {}; vs.forEach(v => { const m = pm[v.metodo_pago] = pm[v.metodo_pago] || { metodo_pago: v.metodo_pago, n: 0, total: 0 }; m.n++; m.total += v.total; });
    const lotesV = DB.lotes.filter(l => l.cantidad_actual > 0);
    const valorInv = lotesV.reduce((s, l) => s + l.cantidad_actual * l.costo_unitario, 0), valorVenc = lotesV.filter(l => l.fecha_vencimiento && l.fecha_vencimiento < h).reduce((s, l) => s + l.cantidad_actual * l.costo_unitario, 0);
    const limite = sumarDias(h, -60), vendidos = new Set(DB.detalle.filter(d => { const v = porId('ventas', d.venta_id); return !v.anulada && v.fecha.slice(0, 10) >= limite; }).map(d => d.producto_id));
    const sr = DB.productos.filter(p => p.activo && !vendidos.has(p.id) && lotesV.some(l => l.producto_id === p.id)).map(p => { const ls = lotesV.filter(l => l.producto_id === p.id); return { id: p.id, nombre: p.nombre, unidad: p.unidad, stock: r3(ls.reduce((s, l) => s + l.cantidad_actual, 0)), valor: r2(ls.reduce((s, l) => s + l.cantidad_actual * l.costo_unitario, 0)) }; }).sort((a, b) => b.valor - a.valor).slice(0, 20);
    const fiados = DB.ventas.filter(v => v.metodo_pago === 'fiado' && !v.anulada && !v.fiado_pagado_fecha).reduce((s, v) => s + v.total, 0);
    return { desde, hasta, num_ventas: vs.length, ventas: r2(totalV), costo: r2(costo), ganancia_bruta: ganancia, gastos: r2(gastos), utilidad: r2(ganancia - gastos),
      ticket_promedio: vs.length ? r2(totalV / vs.length) : 0, por_dia, top_productos: top, por_metodo: Object.values(pm).map(m => ({ metodo_pago: m.metodo_pago, n: m.n, total: r2(m.total) })),
      valor_inventario: r2(valorInv), valor_vencido: r2(valorVenc), sin_rotacion: sr, fiados_por_cobrar: r2(fiados) };
  });

  ruta('GET', '/api/respaldo/lista', 'admin', async () => ({ carpeta: 'Este navegador (versión de prueba)', respaldos: DB.respaldos.slice().reverse() }));
  ruta('POST', '/api/respaldo/crear', 'admin', async () => { const n = 'bodega-' + hoy() + '.db'; DB.respaldos = DB.respaldos.filter(r => r.nombre !== n); DB.respaldos.push({ nombre: n, tamano: JSON.stringify(DB).length, fecha: ahora() }); return { nombre: n, carpeta: 'Este navegador (versión de prueba)' }; });

  /* ---------- manejador ---------- */
  async function despachar(metodo, rutaUrl, cuerpo) {
    const url = new URL(rutaUrl, 'http://x'), path = url.pathname, q = {}; url.searchParams.forEach((v, k) => { q[k] = v; });
    let destino = null, hay = false;
    for (const [m, rx, acceso, fn] of ROUTES) { const mt = rx.exec(path); if (mt) { hay = true; if (m === metodo) { destino = [mt, acceso, fn]; break; } } }
    if (!destino) return { status: hay ? 405 : 404, data: { error: 'Ruta no valida' } };
    const [mt, acceso, fn] = destino, user = usuarioDeSesion();
    if (acceso && !user) return { status: 401, data: { error: 'Debe iniciar sesion', codigo: 'sin_sesion' } };
    if (acceso === 'admin' && user.rol !== 'admin') return { status: 403, data: { error: 'Solo el administrador puede hacer esto' } };
    const c = { user, body: cuerpo || {}, q, m: mt.slice(1), admin: !!(user && user.rol === 'admin') };
    const copia = metodo === 'GET' ? null : JSON.stringify(DB);
    try {
      const data = await fn(c);
      if (metodo !== 'GET') guardar();
      return { status: 200, data };
    } catch (e) {
      if (copia) DB = JSON.parse(copia);
      if (e instanceof ApiErr) return { status: e.status, data: Object.assign({ error: e.message }, e.extra) };
      console.error(e); return { status: 500, data: { error: 'Error interno de la versión de prueba: ' + e.message } };
    }
  }
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (ruta, opc) {
    const r = String(ruta);
    if (!r.startsWith('/api/')) { if (realFetch) return realFetch(ruta, opc); throw new Error('sin red'); }
    const metodo = ((opc && opc.method) || 'GET').toUpperCase();
    let cuerpo = {}; try { if (opc && opc.body) cuerpo = JSON.parse(opc.body); } catch (e) { return new Response(JSON.stringify({ error: 'JSON invalido' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
    await new Promise(res => setTimeout(res, 15));
    const { status, data } = await despachar(metodo, r, cuerpo);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  window.__demo = {
    reiniciar() { DB = vacia(); sesionMem = null; guardar(); try { localStorage.removeItem(TOK); sessionStorage.removeItem('bg_carrito'); } catch (e) { /* ignorar */ } },
    async ejemplo() { const antes = JSON.stringify(DB); try { await sembrarReal(); guardar(); } catch (e) { DB = JSON.parse(antes); throw e; } },
    hayUsuarios() { return DB.usuarios.length > 0; }
  };
  async function sembrarReal() {
    // Datos de ejemplo: usa las mismas rutas que la interfaz, con el administrador como usuario.
    const adm = DB.usuarios.find(u => u.rol === 'admin'); if (!adm) throw new Error('Primero cree el administrador.');
    const previo = leerSesion(); nuevaSesion(adm.id);
    const llama = async (m, u, b) => { const r = await despachar(m, u, b); if (r.status >= 300) throw new Error(r.data.error); return r.data; };
    try {
      const P = [
        ['Frijol rojo', 'Granos básicos', 'libra', 1, 12, 20, 30, 'quintal', 100, 900, null, 2],
        ['Arroz', 'Granos básicos', 'libra', 1, 14, 20, 30, 'quintal', 100, 1100, null, 2],
        ['Azúcar', 'Granos básicos', 'libra', 1, 10, 20, 30, 'quintal', 100, 780, null, 2],
        ['Maíz', 'Granos básicos', 'libra', 1, 6, 20, 30, 'quintal', 100, 420, null, 1],
        ['Leche entera 1L', 'Lácteos', 'unidad', 0, 25, 6, 15, null, 1, 18, 10, 24],
        ['Aceite 900ml', 'Abarrotes', 'unidad', 0, 52, 6, 30, null, 1, 41, 200, 12],
        ['Fideos 200g', 'Abarrotes', 'unidad', 0, 9, 10, 30, null, 1, 6.5, 120, 30],
        ['Jabón de baño', 'Limpieza', 'unidad', 0, 12, 10, 30, null, 1, 8, null, 4],
        ['Atún en lata', 'Abarrotes', 'unidad', 0, 28, 8, 30, null, 1, 21, 300, 18],
        ['Yogurt fresa', 'Lácteos', 'unidad', 0, 18, 6, 10, null, 1, 12, 5, 8]
      ];
      const lineas = [];
      for (const [nombre, categoria, unidad, peso, precio, min, dias, uc, fac, costo, venc, cant] of P) {
        const p = await llama('POST', '/api/productos', { nombre, categoria, unidad, se_vende_por_peso: !!peso, precio_venta: precio, stock_minimo: min, dias_alerta_venc: dias, unidad_compra: uc, factor_conversion: fac, generar_codigo: !peso });
        lineas.push({ producto_id: p.id, cantidad: cant, costo_unitario: costo, fecha_vencimiento: venc === null ? null : sumarDias(hoy(), venc) });
      }
      await llama('POST', '/api/proveedores', { nombre: 'Distribuidora La Esperanza', telefono: '9999-0000' });
      await llama('POST', '/api/compras', { lineas, notas: 'Compra de ejemplo' });
      DB.lotes.filter(l => l.producto_id === DB.productos.find(p => p.nombre === 'Yogurt fresa').id).forEach(l => { l.fecha_vencimiento = sumarDias(hoy(), -2); });
      await llama('POST', '/api/gastos', { concepto: 'Luz', monto: 850 });
      const id = n => DB.productos.find(p => p.nombre === n).id;
      const V = [[0, [['Frijol rojo', 3.5], ['Leche entera 1L', 2]], 'efectivo'], [1, [['Arroz', 5], ['Aceite 900ml', 1]], 'efectivo'], [2, [['Azúcar', 10], ['Fideos 200g', 4]], 'tarjeta'], [3, [['Atún en lata', 3]], 'fiado'], [5, [['Frijol rojo', 8], ['Maíz', 6]], 'efectivo']];
      for (const [atras, items, metodo] of V) {
        const v = await llama('POST', '/api/ventas', { lineas: items.map(([n, q]) => ({ producto_id: id(n), cantidad: q })), metodo_pago: metodo, cliente: metodo === 'fiado' ? 'Doña Marta' : undefined });
        porId('ventas', v.id).fecha = sumarDias(hoy(), -atras) + ' 1' + atras + ':15:00';
      }
    } finally { ponerSesion(previo); }
  }
})();
