/* ===== Panel de la versión de prueba y límites del navegador ===== */
(function () {
  'use strict';
  const cont = document.getElementById('demo');
  let abierto = false, confirmando = false;
  function pintar() {
    const hay = window.__demo.hayUsuarios();
    cont.innerHTML = (abierto ? '<div class="panel" role="dialog" aria-label="Versión de prueba">' +
      '<p>Versión de prueba. Los datos se guardan solo en este navegador y no se comparten.</p>' +
      '<button id="d-ej"' + (hay ? '' : ' disabled') + '>Cargar datos de ejemplo</button>' +
      (hay ? '' : '<p>Cree primero el administrador.</p>') +
      '<button id="d-rs" class="peligro' + (confirmando ? ' listo' : '') + '">' + (confirmando ? 'Clic otra vez para borrar todo' : 'Borrar todo y empezar de nuevo') + '</button></div>' : '') +
      '<button class="pill" id="d-p" aria-expanded="' + abierto + '">Versión de prueba</button>';
    document.getElementById('d-p').onclick = () => { abierto = !abierto; confirmando = false; pintar(); };
    const ej = document.getElementById('d-ej'), rs = document.getElementById('d-rs');
    if (ej) ej.onclick = async () => {
      if (!hay) return;
      ej.disabled = true; ej.textContent = 'Cargando…';
      try { await window.__demo.ejemplo(); location.reload(); } catch (e) { toast(e.message || String(e), 'error', 5000); abierto = false; pintar(); }
    };
    if (rs) rs.onclick = () => { if (!confirmando) { confirmando = true; pintar(); return; } window.__demo.reiniciar(); location.reload(); };
  }
  pintar();
  /* En una página incrustada no se pueden descargar archivos: se avisa en lugar de fallar en silencio. */
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (a) { e.preventDefault(); toast('Las descargas no están disponibles en la versión web de prueba.', 'error', 5000); }
  }, true);
})();
