'use strict';
/* ============================================================
   Gestión: productos, compras, inventario y ventas realizadas
   ============================================================ */

const deb = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const esAdmin = () => S.user && S.user.rol === 'admin';
const UNIDADES = ['unidad', 'libra', 'kg', 'onza', 'litro', 'botella', 'bolsa', 'caja', 'paquete', 'docena', 'lata', 'sobre'];
const UNIDADES_COMPRA = ['quintal', 'caja', 'fardo', 'saco', 'bulto', 'docena', 'paquete', 'galón', 'bolsa'];
const TIPOS_MOV = { compra: ['Compra', 'verde'], venta: ['Venta', 'gris'], merma: ['Merma', 'ambar'], vencido: ['Vencido', 'rojo'], ajuste: ['Conteo', 'ambar'], anulacion: ['Anulación', 'gris'] };
const NOMBRES_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', fiado: 'Fiado' };

/* ============================================================ PRODUCTOS */
VISTAS.productos = async function (main) {
  const admin = esAdmin();
  const cats = await api('/api/categorias');
  main.innerHTML = '<div class="card"><div class="barra"><input id="bq" class="crece" placeholder="Buscar por nombre o código de barras…" autocomplete="off">' +
    '<select id="bcat"><option value="">Todas las categorías</option>' + cats.map(c => '<option value="' + c.id + '">' + esc(c.nombre) + '</option>').join('') + '</select>' +
    (admin ? '<label class="check" style="margin:0"><input type="checkbox" id="binact"> Ver desactivados</label><button class="btn primario" id="nuevo">Nuevo producto</button><a class="btn" href="/api/exportar/productos.csv" download>Exportar a Excel</a>' : '') +
    '</div><div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Precio</th><th class="num">Existencia</th>' + (admin ? '<th class="num">Último costo</th>' : '') + '<th>Códigos</th><th></th></tr></thead><tbody id="tb"></tbody></table></div>' +
    '<p class="muted" id="cuenta" style="margin:10px 0 0"></p></div>';
  let lista = [];
  const cargar = seguro(async () => {
    const pr = new URLSearchParams({ limite: '2000' });
    if ($('#bq').value.trim()) pr.set('q', $('#bq').value.trim());
    if ($('#bcat').value) pr.set('categoria_id', $('#bcat').value);
    if (admin && $('#binact').checked) pr.set('inactivos', '1');
    lista = await api('/api/productos?' + pr);
    $('#tb').innerHTML = lista.length ? lista.map(p => {
      const est = [];
      if (!p.activo) est.push('<span class="badge gris">Desactivado</span>');
      if (p.stock <= 0 && p.activo) est.push('<span class="badge rojo">Sin stock</span>');
      else if (p.stock_minimo > 0 && p.stock <= p.stock_minimo) est.push('<span class="badge ambar">Poco stock</span>');
      if (p.stock_vencido > 0) est.push('<span class="badge rojo">' + qty(p.stock_vencido) + ' vencido</span>');
      return '<tr' + (admin ? ' class="clic" data-id="' + p.id + '"' : '') + '><td><b>' + esc(p.nombre) + '</b><div class="muted" style="font-size:.82rem">' + esc(p.categoria || 'Sin categoría') + (p.se_vende_por_peso ? ' · se vende por peso' : '') + '</div></td>' +
        '<td class="num">' + money(p.precio_venta) + '<div class="muted" style="font-size:.78rem">por ' + esc(p.unidad) + '</div></td>' +
        '<td class="num"><b>' + qty(p.stock) + '</b> ' + esc(p.unidad) + '<div>' + est.join(' ') + '</div></td>' +
        (admin ? '<td class="num">' + (p.ultimo_costo != null ? money(p.ultimo_costo) : '<span class="muted">—</span>') + '</td>' : '') +
        '<td>' + (p.codigos.length ? '<span class="muted" style="font-family:monospace;font-size:.85rem">' + esc(p.codigos[0]) + (p.codigos.length > 1 ? ' +' + (p.codigos.length - 1) : '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="acc">' + (admin ? '<button class="btn chico" data-et="' + p.id + '">Etiqueta</button> <button class="btn chico claro" data-ed="' + p.id + '">Editar</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="vacio">' + (admin ? 'No hay productos. Use «Nuevo producto» para empezar.' : 'No hay productos.') + '</td></tr>';
    $('#cuenta').textContent = lista.length + ' producto' + (lista.length === 1 ? '' : 's') + (lista.length >= 2000 ? ' (se muestran los primeros 2000; use la búsqueda)' : '');
  });
  $('#bq').addEventListener('input', deb(cargar, 200));
  $('#bcat').addEventListener('change', cargar);
  if (admin) {
    $('#binact').addEventListener('change', cargar);
    $('#nuevo').addEventListener('click', () => formProducto({}, cargar));
    $('#tb').addEventListener('click', seguro(async e => {
      const et = e.target.closest('[data-et]');
      if (et) { e.stopPropagation(); return etiquetaDialogo(lista.find(p => p.id === +et.dataset.et)); }
      const fila = e.target.closest('[data-id]');
      if (fila) formProducto(lista.find(p => p.id === +fila.dataset.id), cargar);
    }));
  }
  await cargar();
  $('#bq').focus();
};

async function etiquetaDialogo(p) {
  const codigo = (p.codigos || []).map(codigoImprimible).find(Boolean);
  if (!codigo) { toast('Este producto no tiene un código EAN-13 para imprimir. Ábralo con «Editar» y use «Generar código interno».', 'error', 6000); return; }
  const n = await pedir({ titulo: 'Imprimir etiquetas', ayuda: esc(p.nombre) + ' · código ' + codigo, etiqueta: '¿Cuántas etiquetas?', valor: '1', tipo: 'number', si: 'Imprimir' });
  const c = parseInt(n, 10);
  if (!(c >= 1 && c <= 500)) return;
  imprimirEtiquetas([{ nombre: p.nombre, precio: p.precio_venta, codigo }], c);
}

async function formProducto(p, alGuardar) {
  p = p || {};
  const nuevo = !p.id;
  const cats = await api('/api/categorias');
  const codigos = (p.codigos || []).slice();
  let generar = false;
  const m = modal('<button class="cerrar" aria-label="Cerrar">×</button><h3>' + (nuevo ? 'Nuevo producto' : 'Editar producto') + '</h3><form id="fp">' +
    '<label>Nombre del producto *</label><input id="nombre" maxlength="150" value="' + esc(p.nombre || '') + '" required autofocus>' +
    '<div class="grid2"><div><label>Categoría</label><input id="cat" list="lcat" value="' + esc(p.categoria || '') + '" placeholder="Escriba o elija"><datalist id="lcat">' + cats.map(c => '<option value="' + esc(c.nombre) + '">').join('') + '</datalist></div>' +
    '<div><label>Unidad de venta</label><input id="unidad" list="lun" value="' + esc(p.unidad || 'unidad') + '"><datalist id="lun">' + UNIDADES.map(u => '<option value="' + u + '">').join('') + '</datalist></div></div>' +
    '<label class="check"><input type="checkbox" id="peso"' + (p.se_vende_por_peso ? ' checked' : '') + '> Se vende por peso o medida (el cajero escribe cuánto lleva el cliente)</label>' +
    '<div class="grid3"><div><label>Precio de venta *</label><input id="precio" inputmode="decimal" value="' + (p.precio_venta != null ? p.precio_venta : '') + '" required></div>' +
    '<div><label>Avisar si hay menos de</label><input id="min" inputmode="decimal" value="' + (p.stock_minimo != null ? p.stock_minimo : 0) + '"></div>' +
    '<div><label>Avisar vencimiento (días antes)</label><input id="dias" inputmode="numeric" value="' + (p.dias_alerta_venc != null ? p.dias_alerta_venc : 30) + '"></div></div>' +
    '<div class="card" style="background:#faf8f3;box-shadow:none;border:1px solid var(--line);margin:14px 0 0;padding:12px"><b>¿Se compra en otra unidad?</b> <span class="muted">(por ejemplo, se compra por quintal y se vende por libra)</span>' +
    '<div class="grid2"><div><label>Unidad de compra</label><input id="ucompra" list="luc" value="' + esc(p.unidad_compra || '') + '" placeholder="vacío si es la misma"><datalist id="luc">' + UNIDADES_COMPRA.map(u => '<option value="' + u + '">').join('') + '</datalist></div>' +
    '<div><label>Cada unidad de compra trae…</label><input id="factor" inputmode="decimal" value="' + (p.factor_conversion != null ? p.factor_conversion : 1) + '"><div class="muted" id="ayudaFactor" style="font-size:.8rem;margin-top:3px"></div></div></div></div>' +
    '<label>Códigos de barras</label><div class="lista-codigos" id="lc"></div>' +
    '<div class="fila"><input id="ncod" class="crece" placeholder="Escanee o escriba el código y presione Enter" autocomplete="off"><button type="button" class="btn" id="addcod">Agregar</button><button type="button" class="btn claro" id="gen">Generar código interno</button></div>' +
    '<div class="muted" style="font-size:.8rem;margin-top:4px">Los productos sin código (como granos a granel) no lo necesitan: se buscan por nombre. Genere un código interno solo si quiere pegarles una etiqueta.</div>' +
    '<div class="acciones">' + (nuevo ? '' : '<button type="button" class="btn ' + (p.activo ? '' : 'primario') + '" id="act" style="margin-right:auto">' + (p.activo ? 'Desactivar' : 'Reactivar') + '</button><button type="button" class="btn" id="etq">Etiqueta</button>') +
    '<button type="button" class="btn" id="cancel">Cancelar</button><button class="btn primario">Guardar</button></div></form>', { ancho: 640 });
  const el = m.el;
  const pintarCodigos = () => {
    $('#lc', el).innerHTML = (codigos.length || generar) ? codigos.map((c, i) => '<div class="codigo-item"><span>' + esc(c) + '</span><button type="button" data-i="' + i + '" aria-label="Quitar código" title="Quitar">×</button></div>').join('') +
      (generar ? '<div class="codigo-item"><span>(código interno: se generará al guardar)</span></div>' : '') : '<div class="muted" style="font-size:.9rem">Sin códigos</div>';
  };
  const ayudaFactor = () => {
    const uc = $('#ucompra', el).value.trim(), f = aNumero($('#factor', el).value), u = $('#unidad', el).value.trim() || 'unidad';
    $('#ayudaFactor', el).textContent = uc && f > 0 ? '1 ' + uc + ' = ' + qty(f) + ' ' + u : '';
  };
  ['#ucompra', '#factor', '#unidad'].forEach(s => $(s, el).addEventListener('input', ayudaFactor));
  $('#peso', el).addEventListener('change', e => { const u = $('#unidad', el); if (e.target.checked && u.value.trim() === 'unidad') u.value = 'libra'; ayudaFactor(); });
  pintarCodigos(); ayudaFactor();

  const agregarCodigo = seguro(async () => {
    const inp = $('#ncod', el), c = inp.value.trim();
    if (!c) return;
    if (!/^[A-Za-z0-9._\-/]{1,40}$/.test(c)) { toast('Código inválido: use solo letras, números, punto, guion o barra', 'error'); return; }
    if (codigos.includes(c)) { inp.value = ''; return; }
    if (!nuevo) await api('/api/productos/' + p.id + '/codigos', { method: 'POST', body: { codigo: c } });
    codigos.push(c); inp.value = ''; pintarCodigos(); inp.focus();
  });
  $('#addcod', el).addEventListener('click', agregarCodigo);
  $('#ncod', el).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); agregarCodigo(); } });
  $('#gen', el).addEventListener('click', seguro(async () => {
    if (nuevo) { generar = true; pintarCodigos(); return; }
    const r = await api('/api/productos/' + p.id + '/codigos', { method: 'POST', body: { generar: true } });
    if (!codigos.includes(r.codigo)) codigos.push(r.codigo);
    pintarCodigos(); toast('Código interno generado: ' + r.codigo, 'ok');
  }));
  $('#lc', el).addEventListener('click', seguro(async e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const c = codigos[+b.dataset.i];
    if (!nuevo) await api('/api/codigos/' + encodeURIComponent(c), { method: 'DELETE' });
    codigos.splice(+b.dataset.i, 1); pintarCodigos();
  }));
  $('#cancel', el).addEventListener('click', m.cerrar);
  if (!nuevo) {
    $('#etq', el).addEventListener('click', () => etiquetaDialogo(Object.assign({}, p, { codigos, nombre: $('#nombre', el).value, precio_venta: aNumero($('#precio', el).value) || p.precio_venta })));
    $('#act', el).addEventListener('click', seguro(async () => {
      await api('/api/productos/' + p.id, { method: 'PUT', body: { activo: !p.activo } });
      toast(p.activo ? 'Producto desactivado' : 'Producto reactivado', 'ok'); m.cerrar(); if (alGuardar) alGuardar();
    }));
  }
  $('#fp', el).addEventListener('submit', seguro(async e => {
    e.preventDefault();
    const precio = aNumero($('#precio', el).value), factor = aNumero($('#factor', el).value || '1'), minimo = aNumero($('#min', el).value || '0'), dias = parseInt($('#dias', el).value || '30', 10);
    if (!(precio >= 0)) { toast('Escriba un precio válido', 'error'); $('#precio', el).focus(); return; }
    if (!(factor > 0)) { toast('«Cada unidad de compra trae» debe ser un número mayor que cero', 'error'); return; }
    if (!(minimo >= 0) || !(dias >= 0)) { toast('Revise el stock mínimo y los días de aviso', 'error'); return; }
    const body = {
      nombre: $('#nombre', el).value.trim(), categoria: $('#cat', el).value.trim(), unidad: $('#unidad', el).value.trim() || 'unidad',
      se_vende_por_peso: $('#peso', el).checked, precio_venta: precio, stock_minimo: minimo, dias_alerta_venc: dias,
      unidad_compra: $('#ucompra', el).value.trim(), factor_conversion: factor,
    };
    if (!body.categoria) { delete body.categoria; body.categoria_id = null; }
    let r;
    if (nuevo) { body.codigos = codigos; body.generar_codigo = generar; r = await api('/api/productos', { method: 'POST', body }); }
    else r = await api('/api/productos/' + p.id, { method: 'PUT', body });
    toast(nuevo ? 'Producto creado' : 'Cambios guardados', 'ok');
    m.cerrar(); if (alGuardar) alGuardar(r);
  }));
}

/* ============================================================ COMPRAS */
VISTAS.compras = async function (main) {
  const proveedores = await api('/api/proveedores');
  let lineas = [];
  const pre = S.compraPrecarga; S.compraPrecarga = null;
  if (pre && pre.length) for (const id of pre) { try { lineas.push(lineaCompra(await api('/api/productos/' + id))); } catch (e) { /* omitir */ } }

  main.innerHTML = '<div class="card"><h2>Registrar compra de mercadería</h2><div class="grid2"><div><label style="margin-top:0">Proveedor</label><div class="fila"><select id="prov" class="crece"><option value="">(sin proveedor)</option>' +
    proveedores.map(p => '<option value="' + p.id + '">' + esc(p.nombre) + '</option>').join('') + '</select><button class="btn" id="nprov">Nuevo</button></div></div>' +
    '<div><label style="margin-top:0">Notas (factura, observaciones)</label><input id="notas" maxlength="300"></div></div>' +
    '<label>Agregar producto (escanee el código o escriba el nombre)</label><input id="pq" autocomplete="off" placeholder="Buscar producto…"><div id="pres" class="fila" style="margin-top:8px"></div>' +
    '<div class="tabla-wrap" style="margin-top:14px"><table><thead><tr><th>Producto</th><th>Cantidad</th><th>Costo por unidad de compra</th><th>Vence</th><th class="num">Subtotal</th><th></th></tr></thead><tbody id="ln"></tbody></table></div>' +
    '<div class="fila" style="margin-top:14px;justify-content:space-between"><div class="muted">Deje «Vence» vacío si el producto no se vence.</div><div style="font-size:1.4rem;font-weight:800">Total: <span id="tot">' + money(0) + '</span></div></div>' +
    '<div class="acciones"><button class="btn primario grande" id="reg">Registrar compra</button></div></div>' +
    '<div class="card"><h3>Compras recientes (últimos 30 días)</h3><div id="hist" class="tabla-wrap"></div></div>';

  function lineaCompra(p) {
    const f = p.factor_conversion || 1;
    return { id: p.id, nombre: p.nombre, uc: p.unidad_compra || p.unidad, uv: p.unidad, f, cantidad: '', costo: p.ultimo_costo != null ? String(Math.round(p.ultimo_costo * f * 100) / 100) : '', vence: '', peso: p.se_vende_por_peso };
  }
  const textoConversion = l => { const c = aNumero(l.cantidad), k = aNumero(l.costo); return c > 0 ? '= ' + qty(c * l.f) + ' ' + l.uv + (k >= 0 ? ' · ' + money(k / l.f) + ' c/u' : '') : ''; };
  const total = () => redondear2(lineas.reduce((s, l) => s + (aNumero(l.cantidad) || 0) * (aNumero(l.costo) || 0), 0));
  function pintarLineas() {
    $('#ln').innerHTML = lineas.length ? lineas.map((l, i) => {
      const c = aNumero(l.cantidad), k = aNumero(l.costo);
      const conv = l.f !== 1 ? '<div class="muted" style="font-size:.8rem" id="conv' + i + '">' + esc(textoConversion(l)) + '</div>' : '';
      return '<tr><td><b>' + esc(l.nombre) + '</b></td><td style="min-width:150px"><div class="fila" style="flex-wrap:nowrap"><input data-i="' + i + '" data-k="cantidad" inputmode="decimal" value="' + esc(l.cantidad) + '" style="width:90px"> <span class="muted">' + esc(l.uc) + '</span></div>' + conv + '</td>' +
        '<td><input data-i="' + i + '" data-k="costo" inputmode="decimal" value="' + esc(l.costo) + '" style="width:110px"></td><td><input type="date" data-i="' + i + '" data-k="vence" value="' + esc(l.vence) + '" min="' + S.hoy + '"></td>' +
        '<td class="num" id="sub' + i + '">' + money((c || 0) * (k || 0)) + '</td><td class="acc"><button class="btn chico" data-q="' + i + '" aria-label="Quitar">×</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="vacio">Agregue los productos que recibió.</td></tr>';
    $('#tot').textContent = money(total());
  }
  $('#ln').addEventListener('input', e => {
    const i = e.target.dataset.i; if (i == null) return;
    lineas[+i][e.target.dataset.k] = e.target.value;
    const l = lineas[+i], s = $('#sub' + i); if (s) s.textContent = money((aNumero(l.cantidad) || 0) * (aNumero(l.costo) || 0));
    const cv = $('#conv' + i); if (cv) cv.textContent = textoConversion(l);
    $('#tot').textContent = money(total());
  });
  $('#ln').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) { lineas.splice(+b.dataset.q, 1); pintarLineas(); } });

  const agregar = p => {
    if (lineas.some(l => l.id === p.id)) { toast(p.nombre + ' ya está en la lista', 'error'); return; }
    lineas.push(lineaCompra(p)); pintarLineas(); $('#pq').value = ''; $('#pres').innerHTML = '';
    const inp = $('input[data-k="cantidad"][data-i="' + (lineas.length - 1) + '"]'); if (inp) inp.focus();
  };
  const buscarP = seguro(async () => {
    const t = $('#pq').value.trim();
    if (!t) { $('#pres').innerHTML = ''; return; }
    const r = await api('/api/productos?limite=8&q=' + encodeURIComponent(t));
    $('#pres').innerHTML = r.length ? r.map(p => '<button class="btn chico" data-p="' + p.id + '">' + esc(p.nombre) + '</button>').join('') : '<span class="muted">Sin resultados. Cree el producto primero en la pestaña Productos.</span>';
    $('#pres')._r = r;
  });
  $('#pq').addEventListener('input', deb(buscarP, 180));
  $('#pres').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) agregar($('#pres')._r.find(p => p.id === +b.dataset.p)); });
  $('#pq').addEventListener('keydown', seguro(async e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    const t = $('#pq').value.trim(); if (!t) return;
    const porCodigo = await buscarCodigo(t); if (porCodigo) return agregar(porCodigo);
    const r = await api('/api/productos?limite=8&q=' + encodeURIComponent(t));
    if (r.length === 1) agregar(r[0]); else if (!r.length) { pitido(false); toast('No se encontró ese producto', 'error'); }
  }));
  $('#nprov').addEventListener('click', seguro(async () => {
    const n = await pedir({ titulo: 'Nuevo proveedor', etiqueta: 'Nombre del proveedor' }); if (!n) return;
    const r = await api('/api/proveedores', { method: 'POST', body: { nombre: n } });
    const o = document.createElement('option'); o.value = r.id; o.textContent = n; $('#prov').appendChild(o); $('#prov').value = r.id;
  }));
  $('#reg').addEventListener('click', seguro(async () => {
    if (!lineas.length) { toast('Agregue al menos un producto', 'error'); return; }
    const body = { proveedor_id: $('#prov').value || null, notas: $('#notas').value.trim(), lineas: [] };
    for (const l of lineas) {
      const c = aNumero(l.cantidad), k = aNumero(l.costo);
      if (!(c > 0)) { toast('Falta la cantidad de ' + l.nombre, 'error'); return; }
      if (!(k >= 0)) { toast('Falta el costo de ' + l.nombre, 'error'); return; }
      body.lineas.push({ producto_id: l.id, cantidad: c, costo_unitario: k, fecha_vencimiento: l.vence || null });
    }
    if (!(await confirmar('Se registrarán <b>' + lineas.length + '</b> producto(s) por un total de <b>' + money(total()) + '</b>. Entrarán al inventario ahora mismo.', { titulo: 'Registrar compra', si: 'Registrar' }))) return;
    const r = await api('/api/compras', { method: 'POST', body });
    toast('Compra #' + r.id + ' registrada: ' + money(r.total), 'ok'); cargarAlertas(); irA('compras');
  }));
  const h = await api('/api/compras?desde=' + sumarDias(S.hoy, -30) + '&hasta=' + S.hoy);
  $('#hist').innerHTML = h.length ? '<table><thead><tr><th>#</th><th>Fecha</th><th>Proveedor</th><th>Notas</th><th class="num">Productos</th><th class="num">Total</th></tr></thead><tbody>' +
    h.map(c => '<tr><td>' + c.id + '</td><td>' + fechaHora(c.fecha) + '</td><td>' + esc(c.proveedor || '—') + '</td><td>' + esc(c.notas || '') + '</td><td class="num">' + c.lineas + '</td><td class="num">' + money(c.total) + '</td></tr>').join('') + '</tbody></table>' : '<div class="vacio">No hay compras en los últimos 30 días.</div>';
  pintarLineas();
  $('#pq').focus();
};

/* ============================================================ INVENTARIO */
VISTAS.inventario = async function (main) {
  const admin = esAdmin();
  const pest = [['alertas', 'Alertas'], ['existencias', 'Existencias']].concat(admin ? [['movimientos', 'Movimientos']] : []);
  main.innerHTML = '<div class="pestanas" id="pest">' + pest.map(p => '<button data-t="' + p[0] + '">' + p[1] + '</button>').join('') + '</div><div id="cont"></div>';
  const ir = seguro(async t => {
    S.pestInv = t; $$('#pest button').forEach(b => b.classList.toggle('activa', b.dataset.t === t));
    $('#cont').innerHTML = '<p class="cargando">Cargando…</p>';
    await ({ alertas: invAlertas, existencias: invExistencias, movimientos: invMovimientos })[t]($('#cont'));
  });
  $('#pest').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) ir(b.dataset.t); });
  await ir(S.pestInv && pest.some(p => p[0] === S.pestInv) ? S.pestInv : 'alertas');
};

async function invAlertas(cont) {
  const admin = esAdmin();
  const a = await api('/api/alertas'); S.alertas = a; pintarPuntoAlertas();
  const venc = a.vencimientos.filter(v => v.estado === 'vencido'), pron = a.vencimientos.filter(v => v.estado === 'por_vencer');
  const tabV = (lista, vencido) => lista.length ? '<div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Cantidad</th><th>Vence</th><th>' + (vencido ? 'Hace' : 'Faltan') + '</th><th></th></tr></thead><tbody>' +
    lista.map(v => '<tr><td><b>' + esc(v.nombre) + '</b></td><td class="num">' + qty(v.cantidad) + ' ' + esc(v.unidad) + '</td><td>' + fechaCorta(v.fecha_vencimiento) + '</td><td><span class="badge ' + (vencido ? 'rojo' : 'ambar') + '">' + Math.abs(v.dias) + ' día' + (Math.abs(v.dias) === 1 ? '' : 's') + '</span></td>' +
      '<td class="acc">' + (admin && vencido ? '<button class="btn chico peligro" data-baja="' + v.lote_id + '" data-n="' + esc(v.nombre) + '" data-c="' + v.cantidad + '">Dar de baja</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>'
    : '<div class="vacio card">' + (vencido ? 'No hay productos vencidos.' : 'No hay productos próximos a vencer.') + '</div>';
  cont.innerHTML = (a.ventas_sin_stock ? '<div class="aviso warn">Hay <b>' + a.ventas_sin_stock + '</b> venta(s) de los últimos 30 días hechas sin stock registrado. Revise el inventario (conteo físico) o registre las compras pendientes.</div>' : '') +
    '<div class="card"><h2>Vencidos <span class="badge rojo">' + venc.length + '</span></h2><p class="muted">Estos lotes ya no se pueden vender. Retírelos de la estantería y dé de baja para que el inventario sea real.</p>' + tabV(venc, true) + '</div>' +
    '<div class="card"><h2>Por vencer <span class="badge ambar">' + pron.length + '</span></h2><p class="muted">Se venden primero automáticamente. Considere ofrecerlos o ponerlos al frente.</p>' + tabV(pron, false) + '</div>' +
    '<div class="card"><h2>Poco stock <span class="badge ambar">' + a.stock_bajo.length + '</span></h2>' + (a.stock_bajo.length ? '<div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Hay</th><th class="num">Mínimo</th><th></th></tr></thead><tbody>' +
      a.stock_bajo.map(p => '<tr><td><b>' + esc(p.nombre) + '</b></td><td class="num">' + qty(p.stock) + ' ' + esc(p.unidad) + '</td><td class="num">' + qty(p.stock_minimo) + '</td><td class="acc">' + (admin ? '<button class="btn chico claro" data-comprar="' + p.id + '">Registrar compra</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>'
      : '<div class="vacio">Todo en orden: ningún producto está por debajo de su mínimo.</div>') + '</div>';
  cont.onclick = seguro(async e => {
    const b = e.target.closest('[data-baja]');
    if (b) {
      const r = await modalAjuste({ id: +b.dataset.baja, cantidad_actual: +b.dataset.c }, 'vencido', b.dataset.n);
      if (r) { toast('Lote dado de baja', 'ok'); cargarAlertas(); invAlertas(cont); } return;
    }
    const c = e.target.closest('[data-comprar]'); if (c) { S.compraPrecarga = [+c.dataset.comprar]; irA('compras'); }
  });
}

async function invExistencias(cont) {
  const admin = esAdmin();
  cont.innerHTML = '<div class="card"><div class="barra"><input id="eq" class="crece" placeholder="Buscar producto…" autocomplete="off">' + (admin ? '<a class="btn" href="/api/exportar/inventario.csv" download>Exportar lotes a Excel</a>' : '') + '</div>' +
    '<div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Existencia</th>' + (admin ? '<th class="num">Valor a costo</th>' : '') + '<th>Estado</th><th></th></tr></thead><tbody id="et"></tbody></table></div><p class="muted" id="ev" style="margin-top:10px"></p></div>';
  let lista = [];
  const cargar = seguro(async () => {
    const t = $('#eq').value.trim();
    lista = await api('/api/productos?limite=2000' + (t ? '&q=' + encodeURIComponent(t) : ''));
    let valor = 0;
    $('#et').innerHTML = lista.length ? lista.map(p => {
      const v = (p.ultimo_costo || 0) * p.stock; valor += v;
      const est = p.stock <= 0 ? '<span class="badge rojo">Sin stock</span>' : (p.stock_minimo > 0 && p.stock <= p.stock_minimo ? '<span class="badge ambar">Poco stock</span>' : '<span class="badge verde">Normal</span>');
      return '<tr><td><b>' + esc(p.nombre) + '</b></td><td class="num"><b>' + qty(p.stock) + '</b> ' + esc(p.unidad) + (p.stock_vencido > 0 ? '<div class="badge rojo">' + qty(p.stock_vencido) + ' vencido</div>' : '') + '</td>' +
        (admin ? '<td class="num">' + money(v) + '</td>' : '') + '<td>' + est + '</td><td class="acc">' + (admin ? '<button class="btn chico claro" data-lotes="' + p.id + '">Lotes</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="vacio">Sin resultados</td></tr>';
    $('#ev').innerHTML = admin ? 'Valor estimado de lo que se muestra (último costo × existencia): <b>' + money(valor) + '</b>' : '';
  });
  $('#eq').addEventListener('input', deb(cargar, 200));
  if (admin) $('#et').addEventListener('click', seguro(async e => { const b = e.target.closest('[data-lotes]'); if (b) modalLotes(lista.find(p => p.id === +b.dataset.lotes), cargar); }));
  await cargar();
}

async function modalLotes(p, alCambiar) {
  const lotes = await api('/api/inventario/lotes?producto_id=' + p.id);
  const m = modal('<button class="cerrar" aria-label="Cerrar">×</button><h3>Lotes de ' + esc(p.nombre) + '</h3><p class="muted">Cada compra crea un lote con su propio vencimiento y costo. Se vende primero el que vence antes.</p>' +
    (lotes.length ? '<div class="tabla-wrap"><table><thead><tr><th>Ingreso</th><th>Vence</th><th class="num">Entró</th><th class="num">Queda</th><th class="num">Costo</th><th></th></tr></thead><tbody>' +
      lotes.map(l => '<tr><td>' + fechaCorta(l.fecha_ingreso) + '</td><td>' + (l.fecha_vencimiento ? fechaCorta(l.fecha_vencimiento) + (l.vencido ? ' <span class="badge rojo">vencido</span>' : '') : '<span class="muted">no vence</span>') + '</td><td class="num">' + qty(l.cantidad_inicial) + '</td><td class="num"><b>' + qty(l.cantidad_actual) + '</b></td><td class="num">' + money(l.costo_unitario) + '</td>' +
        '<td class="acc"><button class="btn chico" data-a="merma" data-l="' + l.id + '">Merma</button> <button class="btn chico" data-a="ajuste" data-l="' + l.id + '">Contar</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="vacio">No hay existencias en lotes.</div>') +
    '<div class="acciones"><button class="btn" id="cl">Cerrar</button></div>', { ancho: 720 });
  $('#cl', m.el).addEventListener('click', m.cerrar);
  m.el.addEventListener('click', seguro(async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const l = lotes.find(x => x.id === +b.dataset.l);
    if (await modalAjuste(l, b.dataset.a, p.nombre)) { m.cerrar(); toast('Inventario actualizado', 'ok'); cargarAlertas(); if (alCambiar) alCambiar(); }
  }));
}

/* Ventana para dar de baja, registrar merma o contar físicamente un lote. Devuelve true si se guardó. */
function modalAjuste(lote, tipo, nombre) {
  return new Promise(res => {
    let listo = false;
    const fin = v => { if (!listo) { listo = true; res(v); } };
    const t = { vencido: ['Dar de baja producto vencido', 'Cantidad que se retira', lote.cantidad_actual], merma: ['Registrar merma o pérdida', 'Cantidad perdida', ''], ajuste: ['Conteo físico', 'Cantidad real que hay ahora en el lote', lote.cantidad_actual] }[tipo];
    const m = modal('<button class="cerrar" aria-label="Cerrar">×</button><h3>' + t[0] + '</h3><p class="muted">' + esc(nombre) + ' · en el sistema quedan ' + qty(lote.cantidad_actual) + '</p><form id="fa">' +
      '<label>' + t[1] + '</label><input id="cant" inputmode="decimal" value="' + t[2] + '" autofocus>' +
      '<label>Motivo' + (tipo === 'vencido' ? ' (opcional)' : ' *') + '</label><input id="mot" maxlength="200" placeholder="' + (tipo === 'merma' ? 'ej.: se derramó, se rompió' : tipo === 'ajuste' ? 'ej.: conteo del sábado' : 'ej.: se botó') + '">' +
      '<div class="acciones"><button type="button" class="btn" id="c">Cancelar</button><button class="btn primario">Guardar</button></div></form>', { ancho: 440, alCerrar: () => fin(false) });
    $('#c', m.el).addEventListener('click', () => m.cerrar());
    $('#fa', m.el).addEventListener('submit', async e => {
      e.preventDefault();
      const c = aNumero($('#cant', m.el).value);
      if (!(c >= 0) || (tipo !== 'ajuste' && c <= 0)) { toast('Escriba una cantidad válida', 'error'); return; }
      try { await api('/api/inventario/ajuste', { method: 'POST', body: { lote_id: lote.id, tipo, cantidad: c, motivo: $('#mot', m.el).value.trim() } }); fin(true); m.cerrar(); } catch (er) { falla(er); }
    });
  });
}

async function invMovimientos(cont) {
  cont.innerHTML = '<div class="card"><div class="barra"><input id="mq" class="crece" placeholder="Filtrar por producto (escriba el nombre y elija)…" autocomplete="off"><button class="btn" id="mt">Ver todos</button></div><div id="mres" class="fila" style="margin-bottom:8px"></div><div class="tabla-wrap" id="mt2"></div></div>';
  let pid = null;
  const cargar = seguro(async () => {
    const m = await api('/api/inventario/movimientos?limite=300' + (pid ? '&producto_id=' + pid : ''));
    $('#mt2').innerHTML = m.length ? '<table><thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th class="num">Cantidad</th><th>Detalle</th><th>Usuario</th></tr></thead><tbody>' +
      m.map(x => { const t = TIPOS_MOV[x.tipo] || [x.tipo, 'gris']; return '<tr><td>' + fechaHora(x.fecha) + '</td><td>' + esc(x.producto) + '</td><td><span class="badge ' + t[1] + '">' + t[0] + '</span></td><td class="num" style="color:' + (x.cantidad < 0 ? 'var(--danger)' : 'var(--ok)') + '">' + (x.cantidad > 0 ? '+' : '') + qty(x.cantidad) + ' ' + esc(x.unidad) + '</td><td>' + esc(x.motivo || '') + '</td><td>' + esc(x.usuario || '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="vacio">Sin movimientos</div>';
  });
  $('#mq').addEventListener('input', deb(seguro(async () => {
    const t = $('#mq').value.trim(); if (!t) { $('#mres').innerHTML = ''; return; }
    const r = await api('/api/productos?limite=8&q=' + encodeURIComponent(t));
    $('#mres').innerHTML = r.map(p => '<button class="btn chico" data-p="' + p.id + '">' + esc(p.nombre) + '</button>').join('') || '<span class="muted">Sin resultados</span>';
  }), 200));
  $('#mres').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { pid = +b.dataset.p; $('#mq').value = b.textContent; $('#mres').innerHTML = ''; cargar(); } });
  $('#mt').addEventListener('click', () => { pid = null; $('#mq').value = ''; $('#mres').innerHTML = ''; cargar(); });
  await cargar();
}

/* ============================================================ VENTAS REALIZADAS */
VISTAS.ventas = async function (main) {
  const admin = esAdmin();
  let desde = S.hoy, hasta = S.hoy, pest = 'ventas';
  main.innerHTML = '<div class="pestanas" id="pest"><button data-t="ventas" class="activa">Ventas</button><button data-t="fiados">Fiados por cobrar</button></div><div id="cont"></div>';
  $('#pest').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; pest = b.dataset.t; $$('#pest button').forEach(x => x.classList.toggle('activa', x === b)); dibujar(); });
  const dibujar = seguro(async () => (pest === 'ventas' ? ventasLista : fiadosLista)($('#cont')));

  async function ventasLista(cont) {
    cont.innerHTML = '<div class="card"><div class="barra">' + (admin
      ? '<label style="margin:0">Desde</label><input type="date" id="vd" value="' + desde + '"><label style="margin:0">Hasta</label><input type="date" id="vh" value="' + hasta + '"><button class="btn" id="bh">Hoy</button><button class="btn" id="bay">Ayer</button><a class="btn" id="exp" href="#" download>Exportar a Excel</a>'
      : '<b>Sus ventas de hoy</b>') + '</div><div id="resumen"></div><div class="tabla-wrap" id="tv"></div></div>';
    const cargar = seguro(async () => {
      if (admin) { desde = $('#vd').value || S.hoy; hasta = $('#vh').value || desde; $('#exp').href = '/api/exportar/ventas.csv?desde=' + desde + '&hasta=' + hasta; }
      const r = await api('/api/ventas?desde=' + desde + '&hasta=' + hasta);
      $('#resumen').innerHTML = '<div class="kpis"><div class="kpi"><div class="t">Total vendido</div><div class="v">' + money(r.total) + '</div></div><div class="kpi"><div class="t">Ventas</div><div class="v">' + r.cantidad + '</div></div>' +
        Object.keys(r.por_metodo).map(k => '<div class="kpi"><div class="t">' + (NOMBRES_METODO[k] || k) + '</div><div class="v" style="font-size:1.25rem">' + money(r.por_metodo[k]) + '</div></div>').join('') + '</div>';
      $('#tv').innerHTML = r.ventas.length ? '<table><thead><tr><th>#</th><th>Fecha</th><th>Cajero</th><th>Pago</th><th>Cliente</th><th class="num">Total</th><th></th></tr></thead><tbody>' +
        r.ventas.map(v => '<tr class="clic' + (v.anulada ? ' anulada' : '') + '" data-id="' + v.id + '"><td>' + v.id + '</td><td>' + fechaHora(v.fecha) + '</td><td>' + esc(v.usuario) + '</td><td>' + (NOMBRES_METODO[v.metodo_pago] || v.metodo_pago) + '</td><td>' + esc(v.cliente || '') + '</td><td class="num">' + money(v.total) + '</td><td>' +
          (v.anulada ? '<span class="badge gris">Anulada</span>' : (v.metodo_pago === 'fiado' ? (v.fiado_pagado_fecha ? '<span class="badge verde">Cobrado</span>' : '<span class="badge ambar">Por cobrar</span>') : '')) + '</td></tr>').join('') + '</tbody></table>' : '<div class="vacio">No hay ventas en este período.</div>';
    });
    if (admin) {
      $('#vd').addEventListener('change', cargar); $('#vh').addEventListener('change', cargar);
      $('#bh').addEventListener('click', () => { $('#vd').value = $('#vh').value = S.hoy; cargar(); });
      $('#bay').addEventListener('click', () => { $('#vd').value = $('#vh').value = sumarDias(S.hoy, -1); cargar(); });
    }
    $('#tv').addEventListener('click', e => { const f = e.target.closest('[data-id]'); if (f) detalleVenta(+f.dataset.id, cargar); });
    await cargar();
  }

  async function fiadosLista(cont) {
    const f = await api('/api/fiados');
    cont.innerHTML = '<div class="kpis"><div class="kpi"><div class="t">Total por cobrar</div><div class="v">' + money(f.total) + '</div></div><div class="kpi"><div class="t">Clientes con deuda</div><div class="v">' + f.clientes.length + '</div></div></div>' +
      (f.clientes.length ? f.clientes.map((c, i) => '<div class="card"><div class="fila" style="justify-content:space-between"><h3 style="margin:0">' + esc(c.cliente) + '</h3><div style="font-size:1.3rem;font-weight:800">' + money(c.total) + '</div></div>' +
        '<div class="tabla-wrap" style="margin:10px 0"><table><tbody>' + c.ventas.map(v => '<tr><td style="width:36px"><input type="checkbox" checked data-c="' + i + '" value="' + v.id + '"></td><td>Venta #' + v.id + '</td><td>' + fechaHora(v.fecha) + '</td><td class="num">' + money(v.total) + '</td></tr>').join('') + '</tbody></table></div>' +
        '<div class="acciones" style="margin:0"><button class="btn primario" data-cobrar="' + i + '">Marcar seleccionadas como cobradas</button></div></div>').join('') : '<div class="card vacio">Nadie debe nada en este momento.</div>');
    cont.onclick = seguro(async e => {
      const b = e.target.closest('[data-cobrar]'); if (!b) return;
      const ids = $$('input[data-c="' + b.dataset.cobrar + '"]:checked', cont).map(x => +x.value);
      if (!ids.length) { toast('Seleccione al menos una venta', 'error'); return; }
      const c = f.clientes[+b.dataset.cobrar];
      if (!(await confirmar('¿Confirma que <b>' + esc(c.cliente) + '</b> pagó ' + ids.length + ' venta(s)?', { si: 'Sí, ya pagó' }))) return;
      await api('/api/fiados/cobrar', { method: 'POST', body: { ids } }); toast('Cobro registrado', 'ok'); fiadosLista(cont);
    });
  }
  await dibujar();
};

async function detalleVenta(id, alCambiar) {
  const v = await api('/api/ventas/' + id), admin = esAdmin();
  const costo = admin ? v.lineas.reduce((s, l) => s + (l.costo || 0), 0) : 0;
  const m = modal('<button class="cerrar" aria-label="Cerrar">×</button><h3>Venta #' + v.id + (v.anulada ? ' <span class="badge gris">Anulada</span>' : '') + '</h3>' +
    '<p class="muted">' + fechaHora(v.fecha) + ' · atendió ' + esc(v.usuario) + ' · ' + (NOMBRES_METODO[v.metodo_pago] || v.metodo_pago) + (v.cliente ? ' · ' + esc(v.cliente) : '') + '</p>' +
    '<div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Subtotal</th></tr></thead><tbody>' +
    v.lineas.map(l => '<tr><td>' + esc(l.nombre) + (l.sin_stock ? ' <span class="badge ambar" title="Se vendió sin stock registrado">sin stock</span>' : '') + '</td><td class="num">' + qty(l.cantidad) + ' ' + esc(l.unidad) + '</td><td class="num">' + money(l.precio_unitario) + '</td><td class="num">' + money(l.subtotal) + '</td></tr>').join('') +
    '</tbody></table></div><div class="fila" style="justify-content:space-between;margin-top:12px"><div class="muted">' + (v.cambio != null ? 'Recibido ' + money(v.recibido) + ' · cambio ' + money(v.cambio) : '') + (admin && !v.anulada ? '<br>Ganancia de esta venta: <b>' + money(v.total - costo) + '</b>' : '') + '</div><div style="font-size:1.5rem;font-weight:800">' + money(v.total) + '</div></div>' +
    (v.anulada ? '<div class="aviso error" style="margin-top:12px">Anulada el ' + fechaHora(v.anulada_fecha) + ': ' + esc(v.anulada_motivo || '') + '</div>' : '') +
    '<div class="acciones"><button class="btn" id="tk">Imprimir ticket</button>' + (admin && !v.anulada ? '<button class="btn peligro" id="an">Anular venta</button>' : '') + '<button class="btn primario" id="ok">Cerrar</button></div>', { ancho: 600 });
  $('#ok', m.el).addEventListener('click', m.cerrar);
  $('#tk', m.el).addEventListener('click', () => imprimirTicket(v));
  const an = $('#an', m.el);
  if (an) an.addEventListener('click', seguro(async () => {
    const motivo = await pedir({ titulo: 'Anular venta #' + v.id, ayuda: 'Los productos vuelven al inventario. Esta acción queda registrada.', etiqueta: 'Motivo de la anulación', si: 'Anular venta' });
    if (!motivo) return;
    await api('/api/ventas/' + v.id + '/anular', { method: 'POST', body: { motivo } });
    toast('Venta anulada', 'ok'); m.cerrar(); cargarAlertas(); if (alCambiar) alCambiar();
  }));
}

