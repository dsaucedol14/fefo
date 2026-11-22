/**
 * Etiquetas en PDF (P3 VIII.C): QR de tarima con su ID de 18 dígitos legible y sus lotes, y hojas de etiquetas
 * QR de posición con su clave RN-04. El QR se dibuja módulo por módulo, sin imágenes intermedias.
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const MM = 72 / 25.4;

function dibujarQr(doc: PDFKit.PDFDocument, texto: string, x: number, y: number, lado: number) {
  const qr = QRCode.create(texto, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const margen = 2;
  const celda = lado / (n + margen * 2);
  doc.save().fillColor('#000');
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(f, c)) doc.rect(x + (c + margen) * celda, y + (f + margen) * celda, celda + 0.2, celda + 0.2).fill();
    }
  }
  doc.restore();
}

function aBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((ok, mal) => {
    const partes: Buffer[] = [];
    doc.on('data', (b: Buffer) => partes.push(b));
    doc.on('end', () => ok(Buffer.concat(partes)));
    doc.on('error', mal);
    doc.end();
  });
}

const fecha = (f: string) => f.split('-').reverse().join('/');

/** Etiqueta de 100 × 150 mm para pegar en la tarima. */
export function etiquetaTarima(t: { id_tarima: string; lotes: Array<{ producto: string; num_lote: string; caducidad_vigente: string; cajas: number }> }) {
  const doc = new PDFDocument({ size: [100 * MM, 150 * MM], margin: 6 * MM, info: { Title: `Tarima ${t.id_tarima}` } });
  dibujarQr(doc, t.id_tarima, 15 * MM, 6 * MM, 70 * MM);
  doc.font('Courier-Bold').fontSize(15).text(t.id_tarima, 6 * MM, 79 * MM, { width: 88 * MM, align: 'center', characterSpacing: 0.5 });
  doc.font('Helvetica-Bold').fontSize(9).text('Producto', 6 * MM, 90 * MM).text('Lote', 56 * MM, 90 * MM).text('Cad.', 72 * MM, 90 * MM).text('Cajas', 85 * MM, 90 * MM);
  let y = 95 * MM;
  doc.font('Helvetica').fontSize(8.5);
  for (const l of t.lotes.slice(0, 8)) {
    doc.text(l.producto, 6 * MM, y, { width: 48 * MM, height: 9, ellipsis: true })
      .text(l.num_lote, 56 * MM, y).text(fecha(l.caducidad_vigente), 72 * MM, y).text(String(l.cajas), 85 * MM, y);
    y += 6 * MM;
  }
  return aBuffer(doc);
}

/** Hoja carta con etiquetas de 62 × 38 mm (3 × 6) para posiciones. */
export function etiquetasPosiciones(posiciones: Array<{ id_posicion: string; tipo: string; profundidad: number }>) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: 'Etiquetas de posiciones' } });
  const ancho = 62 * MM, alto = 38 * MM, margenX = (215.9 * MM - 3 * ancho) / 2, margenY = 12 * MM;
  posiciones.forEach((p, i) => {
    const k = i % 18;
    if (i > 0 && k === 0) doc.addPage();
    const x = margenX + (k % 3) * ancho;
    const y = margenY + Math.floor(k / 3) * (alto + 3 * MM);
    doc.lineWidth(0.5).roundedRect(x + 1, y, ancho - 2, alto, 6).stroke('#888');
    dibujarQr(doc, p.id_posicion, x + 2 * MM, y + 2 * MM, 34 * MM);
    doc.fillColor('#000').font('Courier-Bold').fontSize(13).text(p.id_posicion, x + 37 * MM, y + 12 * MM, { width: 24 * MM });
    doc.font('Helvetica').fontSize(8).text(p.tipo === 'piso' ? `Piso · prof. ${p.profundidad}` : p.tipo === 'camara' ? 'Cámara fría' : 'Rack',
      x + 37 * MM, y + 26 * MM, { width: 24 * MM });
  });
  return aBuffer(doc);
}
