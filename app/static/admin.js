'use strict';
/* ============================================================
   Administración: gastos, reportes, ajustes, usuarios y respaldos
   ============================================================ */

const compacto = n => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(Math.round(n)));

/* ============================================================ GASTOS */
VISTAS.gastos = async function (main) {
  let desde = S.hoy.slice(0, 8) + '01', hasta = S.hoy;
  main.innerHTML = '<div class="card"><h2>Registrar un gasto</h2><p class="muted">Luz, agua, alquiler, sueldos, transporte… todo lo que sale del negocio y no es mercadería. Sirve para calcular la utilidad real.</p>' +
    '<form id="fg" class="grid3"><div><label style="margin-top:0">Fecha</label><input type="date" id="gf" value="' + S.hoy + '" max="' + S.hoy + '" required></div>' +
    '<div><label style="margin-top:0">Concepto</label><input id="gc" list="lgc" maxlength="150" required placeholder="ej.: Luz"><datalist id="lgc">' + ['Luz', 'Agua', 'Alquiler', 'Sueldos', 'Transporte / flete', 'Teléfono / internet', 'Impuestos', 'Mantenimiento', 'Bolsas y empaques', 'Otros'].map(x => '<option value="' + x + '">').join('') + '</datalist></div>' +
    '<div><label style="margin-top:0">Monto</label><input id="gm" inputmode="decimal" required></div>' +
    '<div style="grid-column:1/-1" class="acciones"><button class="btn primario">Guardar gasto</button></div></form></div>' +
    '<div class="card"><div class="barra"><h3 style="margin:0">Gastos del período</h3><span class="crece"></span><label style="margin:0">Desde</label><input type="date" id="d1" value="' + desde + '"><label style="margin:0">Hasta</label><input type="date" id="d2" value="' + hasta + '"><a class="btn" id="exp" href="#" download>Exportar</a></div>' +
    '<div class="tabla-wrap" id="tg"></div><p style="font-size:1.2rem;font-weight:800;text-align:right;margin:12px 0 0">Total: <span id="gt"></span></p></div>';
  const cargar = seguro(async () => {
    desde = $('#d1').value || desde; hasta = $('#d2').value || hasta;
    $('#exp').href = '/api/exportar/gastos.csv?desde=' + desde + '&hasta=' + hasta;
    const r = await api('/api/gastos?desde=' + desde + '&hasta=' + hasta);
    $('#gt').textContent = money(r.total);
    $('#tg').innerHTML = r.gastos.length ? '<table><thead><tr><th>Fecha</th><th>Concepto</th><th>Registró</th><th class="num">Monto</th><th></th></tr></thead><tbody>' +
      r.gastos.map(g => '<tr><td>' + fechaCorta(g.fecha) + '</td><td>' + esc(g.concepto) + '</td><td>' + esc(g.usuario || '') + '</td><td class="num">' + money(g.monto) + '</td><td class="acc"><button class="btn chico" data-del="' + g.id + '" data-n="' + esc(g.concepto) + '">Eliminar</button></td></tr>').join('') + '</tbody></table>' : '<div class="vacio">No hay gastos en este período.</div>';
  });
  $('#d1').addEventListener('change', cargar); $('#d2').addEventListener('change', cargar);
  $('#fg').addEventListener('submit', seguro(async e => {
    e.preventDefault();
    const monto = aNumero($('#gm').value);
    if (!(monto >= 0)) { toast('Escriba un monto válido', 'error'); return; }
    await api('/api/gastos', { method: 'POST', body: { fecha: $('#gf').value, concepto: $('#gc').value.trim(), monto } });
    $('#gc').value = ''; $('#gm').value = ''; toast('Gasto guardado', 'ok'); $('#gc').focus(); cargar();
  }));
  $('#tg').addEventListener('click', seguro(async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (await confirmar('¿Eliminar el gasto «' + esc(b.dataset.n) + '»?', { si: 'Eliminar', peligro: true })) { await api('/api/gastos/' + b.dataset.del, { method: 'DELETE' }); cargar(); }
  }));
  await cargar();
};

/* ============================================================ REPORTES */
VISTAS.reportes = async function (main) {
  const primeroMes = S.hoy.slice(0, 8) + '01';
  const periodos = {
    hoy: ['Hoy', S.hoy, S.hoy], ayer: ['Ayer', sumarDias(S.hoy, -1), sumarDias(S.hoy, -1)], sem: ['Últimos 7 días', sumarDias(S.hoy, -6), S.hoy],
    mes: ['Este mes', primeroMes, S.hoy], mesant: ['Mes pasado', (() => { const d = new Date(primeroMes + 'T12:00:00'); d.setMonth(d.getMonth() - 1); return isoLocal(d); })(), sumarDias(primeroMes, -1)],
  };
  let actual = S.periodoRep || 'hoy';
  main.innerHTML = '<div class="card"><div class="barra"><div class="pestanas" id="per" style="margin:0">' + Object.keys(periodos).map(k => '<button data-p="' + k + '">' + periodos[k][0] + '</button>').join('') + '</div>' +
    '<span class="crece"></span><label style="margin:0">Desde</label><input type="date" id="rd"><label style="margin:0">Hasta</label><input type="date" id="rh"></div></div><div id="rep"><p class="cargando">Cargando…</p></div>';
  const cargar = seguro(async () => {
    const desde = $('#rd').value, hasta = $('#rh').value || desde;
    $$('#per button').forEach(b => b.classList.toggle('activa', actual === b.dataset.p));
    const r = await api('/api/reportes/resumen?desde=' + desde + '&hasta=' + hasta);
    const max = Math.max(1, ...r.por_dia.map(d => d.ventas));
    const margen = r.ventas > 0 ? Math.round(r.ganancia_bruta / r.ventas * 1000) / 10 : 0;
    $('#rep').innerHTML = '<div class="kpis">' +
      '<div class="kpi"><div class="t">Ventas</div><div class="v">' + money(r.ventas) + '</div></div>' +
      '<div class="kpi"><div class="t">Costo de lo vendido</div><div class="v">' + money(r.costo) + '</div></div>' +
      '<div class="kpi"><div class="t">Ganancia bruta</div><div class="v ' + (r.ganancia_bruta >= 0 ? 'bueno' : 'malo') + '">' + money(r.ganancia_bruta) + '</div><div class="muted" style="font-size:.8rem">Margen ' + margen + '%</div></div>' +
      '<div class="kpi"><div class="t">Gastos</div><div class="v">' + money(r.gastos) + '</div></div>' +
      '<div class="kpi"><div class="t">Utilidad (ganancia − gastos)</div><div class="v ' + (r.utilidad >= 0 ? 'bueno' : 'malo') + '">' + money(r.utilidad) + '</div></div>' +
      '<div class="kpi"><div class="t">Número de ventas</div><div class="v">' + r.num_ventas + '</div><div class="muted" style="font-size:.8rem">Promedio ' + money(r.ticket_promedio) + '</div></div></div>' +
      '<div class="card"><h3>Ventas por día</h3>' + (r.por_dia.length ? '<div class="grafica">' + r.por_dia.map(d => '<div class="col-g" title="' + fechaCorta(d.dia) + ': ' + money(d.ventas) + ' · ganancia ' + money(d.ganancia) + '"><span class="val">' + compacto(d.ventas) + '</span><div class="barra-g" style="height:' + Math.max(1, d.ventas / max * 150) + 'px"></div></div>').join('') +
        '</div><div class="etiquetas-g">' + r.por_dia.map(d => '<span>' + d.dia.slice(8) + '/' + d.dia.slice(5, 7) + '</span>').join('') + '</div>' : '<div class="vacio">No hay ventas en este período.</div>') + '</div>' +
      '<div class="dos-col"><div class="card"><h3>Productos más vendidos</h3>' + (r.top_productos.length ? '<div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Ventas</th><th class="num">Ganancia</th></tr></thead><tbody>' +
        r.top_productos.map(t => '<tr><td>' + esc(t.nombre) + '</td><td class="num">' + qty(t.cantidad) + ' ' + esc(t.unidad) + '</td><td class="num">' + money(t.ventas) + '</td><td class="num">' + money(t.ganancia) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="vacio">Sin datos</div>') + '</div>' +
      '<div class="card"><h3>Forma de pago</h3>' + (r.por_metodo.length ? '<div class="tabla-wrap"><table><thead><tr><th>Método</th><th class="num">Ventas</th><th class="num">Total</th></tr></thead><tbody>' +
        r.por_metodo.map(m => '<tr><td>' + (NOMBRES_METODO[m.metodo_pago] || m.metodo_pago) + '</td><td class="num">' + m.n + '</td><td class="num">' + money(m.total) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="vacio">Sin datos</div>') +
      '<h3 style="margin-top:18px">Su inventario hoy</h3><div class="tabla-wrap"><table><tbody><tr><td>Dinero invertido en mercadería (a costo)</td><td class="num"><b>' + money(r.valor_inventario) + '</b></td></tr>' +
      '<tr><td>De eso, ya vencido</td><td class="num"><b style="color:' + (r.valor_vencido > 0 ? 'var(--danger)' : 'inherit') + '">' + money(r.valor_vencido) + '</b></td></tr>' +
      '<tr><td>Fiados por cobrar</td><td class="num"><b>' + money(r.fiados_por_cobrar) + '</b></td></tr></tbody></table></div></div></div>' +
      '<div class="card"><h3>Productos sin ventas en 60 días</h3><p class="muted">Mercadería parada: dinero guardado en la estantería. Piense en ofertas o en no volver a comprarla.</p>' +
      (r.sin_rotacion.length ? '<div class="tabla-wrap"><table><thead><tr><th>Producto</th><th class="num">Existencia</th><th class="num">Dinero parado</th></tr></thead><tbody>' + r.sin_rotacion.map(s => '<tr><td>' + esc(s.nombre) + '</td><td class="num">' + qty(s.stock) + ' ' + esc(s.unidad) + '</td><td class="num">' + money(s.valor) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="vacio">Todo lo que tiene en existencia se ha vendido recientemente.</div>') + '</div>';
  });
  const aplicar = k => { actual = k; S.periodoRep = k; $('#rd').value = periodos[k][1]; $('#rh').value = periodos[k][2]; cargar(); };
  $('#per').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) aplicar(b.dataset.p); });
  const manual = () => { actual = ''; cargar(); };
  $('#rd').addEventListener('change', manual); $('#rh').addEventListener('change', manual);
  aplicar(periodos[actual] ? actual : 'hoy');
};

/* ============================================================ AJUSTES */
VISTAS.ajustes = async function (main) {
  const [cfg, usuarios, resp] = await Promise.all([api('/api/config'), api('/api/usuarios'), api('/api/respaldo/lista')]);
  main.innerHTML = '<div class="dos-col"><div class="card"><h2>Datos del negocio</h2><form id="fn"><label style="margin-top:0">Nombre del negocio</label><input id="nn" maxlength="80" value="' + esc(cfg.negocio) + '" required>' +
    '<div class="grid2"><div><label>Símbolo de moneda</label><input id="nm" maxlength="6" value="' + esc(cfg.moneda) + '" required></div><div><label>Teléfono (sale en el ticket)</label><input id="nt" maxlength="40" value="' + esc(cfg.telefono || '') + '"></div></div>' +
    '<label>Mensaje al final del ticket</label><input id="np" maxlength="120" value="' + esc(cfg.ticket_pie || '') + '"><div class="acciones"><button class="btn primario">Guardar</button></div></form></div>' +
    '<div class="card"><h2>Copias de seguridad</h2><p class="muted">El sistema guarda una copia automática cada día en la carpeta del programa y conserva las últimas ' + 30 + '. Guarde también una copia fuera de esta computadora (memoria USB o la nube) de vez en cuando.</p>' +
    '<div class="fila"><button class="btn primario" id="rc">Crear copia ahora</button><a class="btn" href="/api/respaldo/descargar" download>Descargar una copia</a></div>' +
    '<p class="muted" style="margin:12px 0 4px;font-size:.85rem">Carpeta: <code>' + esc(resp.carpeta) + '</code></p>' +
    (resp.respaldos.length ? '<div class="tabla-wrap" style="max-height:190px;overflow:auto"><table><tbody>' + resp.respaldos.slice(0, 15).map(r => '<tr><td>' + esc(r.nombre) + '</td><td class="muted">' + fechaHora(r.fecha) + '</td><td class="num">' + Math.max(1, Math.round(r.tamano / 1024)) + ' KB</td></tr>').join('') + '</tbody></table></div>' : '<div class="vacio">Aún no hay copias.</div>') + '</div></div>' +
    '<div class="card"><div class="fila" style="justify-content:space-between"><h2 style="margin:0">Usuarios</h2><button class="btn primario" id="nu">Nuevo usuario</button></div>' +
    '<p class="muted">El <b>administrador</b> ve todo (costos, ganancias, reportes). El <b>cajero</b> solo vende, consulta productos y ve sus propias ventas del día.</p>' +
    '<div class="tabla-wrap"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody id="tu"></tbody></table></div></div>' +
    '<div class="card"><h3>Acerca de</h3><p class="muted" style="margin:0">Bodega Giselle · sistema de inventario y ventas · versión ' + esc(String(S.version || '1.0.0')) + '</p></div>';
  const tu = () => { $('#tu').innerHTML = usuarios.map(u => '<tr><td><b>' + esc(u.nombre) + '</b></td><td>' + esc(u.usuario) + '</td><td>' + (u.rol === 'admin' ? 'Administrador' : 'Cajero') + '</td><td>' + (u.activo ? '<span class="badge verde">Activo</span>' : '<span class="badge gris">Desactivado</span>') + '</td><td class="acc"><button class="btn chico claro" data-u="' + u.id + '">Editar</button></td></tr>').join(''); };
  tu();
  $('#fn').addEventListener('submit', seguro(async e => {
    e.preventDefault();
    const r = await api('/api/config', { method: 'PUT', body: { negocio: $('#nn').value.trim(), moneda: $('#nm').value.trim(), telefono: $('#nt').value.trim(), ticket_pie: $('#np').value.trim() } });
    S.negocio = r.negocio; S.moneda = r.moneda; S.tel = r.telefono; S.pie = r.ticket_pie; document.title = r.negocio;
    const marca = $('.marca'); if (marca) marca.lastChild.textContent = r.negocio;
    toast('Datos guardados', 'ok');
  }));
  $('#rc').addEventListener('click', seguro(async () => { const r = await api('/api/respaldo/crear', { method: 'POST' }); toast('Copia creada: ' + r.nombre, 'ok'); irA('ajustes'); }));
  $('#nu').addEventListener('click', () => formUsuario(null, () => irA('ajustes')));
  $('#tu').addEventListener('click', e => { const b = e.target.closest('[data-u]'); if (b) formUsuario(usuarios.find(u => u.id === +b.dataset.u), () => irA('ajustes')); });
};

function formUsuario(u, alGuardar) {
  const nuevo = !u;
  const m = modal('<button class="cerrar" aria-label="Cerrar">×</button><h3>' + (nuevo ? 'Nuevo usuario' : 'Editar usuario') + '</h3><form id="fu" autocomplete="off">' +
    '<label>Nombre</label><input id="un" maxlength="80" value="' + esc(u ? u.nombre : '') + '" required autofocus>' +
    (nuevo ? '<label>Usuario (para entrar)</label><input id="uu" maxlength="30" required placeholder="ej.: caja1">' : '<p class="muted">Usuario: <b>' + esc(u.usuario) + '</b></p>') +
    '<div class="grid2"><div><label>Rol</label><select id="ur"><option value="cajero"' + (u && u.rol === 'cajero' ? ' selected' : '') + '>Cajero</option><option value="admin"' + (u && u.rol === 'admin' ? ' selected' : '') + '>Administrador</option></select></div>' +
    (nuevo ? '' : '<div><label>Estado</label><select id="ua"><option value="1"' + (u.activo ? ' selected' : '') + '>Activo</option><option value="0"' + (u.activo ? '' : ' selected') + '>Desactivado</option></select></div>') + '</div>' +
    '<label>' + (nuevo ? 'Contraseña (mínimo 6 caracteres)' : 'Contraseña nueva (déjela vacía para no cambiarla)') + '</label><input id="up" type="password" autocomplete="new-password"' + (nuevo ? ' required' : '') + '>' +
    '<div class="acciones"><button type="button" class="btn" id="c">Cancelar</button><button class="btn primario">Guardar</button></div></form>', { ancho: 440 });
  $('#c', m.el).addEventListener('click', m.cerrar);
  $('#fu', m.el).addEventListener('submit', seguro(async e => {
    e.preventDefault();
    const body = { nombre: $('#un', m.el).value.trim(), rol: $('#ur', m.el).value };
    if (nuevo) { body.usuario = $('#uu', m.el).value.trim(); body.password = $('#up', m.el).value; await api('/api/usuarios', { method: 'POST', body }); }
    else { body.activo = $('#ua', m.el).value === '1'; if ($('#up', m.el).value) body.password = $('#up', m.el).value; await api('/api/usuarios/' + u.id, { method: 'PUT', body }); }
    toast('Usuario guardado', 'ok'); m.cerrar(); if (alGuardar) alGuardar();
  }));
}

arrancar();
