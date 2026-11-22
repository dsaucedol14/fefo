/**
 * Campos de escaneo. Funcionan con tres entradas:
 *  - lector de código USB o Bluetooth que «teclea» el código y Enter;
 *  - captura manual;
 *  - cámara del teléfono (html5-qrcode). La cámara solo funciona en HTTPS o en localhost.
 * Cada lectura con cámara o Enter suma 1 al campo oculto «escaneos» del formulario (bitácora de evaluación).
 */
(function () {
  const visor = document.getElementById('visor');
  const mensaje = document.getElementById('visor-mensaje');
  let lector = null;
  let destino = null;

  function contar(form) {
    if (!form) return;
    let campo = form.querySelector('input[name="escaneos"]');
    if (!campo) {
      campo = document.createElement('input');
      campo.type = 'hidden';
      campo.name = 'escaneos';
      campo.value = '0';
      form.appendChild(campo);
    }
    campo.value = String((Number(campo.value) || 0) + 1);
  }

  /** Después de una lectura: envía el formulario o pasa al siguiente campo de escaneo. */
  function avanzar(input) {
    input.dispatchEvent(new CustomEvent('escaneado', { bubbles: true, detail: input.value }));
    if (input.hasAttribute('data-enviar') && input.form) {
      if (input.form.requestSubmit) input.form.requestSubmit(); else input.form.submit();
      return;
    }
    const campos = Array.from(input.form ? input.form.querySelectorAll('[data-escaner]') : []);
    const siguiente = campos[campos.indexOf(input) + 1];
    if (siguiente) siguiente.focus();
    else {
      const boton = input.form && input.form.querySelector('[data-confirmar]');
      if (boton) boton.focus();
    }
  }

  // Enter en un campo de escaneo = lectura completa (los lectores de código terminan con Enter)
  document.addEventListener('keydown', (e) => {
    const input = e.target;
    if (e.key !== 'Enter' || !input.matches || !input.matches('[data-escaner]')) return;
    if (!input.value.trim()) { e.preventDefault(); return; }
    e.preventDefault();
    contar(input.form);
    avanzar(input);
  });

  async function cerrar() {
    if (lector) {
      try { if (lector.isScanning) await lector.stop(); } catch (e) { /* ya detenido */ }
      try { lector.clear(); } catch (e) { /* sin vista */ }
    }
    lector = null;
    visor.hidden = true;
    if (destino) destino.focus();
  }

  async function abrir(input) {
    destino = input;
    visor.hidden = false;
    if (!window.isSecureContext) {
      mensaje.textContent = 'La cámara solo funciona con HTTPS. Abre la dirección https:// del sistema (puerto HTTPS) o usa un lector de código.';
      return;
    }
    if (typeof Html5Qrcode === 'undefined') {
      mensaje.textContent = 'No se pudo cargar el lector de la cámara. Escribe el código o usa un lector.';
      return;
    }
    mensaje.textContent = 'Apunta la cámara al código QR o de barras.';
    const F = Html5QrcodeSupportedFormats;
    lector = new Html5Qrcode('lector', {
      verbose: false,
      formatsToSupport: [F.QR_CODE, F.CODE_128, F.EAN_13, F.EAN_8, F.DATA_MATRIX, F.UPC_A, F.ITF],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    });
    try {
      await lector.start({ facingMode: 'environment' }, { fps: 12, qrbox: (w, h) => {
        const lado = Math.floor(Math.min(w, h) * 0.75);
        return { width: lado, height: Math.floor(lado * 0.75) };
      } }, async (texto) => {
        if (navigator.vibrate) navigator.vibrate(80);
        input.value = texto.trim();
        contar(input.form);
        await cerrar();
        avanzar(input);
      }, () => {});
    } catch (e) {
      mensaje.textContent = 'No se pudo abrir la cámara: ' + (e && e.message ? e.message : e) + '. Revisa el permiso de cámara del navegador.';
    }
  }

  document.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-camara]');
    if (!boton) return;
    const input = document.getElementById(boton.getAttribute('data-camara'));
    if (input) abrir(input);
  });
  document.getElementById('visor-cerrar').addEventListener('click', cerrar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !visor.hidden) cerrar(); });
}());
