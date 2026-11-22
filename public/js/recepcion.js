/** Recepción: renglones de lotes y lectura del código GS1 de la caja (llena producto, lote y caducidad). */
(function () {
  const contenedor = document.getElementById('renglones');
  const mensaje = document.getElementById('caja-mensaje');
  const caja = document.getElementById('esc-caja');

  function renumerar() {
    const renglones = contenedor.querySelectorAll('[data-renglon]');
    renglones.forEach((r, i) => {
      r.querySelector('[data-numero]').textContent = i + 1;
      r.querySelector('[data-quitar]').hidden = renglones.length === 1;
    });
  }

  function nuevo() {
    const base = contenedor.querySelector('[data-renglon]');
    const copia = base.cloneNode(true);
    copia.querySelectorAll('input').forEach((i) => { i.value = ''; });
    copia.querySelectorAll('select').forEach((s) => { s.value = ''; });
    contenedor.appendChild(copia);
    renumerar();
    return copia;
  }

  document.getElementById('agregar').addEventListener('click', () => {
    nuevo().querySelector('select').focus();
  });

  contenedor.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-quitar]');
    if (!boton) return;
    boton.closest('[data-renglon]').remove();
    renumerar();
  });

  /** Primer renglón vacío o uno nuevo. */
  function renglonLibre() {
    const libre = Array.from(contenedor.querySelectorAll('[data-renglon]')).find((r) => !r.querySelector('select').value);
    return libre || nuevo();
  }

  caja.addEventListener('escaneado', async () => {
    const codigo = caja.value.trim();
    if (!codigo) return;
    try {
      const r = await fetch('/api/codigo?c=' + encodeURIComponent(codigo), { headers: { Accept: 'application/json' } });
      const d = await r.json();
      if (!d.ok) { mensaje.textContent = d.mensaje || 'No se reconoció el código.'; return; }
      // Si ya hay un renglón con el mismo producto y lote, solo enfoca sus cajas
      const existente = Array.from(contenedor.querySelectorAll('[data-renglon]')).find((x) =>
        x.querySelector('select').value === d.sku && d.lote && x.querySelector('[name=num_lote]').value.toUpperCase() === d.lote.toUpperCase());
      const renglon = existente || renglonLibre();
      renglon.querySelector('select').value = d.sku;
      if (d.lote) renglon.querySelector('[name=num_lote]').value = d.lote;
      if (d.caducidad) renglon.querySelector('[name=caducidad]').value = d.caducidad;
      mensaje.textContent = d.nombre + (d.lote ? ' · lote ' + d.lote : ' · sin lote en el código: captúralo') +
        (d.caducidad ? '' : ' · sin caducidad en el código: captúrala');
      const pendiente = !d.lote ? '[name=num_lote]' : !d.caducidad ? '[name=caducidad]' : '[name=cajas]';
      renglon.querySelector(pendiente).focus();
    } catch (e) {
      mensaje.textContent = 'No se pudo consultar el código. Revisa la conexión.';
    } finally {
      caja.value = '';
    }
  });

  renumerar();
}());
