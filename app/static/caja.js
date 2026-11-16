'use strict';
/* ============================================================
   Pantalla de venta (caja): escáner, búsqueda, peso, cobro
   ============================================================ */

const redondear3 = n => Math.round((Number(n) + 1e-9) * 1000) / 1000;
const totalLinea = l => Math.round((l.cantidad * l.precio + 1e-9) * 100) / 100;
const totalCarrito = () => redondear2(S.carrito.reduce((s, l) => s + totalLinea(l), 0));

function guardarCarrito() { try { sessionStorage.setItem('bg_carrito', JSON.stringify(S.carrito)); } catch (e) { /* ignorar */ } }
function recuperarCarrito() {
  if (S.carrito.length) return;
  try { const c = JSON.parse(sessionStorage.getItem('bg_carrito') || '[]'); if (Array.isArray(c)) S.carrito = c; } catch (e) { S.carrito = []; }
}

function pedirPeso(p) {
  return new Promise(res => {
    let listo = false;
    const fin = v => { if (!listo) { listo = true; res(v); } };
    const m = modal('<h3>' + esc(p.nombre) + '</h3><p class="muted">' + money(p.precio_venta) + ' por ' + esc(p.unidad) + ' · Hay ' + qty(p.stock) + ' ' + esc(p.unidad) + '</p>' +
      '<form id="fp"><label>Peso en ' + esc(p.unidad) + '</label><input id="peso" class="grande-input" inputmode="decimal" autocomplete="off" autofocus>' +
      '<div class="rapidos">' + [0.25, 0.5, 1, 2, 5].map(v => '<button type="button" data-v="' + v + '">' + (v === 0.25 ? '¼' : v === 0.5 ? '½' : v) + '</button>').join('') + '</div>' +
      '<div class="prev-total" id="prev"></div>' +
      '<div class="acciones"><button type="button" class="btn" id="mn">Cancelar</button><button class="btn primario grande">Agregar</button></div></form>',
      { ancho: 380, alCerrar: () => fin(null) });
    const inp = $('#peso', m.el), prev = $('#prev', m.el);
    const act = () => { const n = aNumero(inp.value); prev.textContent = n > 0 ? '= ' + money(Math.round((n * p.precio_venta + 1e-9) * 100) / 100) : ''; };
    inp.addEventListener('input', act);
    $$('.rapidos button', m.el).forEach(b => b.addEventListener('click', () => { inp.value = b.dataset.v; act(); inp.focus(); }));
    $('#mn', m.el).addEventListener('click', () => m.cerrar());
    $('#fp', m.el).addEventListener('submit', e => {
      e.preventDefault();
      const n = aNumero(inp.value);
      if (!(n > 0) || n > 100000) { toast('Escriba un peso válido', 'error'); inp.focus(); return; }
      fin(redondear3(n)); m.cerrar();
    });
  });
}

VISTAS.vender = async function (main) {
  recuperarCarrito();
  const admin = S.user.rol === 'admin';
  const cats = await api('/api/categorias');
  main.innerHTML = '<div class="pos"><section class="pos-izq">' +
    '<div class="buscador"><input id="q" type="text" placeholder="Escanee el código de barras o escriba el nombre…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Buscar producto">' +
    '<button class="btn" id="limpiarQ" title="Limpiar la búsqueda (Esc)">Limpiar</button></div>' +
    '<div id="aviso"></div><div class="chips" id="chips"></div><div class="grid-prod" id="res"></div>' +
    '<label class="check"><input type="checkbox" id="sonido"> Sonido al escanear</label></section>' +
    '<aside class="pos-der"><div class="carrito" id="carrito"></div></aside></div>';

  const q = $('#q');
  let resultados = [], turno = 0, clientesFiado = [], cobrando = false;

  $('#sonido').checked = pref('sonido', '1') !== '0';
  $('#sonido').addEventListener('change', e => guardarPref('sonido', e.target.checked ? '1' : '0'));

  /* --- categorías --- */
  const pintarChips = () => {
    $('#chips').innerHTML = '<button class="chip' + (!S.cat ? ' activa' : '') + '" data-c="0">Todas</button>' +
      cats.map(c => '<button class="chip' + (S.cat === c.id ? ' activa' : '') + '" data-c="' + c.id + '">' + esc(c.nombre) + '</button>').join('');
  };
  $('#chips').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (!b) return; S.cat = +b.dataset.c; pintarChips(); buscar(); enfocar(); });
  pintarChips();

  const enfocar = () => { if (!hayModal() && q.isConnected) q.focus(); };
  const aviso = (html, tipo) => { $('#aviso').innerHTML = html ? '<div class="aviso ' + (tipo || 'warn') + '">' + html + '</div>' : ''; };

  /* --- búsqueda --- */
  async function buscar() {
    const mi = ++turno, texto = q.value.trim();
    const pr = new URLSearchParams();
    if (texto) pr.set('q', texto);
    if (S.cat) pr.set('categoria_id', S.cat);
    pr.set('limite', texto ? '48' : '150');
    const lista = await api('/api/productos?' + pr);
    if (mi !== turno) return;
    resultados = lista; pintarResultados(texto);
  }
  function pintarResultados(texto) {
    const el = $('#res');
    if (!resultados.length) { el.innerHTML = '<div class="vacio" style="grid-column:1/-1">' + (texto ? 'Ningún producto coincide con "' + esc(texto) + '"' : 'Todavía no hay productos registrados.') + '</div>'; return; }
    el.innerHTML = resultados.map(p => {
      const agotado = p.stock <= 0, bajo = !agotado && p.stock_minimo > 0 && p.stock <= p.stock_minimo;
      return '<button class="prod' + (agotado ? ' agotado' : '') + '" data-id="' + p.id + '"><span class="n">' + esc(p.nombre) + '</span>' +
        '<span class="p">' + money(p.precio_venta) + (p.se_vende_por_peso ? '<small style="font-weight:600"> /' + esc(p.unidad) + '</small>' : '') + '</span>' +
        '<span class="s' + (bajo ? ' bajo' : '') + '">' + (agotado ? 'Sin stock' : 'Hay ' + qty(p.stock) + ' ' + esc(p.unidad)) + '</span></button>';
    }).join('');
  }
  $('#res').addEventListener('click', seguro(async e => {
    const b = e.target.closest('.prod'); if (!b) return;
    const p = resultados.find(x => x.id === +b.dataset.id);
    if (p && await agregar(p)) { aviso(''); }
    enfocar();
  }));

  q.addEventListener('input', () => { clearTimeout(q._t); q._t = setTimeout(seguro(buscar), 160); });
  $('#limpiarQ').addEventListener('click', () => { q.value = ''; aviso(''); buscar(); enfocar(); });

  /* --- Enter: código de barras exacto, "cantidad*código" o nombre --- */
  q.addEventListener('keydown', seguro(async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const crudo = q.value.trim();
    if (!crudo) return;
    let cantidad = null, texto = crudo;
    let p = await buscarCodigo(texto);
    if (!p) {
      const m = crudo.match(/^(\d+(?:[.,]\d+)?)\s*[*x×]\s*(.+)$/i);
      if (m) { cantidad = aNumero(m[1]); texto = m[2].trim(); p = await buscarCodigo(texto); }
    }
    if (p) { if (await agregar(p, cantidad)) { q.value = ''; aviso(''); buscar(); } return; }
    const lista = await api('/api/productos?q=' + encodeURIComponent(texto) + '&limite=48' + (S.cat ? '&categoria_id=' + S.cat : ''));
    const exacto = lista.find(x => norm(x.nombre) === norm(texto));
    if (lista.length === 1 || exacto) { if (await agregar(exacto || lista[0], cantidad)) { q.value = ''; aviso(''); buscar(); } return; }
    if (lista.length > 1) { resultados = lista; pintarResultados(texto); aviso('Hay ' + lista.length + ' productos parecidos. Toque el que desea.', 'warn'); pitido(false); return; }
    pitido(false);
    const soloCodigo = /^[A-Za-z0-9._\-/]+$/.test(texto) && /\d/.test(texto);
    aviso('No se encontró <b>' + esc(texto) + '</b>.' + (admin && soloCodigo ? ' <button class="btn chico primario" id="crearConCodigo">Crear producto con este código</button>' : ''), 'error');
    const bc = $('#crearConCodigo');
    if (bc) bc.addEventListener('click', () => formProducto({ codigos: [texto] }, () => { aviso(''); q.value = ''; buscar(); }));
  }));

  /* --- carrito --- */
  async function agregar(p, cantidad) {
    if (p.se_vende_por_peso) {
      if (cantidad == null) { cantidad = await pedirPeso(p); if (cantidad == null) return false; }
      if (!(cantidad > 0)) { toast('Cantidad inválida', 'error'); return false; }
      const ex = S.carrito.find(l => l.id === p.id);
      if (ex) ex.cantidad = redondear3(ex.cantidad + cantidad); else S.carrito.push(nuevaLinea(p, cantidad));
    } else {
      if (cantidad == null) cantidad = 1;
      if (!(cantidad > 0) || Math.abs(cantidad - Math.round(cantidad)) > 1e-9) { toast(p.nombre + ' se vende por unidad: use un número entero', 'error'); pitido(false); return false; }
      const ex = S.carrito.find(l => l.id === p.id);
      if (ex) { ex.cantidad += cantidad; ex.stock = p.stock; } else S.carrito.push(nuevaLinea(p, cantidad));
    }
    guardarCarrito(); pintarCarrito(); pitido(true);
    return true;
  }
  function nuevaLinea(p, cantidad) {
    return { id: p.id, nombre: p.nombre, unidad: p.unidad, peso: p.se_vende_por_peso, cantidad, precio: p.precio_venta, stock: p.stock, editado: false };
  }

  function pintarCarrito() {
    const total = totalCarrito();
    const lineas = S.carrito.map((l, i) => {
      const falta = l.cantidad > l.stock + 1e-9;
      const ctrl = l.peso
        ? '<span class="cant"><input type="text" inputmode="decimal" data-i="' + i + '" class="inp-cant" value="' + qty(l.cantidad).replace(/,/g, '') + '" aria-label="Peso"> ' + esc(l.unidad) + '</span>'
        : '<span class="cant"><button data-a="menos" data-i="' + i + '" aria-label="Quitar uno">−</button><span class="q">' + l.cantidad + '</span><button data-a="mas" data-i="' + i + '" aria-label="Agregar uno">+</button></span>';
      return '<div class="linea"><div class="nom">' + esc(l.nombre) + '</div><div class="sub" id="ls' + i + '">' + money(totalLinea(l)) + '</div>' +
        '<div class="det">' + ctrl + '<span>×</span>' + (admin ? '<a href="#" data-a="precio" data-i="' + i + '" title="Cambiar el precio de esta línea">' + money(l.precio) + '</a>' : '<span>' + money(l.precio) + '</span>') +
        (falta ? '<span class="falta">Hay ' + qty(l.stock) + '</span>' : '') + '</div>' +
        '<div style="grid-row:1/3;grid-column:3"><button class="quitar" data-a="quitar" data-i="' + i + '" aria-label="Quitar de la venta" title="Quitar">×</button></div></div>';
    }).join('');
    const efectivo = S.metodo === 'efectivo', fiado = S.metodo === 'fiado';
    $('#carrito').innerHTML = '<h3>Venta actual <button class="btn chico" id="vaciar"' + (S.carrito.length ? '' : ' disabled') + '>Vaciar</button></h3>' +
      '<div class="lineas">' + (lineas || '<div class="vacio-carrito">Escanee un producto<br>o tóquelo en la lista</div>') + '</div>' +
      '<div class="pago"><div class="total-grande"><span>Total</span><span class="monto" id="total">' + money(total) + '</span></div>' +
      '<div class="metodos">' + [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transfer.'], ['fiado', 'Fiado']].map(m => '<button data-m="' + m[0] + '" class="' + (S.metodo === m[0] ? 'activa' : '') + '">' + m[1] + '</button>').join('') + '</div>' +
      (efectivo ? '<label style="margin-top:0">Recibido</label><div class="fila"><input id="recibido" class="crece" inputmode="decimal" autocomplete="off" value="' + esc(S.recibido || '') + '" placeholder="Monto recibido"><button class="btn" id="exacto">Exacto</button></div><div id="cambio"></div>' : '') +
      (fiado ? '<label style="margin-top:0">Nombre del cliente</label><input id="cliente" list="lcf" autocomplete="off" value="' + esc(S.cliente || '') + '" placeholder="¿A quién se le fía?"><datalist id="lcf">' + clientesFiado.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>' : '') +
      '<button class="btn primario btn-cobrar" id="cobrar"' + (S.carrito.length ? '' : ' disabled') + '>Cobrar (F9)</button>' +
      '<div class="atajos">F2 buscar · F9 cobrar · Esc limpiar · «3*código» agrega 3</div></div>';
    pintarCambio();
  }
  function refrescarTotales() {
    S.carrito.forEach((l, i) => { const e = $('#ls' + i); if (e) e.textContent = money(totalLinea(l)); });
    const t = $('#total'); if (t) t.textContent = money(totalCarrito());
    pintarCambio();
  }
  function pintarCambio() {
    const el = $('#cambio'); if (!el) return;
    const total = totalCarrito(), r = aNumero(S.recibido || '');
    if (!S.carrito.length || isNaN(r)) { el.innerHTML = ''; return; }
    el.innerHTML = r + 1e-9 >= total ? '<div class="cambio ok"><span>Cambio</span><span>' + money(redondear2(r - total)) + '</span></div>' : '<div class="cambio falta"><span>Faltan</span><span>' + money(redondear2(total - r)) + '</span></div>';
  }

  const carrito = $('#carrito');
  carrito.addEventListener('click', seguro(async e => {
    const b = e.target.closest('[data-a],[data-m],#vaciar,#cobrar,#exacto'); if (!b) return;
    if (b.dataset.m) { S.metodo = b.dataset.m; if (S.metodo === 'fiado') { try { clientesFiado = (await api('/api/fiados')).clientes.map(c => c.cliente); } catch (er) { /* opcional */ } } pintarCarrito(); const f = $('#recibido') || $('#cliente'); if (f) f.focus(); return; }
    if (b.id === 'vaciar') { if (await confirmar('¿Quitar todos los productos de esta venta?', { si: 'Sí, vaciar', peligro: true })) { S.carrito = []; S.recibido = ''; guardarCarrito(); pintarCarrito(); } enfocar(); return; }
    if (b.id === 'exacto') { S.recibido = String(totalCarrito()); $('#recibido').value = S.recibido; pintarCambio(); return; }
    if (b.id === 'cobrar') { cobrar(); return; }
    const i = +b.dataset.i, l = S.carrito[i]; if (!l) return;
    e.preventDefault();
    if (b.dataset.a === 'mas') l.cantidad += 1;
    else if (b.dataset.a === 'menos') { l.cantidad -= 1; if (l.cantidad <= 0) S.carrito.splice(i, 1); }
    else if (b.dataset.a === 'quitar') S.carrito.splice(i, 1);
    else if (b.dataset.a === 'precio') {
      const v = await pedir({ titulo: 'Precio de ' + l.nombre, etiqueta: 'Precio por ' + l.unidad, valor: l.precio, tipo: 'number' });
      const n = aNumero(v); if (!(n >= 0)) return; l.precio = redondear2(n); l.editado = true;
    }
    guardarCarrito(); pintarCarrito(); enfocar();
  }));
  carrito.addEventListener('change', e => {
    const inp = e.target.closest('.inp-cant'); if (!inp) return;
    const l = S.carrito[+inp.dataset.i], n = aNumero(inp.value);
    if (!(n > 0) || n > 100000) toast('Peso inválido', 'error'); else l.cantidad = redondear3(n);
    inp.value = String(l.cantidad);
    guardarCarrito(); refrescarTotales(); // sin redibujar: así no se pierde el campo al que el usuario pasó
  });
  carrito.addEventListener('input', e => {
    if (e.target.id === 'recibido') { S.recibido = e.target.value; pintarCambio(); }
    if (e.target.id === 'cliente') S.cliente = e.target.value;
  });
  carrito.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.target.id === 'recibido' || e.target.id === 'cliente')) { e.preventDefault(); cobrar(); }
    if (e.key === 'Enter' && e.target.classList.contains('inp-cant')) { e.preventDefault(); e.target.blur(); enfocar(); }
  });

  /* --- cobrar --- */
  async function cobrar(forzar) {
    if (!S.carrito.length || cobrando) return;
    const body = { lineas: S.carrito.map(l => { const o = { producto_id: l.id, cantidad: l.cantidad }; if (l.editado && admin) o.precio = l.precio; return o; }), metodo_pago: S.metodo, forzar: !!forzar };
    if (S.metodo === 'efectivo' && S.recibido) {
      const r = aNumero(S.recibido);
      if (isNaN(r)) { toast('El monto recibido no es válido', 'error'); return; }
      if (r + 1e-9 < totalCarrito()) { toast('El monto recibido es menor que el total', 'error'); const f = $('#recibido'); if (f) f.focus(); return; }
      body.recibido = r;
    }
    if (S.metodo === 'fiado') {
      if (!(S.cliente || '').trim()) { toast('Escriba el nombre del cliente para fiar', 'error'); const f = $('#cliente'); if (f) f.focus(); return; }
      body.cliente = S.cliente.trim();
    }
    cobrando = true; $('#cobrar').disabled = true;
    try {
      const v = await api('/api/ventas', { method: 'POST', body });
      S.carrito = []; S.recibido = ''; S.cliente = ''; guardarCarrito(); pintarCarrito(); buscar(); cargarAlertas();
      exito(v);
    } catch (e) {
      if (e.status === 409 && e.datos.codigo === 'stock_insuficiente') {
        const lista = e.datos.faltantes.map(f => '<li><b>' + esc(f.nombre) + '</b>: el sistema registra ' + qty(f.disponible) + ' ' + esc(f.unidad) + ' y se están vendiendo ' + qty(f.disponible + f.faltan) + '</li>').join('');
        cobrando = false;
        if (await confirmar('<p>El inventario registrado no alcanza para:</p><ul>' + lista + '</ul><p class="muted">Si el producto sí está en la tienda, puede vender de todos modos y luego registrar la compra o corregir el inventario. Quedará anotado como venta sin stock.</p>',
          { titulo: 'No hay suficiente inventario', si: 'Vender de todos modos', no: 'Revisar', ancho: 500 })) { return cobrar(true); }
        $('#cobrar').disabled = false; enfocar(); return;
      }
      $('#cobrar').disabled = false; throw e;
    } finally { cobrando = false; }
  }

  function exito(v) {
    pitido(true);
    const m = modal('<div class="exito"><h3>Venta #' + v.id + ' registrada</h3><div class="gran">' + money(v.total) + '</div>' +
      (v.cambio != null ? '<div class="muted">Cambio a entregar</div><div class="cambio-g">' + money(v.cambio) + '</div>' : '') +
      (v.metodo_pago === 'fiado' ? '<div class="muted">Fiado a nombre de <b>' + esc(v.cliente) + '</b></div>' : '') +
      '<div class="acciones" style="justify-content:center"><button class="btn" id="tk">Imprimir ticket</button><button class="btn primario grande" id="nv" autofocus>Nueva venta</button></div></div>',
      { ancho: 420, alCerrar: () => setTimeout(enfocar, 30) });
    $('#tk', m.el).addEventListener('click', () => imprimirTicket(v));
    $('#nv', m.el).addEventListener('click', m.cerrar);
  }

  /* --- teclado global de esta pantalla (también atrapa los escáneres) --- */
  const tecla = e => {
    if (hayModal()) return;
    if (e.key === 'F9') { e.preventDefault(); cobrar(); return; }
    if (e.key === 'F2') { e.preventDefault(); q.focus(); q.select(); return; }
    if (e.key === 'Escape') { q.value = ''; aviso(''); buscar(); q.focus(); return; }
    const t = document.activeElement, escribiendo = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if (!escribiendo && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) q.focus();
  };
  document.addEventListener('keydown', tecla);
  S.limpiar = () => document.removeEventListener('keydown', tecla);

  pintarCarrito();
  await buscar();
  q.focus();
};
