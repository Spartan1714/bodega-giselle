'use strict';
/* ============================================================
   Núcleo: utilidades, comunicación con el servidor, ventanas,
   código de barras EAN-13, impresión, estructura y acceso.
   ============================================================ */

const S = {
  user: null, negocio: 'Bodega Giselle', moneda: 'L', hoy: '', pie: '', tel: '',
  vista: 'vender', alertas: { resumen: { vencidos: 0, por_vencer: 0, stock_bajo: 0 } },
  carrito: [], metodo: 'efectivo', cat: 0, limpiar: null,
};
const VISTAS = {};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const money = n => S.moneda + ' ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const redondear2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const aNumero = t => { const n = parseFloat(String(t).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

function fechaCorta(d) { if (!d) return ''; const [y, m, dd] = String(d).slice(0, 10).split('-'); return dd + '/' + m + '/' + y; }
function fechaHora(ts) { if (!ts) return ''; return fechaCorta(ts) + ' ' + String(ts).slice(11, 16); }
function isoLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function sumarDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); }

function pref(k, def) { try { const v = localStorage.getItem('bg_' + k); return v === null ? def : v; } catch (e) { return def; } }
function guardarPref(k, v) { try { localStorage.setItem('bg_' + k, v); } catch (e) { /* sin almacenamiento */ } }

/* ---------- comunicación con el servidor ---------- */
class ErrorApi extends Error {
  constructor(msg, status, datos) { super(msg); this.status = status; this.datos = datos || {}; }
}
async function api(ruta, opc = {}) {
  const o = { method: opc.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opc.body !== undefined) { o.body = JSON.stringify(opc.body); o.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(ruta, o); } catch (e) {
    throw new ErrorApi('No hay conexión con el servidor. Revise que el programa esté abierto.', 0);
  }
  let datos = null;
  try { datos = await r.json(); } catch (e) { /* sin cuerpo */ }
  if (!r.ok) {
    if (r.status === 401 && datos && datos.codigo === 'sin_sesion' && S.user) { S.user = null; arrancar(); }
    throw new ErrorApi((datos && datos.error) || ('Error ' + r.status), r.status, datos);
  }
  return datos;
}
function toast(msg, tipo, ms) {
  const t = document.createElement('div');
  t.className = 'toast ' + (tipo || '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms || 3200);
}
/* Busca un producto por código de barras exacto; devuelve null si no existe */
async function buscarCodigo(codigo) {
  const r = await api('/api/buscar?codigo=' + encodeURIComponent(codigo));
  return r && r.no_encontrado ? null : r;
}
function falla(e) { console.error(e); toast(e && e.message ? e.message : String(e), 'error', 5000); }
/* Envuelve un manejador asíncrono para mostrar los errores sin romper la pantalla */
const seguro = fn => async (...a) => { try { return await fn(...a); } catch (e) { falla(e); } };

let _ctxAudio = null;
function pitido(ok) {
  if (pref('sonido', '1') === '0') return;
  try {
    _ctxAudio = _ctxAudio || new (window.AudioContext || window.webkitAudioContext)();
    const o = _ctxAudio.createOscillator(), g = _ctxAudio.createGain();
    o.frequency.value = ok === false ? 220 : 1150; g.gain.value = 0.07;
    o.connect(g); g.connect(_ctxAudio.destination);
    o.start(); o.stop(_ctxAudio.currentTime + (ok === false ? 0.25 : 0.07));
  } catch (e) { /* sin audio */ }
}

/* ---------- ventanas ---------- */
const _modales = [];
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _modales.length) { e.preventDefault(); e.stopPropagation(); _modales[_modales.length - 1].cerrar(); }
}, true);

function modal(html, opc = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = '<div class="modal" role="dialog" aria-modal="true" style="max-width:' + (opc.ancho || 520) + 'px">' + html + '</div>';
  document.body.appendChild(ov);
  const el = ov.firstElementChild;
  const m = {
    el, ov, cerrado: false,
    cerrar() {
      if (m.cerrado) return; m.cerrado = true;
      ov.remove(); const i = _modales.indexOf(m); if (i >= 0) _modales.splice(i, 1);
      if (opc.alCerrar) opc.alCerrar();
    },
  };
  _modales.push(m);
  const x = $('.cerrar', el); if (x) x.addEventListener('click', m.cerrar);
  const foco = $('[autofocus]', el) || $('input:not([type=checkbox]), select, textarea', el);
  if (foco) setTimeout(() => { foco.focus(); if (foco.select && foco.tagName === 'INPUT') foco.select(); }, 30);
  return m;
}
const hayModal = () => _modales.length > 0;

function confirmar(mensaje, opc = {}) {
  return new Promise(res => {
    let listo = false;
    const fin = v => { if (!listo) { listo = true; res(v); } };
    const m = modal('<h3>' + esc(opc.titulo || 'Confirmar') + '</h3><div>' + mensaje + '</div>' +
      '<div class="acciones"><button class="btn" id="mn">' + esc(opc.no || 'Cancelar') + '</button>' +
      '<button class="btn ' + (opc.peligro ? 'peligro' : 'primario') + '" id="ms" autofocus>' + esc(opc.si || 'Aceptar') + '</button></div>',
      { ancho: opc.ancho || 440, alCerrar: () => fin(false) });
    $('#mn', m.el).addEventListener('click', () => { fin(false); m.cerrar(); });
    $('#ms', m.el).addEventListener('click', () => { fin(true); m.cerrar(); });
  });
}

function pedir(opc) {
  return new Promise(res => {
    let listo = false;
    const fin = v => { if (!listo) { listo = true; res(v); } };
    const m = modal('<h3>' + esc(opc.titulo) + '</h3>' + (opc.ayuda ? '<p class="muted">' + opc.ayuda + '</p>' : '') +
      '<form id="fp"><label>' + esc(opc.etiqueta || '') + '</label><input id="vp" type="' + (opc.tipo || 'text') + '" value="' + esc(opc.valor || '') + '"' +
      (opc.tipo === 'number' ? ' step="any" inputmode="decimal"' : '') + ' autocomplete="off" autofocus>' +
      '<div class="acciones"><button type="button" class="btn" id="mn">Cancelar</button><button class="btn primario">' + esc(opc.si || 'Aceptar') + '</button></div></form>',
      { ancho: opc.ancho || 420, alCerrar: () => fin(null) });
    $('#mn', m.el).addEventListener('click', () => m.cerrar());
    $('#fp', m.el).addEventListener('submit', e => {
      e.preventDefault();
      const v = $('#vp', m.el).value.trim();
      if (opc.obligatorio !== false && !v) { $('#vp', m.el).focus(); return; }
      fin(v); m.cerrar();
    });
  });
}

/* ---------- código de barras EAN-13 ---------- */
const EAN = {
  L: ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'],
  G: ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'],
  R: ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'],
  P: ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'],
};
function ean13Valido(c) {
  if (!/^\d{13}$/.test(c)) return false;
  let s = 0; for (let i = 0; i < 12; i++) s += (+c[i]) * (i % 2 ? 3 : 1);
  return String((10 - s % 10) % 10) === c[12];
}
/* Devuelve el código listo para imprimir como EAN-13 (un UPC-A de 12 cifras lleva un 0 delante), o null */
function codigoImprimible(c) {
  c = String(c || '');
  if (/^\d{12}$/.test(c)) c = '0' + c;
  return ean13Valido(c) ? c : null;
}
function ean13Bits(c) {
  const p = EAN.P[+c[0]];
  let b = '101';
  for (let i = 1; i <= 6; i++) b += EAN[p[i - 1]][+c[i]];
  b += '01010';
  for (let i = 7; i <= 12; i++) b += EAN.R[+c[i]];
  return b + '101';
}
function ean13Svg(c, alto) {
  alto = alto || 60;
  const bits = ean13Bits(c), izq = 11, der = 7, ancho = izq + 95 + der;
  let barras = '', i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') { let j = i; while (j < bits.length && bits[j] === '1') j++; barras += '<rect x="' + (izq + i) + '" y="0" width="' + (j - i) + '" height="' + alto + '"/>'; i = j; } else i++;
  }
  const t = 'font-family="Arial,sans-serif" font-size="10" text-anchor="middle"';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + ancho + ' ' + (alto + 12) + '" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">' +
    '<rect width="100%" height="100%" fill="#fff"/><g fill="#000">' + barras + '</g>' +
    '<text x="4" y="' + (alto + 10) + '" ' + t + '>' + c[0] + '</text>' +
    '<text x="' + (izq + 24) + '" y="' + (alto + 10) + '" ' + t + ' letter-spacing="2.4">' + c.slice(1, 7) + '</text>' +
    '<text x="' + (izq + 71) + '" y="' + (alto + 10) + '" ' + t + ' letter-spacing="2.4">' + c.slice(7) + '</text></svg>';
}

/* ---------- impresión (ticket y etiquetas) ---------- */
function abrirImpresion(titulo, cuerpo, css, ancho, alto) {
  const w = window.open('', '_blank', 'width=' + (ancho || 420) + ',height=' + (alto || 640));
  if (!w) { toast('El navegador bloqueó la ventana de impresión. Permita las ventanas emergentes para este sitio.', 'error', 6000); return; }
  w.document.open();
  w.document.write('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>' + esc(titulo) + '</title><style>' + css + '</style></head><body>' + cuerpo + '</body></html>');
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { /* el usuario puede imprimir con Ctrl+P */ } }, 400);
}

function imprimirTicket(v) {
  const lineas = v.lineas.map(l =>
    '<div class="l"><div>' + esc(l.nombre) + '</div><div class="r"><span>' + qty(l.cantidad) + ' ' + esc(l.unidad) + ' x ' + money(l.precio_unitario) + '</span><b>' + money(l.subtotal) + '</b></div></div>').join('');
  const pagos = v.metodo_pago === 'efectivo' && v.recibido != null
    ? '<div class="r"><span>Recibido</span><span>' + money(v.recibido) + '</span></div><div class="r"><span>Cambio</span><span>' + money(v.recibido - v.total) + '</span></div>' : '';
  const cuerpo = '<div class="t"><h1>' + esc(S.negocio) + '</h1>' + (S.tel ? '<div class="c">Tel. ' + esc(S.tel) + '</div>' : '') +
    '<div class="c">Ticket #' + v.id + ' · ' + fechaHora(v.fecha) + '</div><div class="c">Atendió: ' + esc(v.usuario) + '</div><hr>' + lineas + '<hr>' +
    '<div class="r tot"><span>TOTAL</span><span>' + money(v.total) + '</span></div>' +
    '<div class="r"><span>Pago</span><span>' + esc(v.metodo_pago) + (v.cliente ? ' (' + esc(v.cliente) + ')' : '') + '</span></div>' + pagos +
    '<hr><div class="c">' + esc(S.pie || 'Gracias por su compra') + '</div></div>';
  const css = '@page{margin:3mm}body{margin:0;font:12px/1.3 "Courier New",monospace;color:#000}.t{width:72mm}h1{font-size:16px;text-align:center;margin:0 0 4px}' +
    '.c{text-align:center}hr{border:0;border-top:1px dashed #000;margin:6px 0}.l{margin-bottom:4px}.r{display:flex;justify-content:space-between;gap:8px}.tot{font-size:15px;font-weight:bold}';
  abrirImpresion('Ticket ' + v.id, cuerpo, css, 380, 620);
}

function imprimirEtiquetas(items, copias) {
  const marcas = [];
  items.forEach(it => { for (let i = 0; i < copias; i++) marcas.push('<div class="et"><div class="n">' + esc(it.nombre) + '</div><div class="p">' + money(it.precio) + '</div>' + ean13Svg(it.codigo, 48) + '</div>'); });
  const css = '@page{margin:5mm}body{margin:0;font-family:Arial,sans-serif}.et{width:50mm;height:30mm;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;' +
    'padding:1mm;margin:0 1mm 1mm 0;border:1px dashed #bbb;page-break-inside:avoid;overflow:hidden;vertical-align:top}.n{font-size:8.5pt;font-weight:bold;text-align:center;line-height:1.1;max-height:2.2em;overflow:hidden}' +
    '.p{font-size:12pt;font-weight:bold;margin:1px 0}svg{width:42mm;height:15mm}';
  abrirImpresion('Etiquetas', marcas.join(''), css, 760, 640);
}

/* ---------- estructura general ---------- */
function pestanasUsuario() {
  const todas = [['vender', 'Vender'], ['productos', 'Productos'], ['compras', 'Compras'], ['inventario', 'Inventario'],
    ['ventas', 'Ventas'], ['gastos', 'Gastos'], ['reportes', 'Reportes'], ['ajustes', 'Ajustes']];
  return S.user.rol === 'admin' ? todas : todas.filter(t => ['vender', 'productos', 'inventario', 'ventas'].includes(t[0]));
}

function dibujarEstructura() {
  $('#app').innerHTML = '<header class="cabecera"><div class="marca"><img src="/static/icono.svg" alt="">' + esc(S.negocio) + '</div>' +
    '<nav class="nav" id="nav">' + pestanasUsuario().map(t => '<button data-v="' + t[0] + '">' + t[1] + '</button>').join('') + '</nav>' +
    '<div class="usuario"><span class="nombre-u">' + esc(S.user.nombre) + (S.user.rol === 'admin' ? ' · admin' : '') + '</span>' +
    '<button class="btn" id="btnClave">Clave</button><button class="btn" id="btnSalir">Salir</button></div></header><main id="main"></main>';
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) irA(b.dataset.v); });
  $('#btnSalir').addEventListener('click', seguro(async () => { await api('/api/logout', { method: 'POST' }); S.user = null; S.carrito = []; arrancar(); }));
  $('#btnClave').addEventListener('click', cambiarMiClave);
  pintarPuntoAlertas();
}

/* Las navegaciones se hacen una tras otra: si el usuario cambia de pantalla muy rápido,
   una pantalla que todavía se está cargando no puede pisar a la nueva. */
let _colaNav = Promise.resolve();
function irA(vista) {
  const p = _colaNav.then(() => _irA(vista));
  _colaNav = p.catch(() => {});
  return p;
}
async function _irA(vista) {
  if (S.limpiar) { try { S.limpiar(); } catch (e) { /* ignorar */ } S.limpiar = null; }
  S.vista = vista;
  $$('#nav button').forEach(b => b.classList.toggle('activa', b.dataset.v === vista));
  const main = $('#main');
  main.innerHTML = '<p class="cargando">Cargando…</p>';
  try { await VISTAS[vista](main); } catch (e) { main.innerHTML = '<div class="aviso error">' + esc(e.message) + '</div>'; console.error(e); }
  window.scrollTo(0, 0);
}

function pintarPuntoAlertas() {
  const b = $('#nav button[data-v="inventario"]'); if (!b) return;
  const r = S.alertas.resumen, n = r.vencidos + r.por_vencer + r.stock_bajo;
  const viejo = $('.punto', b); if (viejo) viejo.remove();
  if (n > 0) { const s = document.createElement('span'); s.className = 'punto'; s.textContent = n > 99 ? '99+' : n; s.title = r.vencidos + ' vencidos, ' + r.por_vencer + ' por vencer, ' + r.stock_bajo + ' con poco stock'; b.appendChild(s); }
}
async function cargarAlertas() {
  try { S.alertas = await api('/api/alertas'); pintarPuntoAlertas(); } catch (e) { /* no es crítico */ }
}

function cambiarMiClave() {
  const m = modal('<button class="cerrar" aria-label="Cerrar">×</button><h3>Cambiar mi contraseña</h3><form id="f">' +
    '<label>Contraseña actual</label><input type="password" id="a" autocomplete="current-password" autofocus>' +
    '<label>Contraseña nueva (mínimo 6 caracteres)</label><input type="password" id="n" autocomplete="new-password">' +
    '<label>Repita la contraseña nueva</label><input type="password" id="n2" autocomplete="new-password">' +
    '<div class="acciones"><button type="button" class="btn" id="c">Cancelar</button><button class="btn primario">Guardar</button></div></form>', { ancho: 400 });
  $('#c', m.el).addEventListener('click', m.cerrar);
  $('#f', m.el).addEventListener('submit', seguro(async e => {
    e.preventDefault();
    if ($('#n', m.el).value !== $('#n2', m.el).value) { toast('Las contraseñas nuevas no coinciden', 'error'); return; }
    await api('/api/cambiar-password', { method: 'POST', body: { actual: $('#a', m.el).value, nueva: $('#n', m.el).value } });
    m.cerrar(); toast('Contraseña actualizada', 'ok');
  }));
}

/* ---------- acceso (primer uso e inicio de sesión) ---------- */
function aplicarEstado(e) {
  S.version = e.version; S.negocio = e.negocio; S.moneda = e.moneda; S.hoy = e.hoy; S.pie = e.ticket_pie; S.tel = e.telefono; S.user = e.usuario;
  document.title = e.negocio;
}

function dibujarAcceso(estado) {
  const nuevo = !estado.configurado;
  $('#app').innerHTML = '<div class="acceso"><form class="caja" id="fa" autocomplete="on"><img class="logo" src="/static/icono.svg" alt="">' +
    '<h1>' + (nuevo ? 'Bienvenida' : esc(estado.negocio)) + '</h1>' +
    '<p class="sub">' + (nuevo ? 'Vamos a configurar el sistema. Esto se hace una sola vez.' : 'Inicie sesión para continuar') + '</p>' +
    (nuevo
      ? '<label>Nombre del negocio</label><input id="negocio" value="Bodega Giselle" maxlength="80" required>' +
        '<div class="grid2"><div><label>Su nombre</label><input id="nombre" maxlength="80" required autofocus></div>' +
        '<div><label>Símbolo de moneda</label><input id="moneda" value="L" maxlength="6" required></div></div>' +
        '<label>Usuario (para entrar)</label><input id="usuario" maxlength="30" autocomplete="username" required placeholder="por ejemplo: giselle">' +
        '<label>Contraseña (mínimo 6 caracteres)</label><input id="password" type="password" autocomplete="new-password" required>' +
        '<label>Repita la contraseña</label><input id="password2" type="password" autocomplete="new-password" required>'
      : '<label>Usuario</label><input id="usuario" autocomplete="username" required autofocus>' +
        '<label>Contraseña</label><input id="password" type="password" autocomplete="current-password" required>') +
    '<div id="err"></div><button class="btn primario">' + (nuevo ? 'Crear y entrar' : 'Entrar') + '</button></form></div>';
  $('#fa').addEventListener('submit', async e => {
    e.preventDefault();
    const val = id => { const x = $('#' + id); return x ? x.value : ''; };
    try {
      let r;
      if (nuevo) {
        if (val('password') !== val('password2')) throw new ErrorApi('Las contraseñas no coinciden', 400);
        r = await api('/api/setup', { method: 'POST', body: { negocio: val('negocio'), nombre: val('nombre'), usuario: val('usuario'), password: val('password'), moneda: val('moneda') } });
      } else {
        r = await api('/api/login', { method: 'POST', body: { usuario: val('usuario'), password: val('password') } });
      }
      aplicarEstado(r); iniciarUI();
    } catch (err) { $('#err').innerHTML = '<div class="error-form">' + esc(err.message) + '</div>'; }
  });
}

let _temporizadorAlertas = null;
function iniciarUI() {
  dibujarEstructura();
  cargarAlertas();
  clearInterval(_temporizadorAlertas);
  _temporizadorAlertas = setInterval(() => { if (S.user) cargarAlertas(); }, 300000);
  irA('vender');
}

async function arrancar() {
  try {
    const e = await api('/api/estado');
    aplicarEstado(e);
    if (!e.configurado || !e.usuario) dibujarAcceso(e); else iniciarUI();
  } catch (err) {
    $('#app').innerHTML = '<div class="acceso"><div class="caja"><h1>Sin conexión</h1><p class="sub">' + esc(err.message) + '</p><button class="btn primario" id="rr">Reintentar</button></div></div>';
    $('#rr').addEventListener('click', arrancar);
  }
}
