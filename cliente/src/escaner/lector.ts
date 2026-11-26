/**
 * Escáner con la cámara del teléfono (CU-14, ADR-002): BarcodeDetector nativo de Chrome en Android y ZXing como
 * respaldo en otros navegadores. Lee QR de tarima y posición y GS1-128 / DataMatrix de cajas. Linterna del teléfono
 * para poca luz (riesgo R3). Requiere HTTPS (o localhost).
 */
import { h, icono, vibrar } from '../ui.js';

const FORMATOS = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'data_matrix', 'upc_a', 'itf'];

interface Detector { detect(fuente: CanvasImageSource): Promise<Array<{ rawValue: string }>> }
declare global {
  interface Window { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }
}

export function escanear(): Promise<string | null> {
  return new Promise((resolver) => {
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const mensaje = h('p', null, 'Apunta al código QR o de barras.');
    const linterna = h('button', { class: 'btn sec', type: 'button', hidden: true }, 'Linterna');
    const cancelar = h('button', { class: 'btn sec', type: 'button' }, 'Cancelar');
    const visor = h('div', { class: 'visor', role: 'dialog', 'aria-label': 'Escanear código' }, video, mensaje, linterna, cancelar);
    document.body.appendChild(visor);
    let flujo: MediaStream | null = null;
    let detener: (() => void) | null = null;
    let terminado = false;

    const cerrar = (valor: string | null) => {
      if (terminado) return;
      terminado = true;
      detener?.();
      flujo?.getTracks().forEach((t) => t.stop());
      visor.remove();
      if (valor) vibrar(70);
      resolver(valor);
    };
    cancelar.addEventListener('click', () => cerrar(null));

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      mensaje.textContent = 'La cámara solo funciona con HTTPS. Escribe el código o usa un lector.';
      return;
    }

    (async () => {
      try {
        flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        video.srcObject = flujo;
        await video.play();
        const pista = flujo.getVideoTracks()[0];
        const capacidades = (pista.getCapabilities?.() ?? {}) as { torch?: boolean };
        if (capacidades.torch) {
          let encendida = false;
          linterna.hidden = false;
          linterna.addEventListener('click', async () => {
            encendida = !encendida;
            await pista.applyConstraints({ advanced: [{ torch: encendida } as MediaTrackConstraintSet] }).catch(() => {});
          });
        }
        if (window.BarcodeDetector) {
          const soportados = await window.BarcodeDetector.getSupportedFormats();
          const detector = new window.BarcodeDetector({ formats: FORMATOS.filter((f) => soportados.includes(f)) });
          let activo = true;
          detener = () => { activo = false; };
          const ciclo = async () => {
            if (!activo) return;
            try {
              const r = await detector.detect(video);
              if (r[0]?.rawValue) return cerrar(r[0].rawValue);
            } catch { /* cuadro sin imagen */ }
            setTimeout(ciclo, 120);
          };
          ciclo();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const lector = new BrowserMultiFormatReader();
          const controles = await lector.decodeFromStream(flujo, video, (resultado) => {
            if (resultado) cerrar(resultado.getText());
          });
          detener = () => controles.stop();
        }
      } catch (e) {
        mensaje.textContent = `No se pudo abrir la cámara (${(e as Error).message}). Revisa el permiso o escribe el código.`;
      }
    })();
  });
}

/**
 * Campo de escaneo: lector USB/Bluetooth (teclea y Enter), captura manual o cámara. Cada lectura completa llama a
 * alLeer y suma al contador de escaneos de la operación (evidencia de la bitácora).
 */
export function campoEscaneo(o: { etiqueta: string; marcador?: string; valor?: string; enfocar?: boolean; contador?: { n: number };
  alLeer: (valor: string) => void }) {
  const id = `esc-${Math.random().toString(36).slice(2, 8)}`;
  const entrada = h('input', { id, value: o.valor ?? '', placeholder: o.marcador ?? 'Escanea o escribe el código', autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go' });
  const leer = (v: string) => {
    const t = v.trim();
    if (!t) return;
    if (o.contador) o.contador.n++;
    o.alLeer(t);
  };
  entrada.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); leer(entrada.value); }
  });
  const camara = h('button', { class: 'camara', type: 'button', 'aria-label': 'Escanear con la cámara', onclick: async () => {
    const v = await escanear();
    if (v) { entrada.value = v; leer(v); }
  } }, icono('camara'));
  if (o.enfocar) setTimeout(() => entrada.focus(), 50);
  return { el: h('div', null, h('label', { for: id }, o.etiqueta), h('div', { class: 'escaneo' }, entrada, camara)), entrada };
}
