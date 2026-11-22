/**
 * Recorrido del prototipo en un teléfono emulado (PE-02, PE-04, PE-05, PE-07, PE-09 de P3):
 * acceso y aviso, búsqueda con bloqueo, ubicación por escaneo, surtido FEFO con alternativa y motivo, y captura
 * sin red con la cola visible y su sincronización al recuperar la señal.
 * Requiere el servidor en marcha con la base del caso simulado. Con CAPTURAS=<carpeta> guarda cada pantalla.
 */
import { test, expect, type Page } from '@playwright/test';

const CLAVE = process.env.CLAVE_FEFO ?? 'almacen2026';
const capturas = process.env.CAPTURAS;
let n = 0;
async function foto(page: Page, nombre: string) {
  if (capturas) await page.screenshot({ path: `${capturas}/${String(++n).padStart(2, '0')}-${nombre}.png`, fullPage: true });
}

async function entrar(page: Page, usuario: string) {
  await page.goto('/');
  await page.getByLabel('Usuario').fill(usuario);
  await page.getByLabel('Contraseña').fill(CLAVE);
  await page.getByRole('button', { name: 'Entrar' }).click();
  const aviso = page.getByRole('button', { name: 'Leí el aviso y continúo' });
  const inicio = page.getByRole('link', { name: /Recibir tarima/ });
  await expect(aviso.or(inicio)).toBeVisible();
  if (await aviso.isVisible()) {
    await foto(page, `aviso-${usuario}`);
    await aviso.click();
  }
  await expect(page.getByRole('link', { name: /Recibir tarima/ })).toBeVisible();
}

/** Escribe en el campo de escaneo y pulsa Enter, como un lector de código. */
async function escanear(page: Page, etiqueta: string | RegExp, codigo: string) {
  const campo = page.getByLabel(etiqueta);
  await campo.fill(codigo);
  await campo.press('Enter');
}

test.describe.configure({ mode: 'serial' });

test('supervisor: pedido con lote FEFO bloqueado, alternativa y motivo de excepción', async ({ page, request }) => {
  await entrar(page, 'sup01');
  await foto(page, 'inicio-supervisor');

  // Un producto cuyo lote FEFO esté detrás de otras tarimas (C1)
  const api = page.request;
  const productos = await (await api.get('/api/productos')).json() as Array<{ sku: string; nombre: string }>;
  let elegido: { sku: string } | null = null;
  for (const p of productos) {
    const r = await (await api.get(`/api/buscar?q=${p.sku}`)).json() as { resultados: Array<{ es_candidato_fefo: boolean; tarimas_delante: number; dias_restantes: number; id_posicion: string | null }> };
    const bloqueado = r.resultados.some((x) => x.es_candidato_fefo && x.tarimas_delante > 0);
    const accesible = r.resultados.some((x) => !x.es_candidato_fefo && x.tarimas_delante === 0 && x.dias_restantes >= 0 && x.id_posicion);
    if (bloqueado && accesible) { elegido = p; break; }
  }
  test.skip(!elegido, 'El caso simulado no tiene un lote FEFO bloqueado ahora');
  void request;

  await page.goto('/#/admin?panel=pedido');
  await page.getByLabel('Cliente o referencia').fill('Escenario E2E');
  await page.locator('select').first().selectOption(elegido!.sku);
  await page.getByLabel('Cajas').fill('2');
  await foto(page, 'pedido-nuevo');
  await page.getByRole('button', { name: 'Crear pedido y lista de surtido' }).click();
  await expect(page.getByText(/Bloqueado por \d/)).toBeVisible();
  await foto(page, 'lista-surtido');
  await page.locator('a.opt').first().click();
  await expect(page.getByText('Lote FEFO propuesto (RN-01)')).toBeVisible();
  await expect(page.getByText('Alternativa accesible')).toBeVisible();
  await foto(page, 'surtido-fefo-bloqueado');      // Fig. 11a

  // Se toma la alternativa: la pantalla exige motivo con «tarima inaccesible» preseleccionado (Fig. 11b)
  const altTarima = await page.evaluate(async () => {
    const pedido = decodeURIComponent(location.hash.split('/')[2]);
    const r = await fetch('/api/listas-surtido', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_pedido: pedido }) });
    const l = await r.json();
    return l.renglones[0].reservas[0].alternativa?.id_tarima as string;
  });
  await escanear(page, 'Escanear tarima tomada', altTarima);
  await expect(page.getByText('Lote distinto al propuesto')).toBeVisible();
  await expect(page.locator('.opt.sel')).toHaveText('Tarima inaccesible');
  await foto(page, 'motivo-excepcion');
  await page.getByRole('button', { name: 'Confirmar salida' }).click();
  await expect(page.locator('.aviso-flotante')).toContainText('excepción');
  await foto(page, 'salida-excepcion');
});

test('almacenista: buscar, ubicar sin red, cola visible y sincronización', async ({ page, context }) => {
  await entrar(page, 'alm01');
  await foto(page, 'inicio-almacenista');

  // Buscar un lote: posición, profundidad y bloqueo (PE-05)
  const fila = await page.evaluate(async () => {
    const r = await fetch('/api/buscar?q=Leche').then((x) => x.json());
    return r.resultados[0] as { num_lote: string };
  });
  await page.goto('/#/buscar');
  await escanear(page, 'Lote, producto, tarima o posición', fila.num_lote);
  await expect(page.locator('.card .big').first()).toBeVisible();
  await foto(page, 'busqueda');

  // Una tarima de la zona B y un lugar libre compatible
  const { tarima, origen, destino } = await page.evaluate(async () => {
    const mapa = await fetch('/api/mapa').then((x) => x.json()) as Array<{ id_posicion: string; zona: string; id_tarima: string | null; profundidad: number; fila: string | null }>;
    const t = mapa.find((c) => c.zona === 'B' && c.id_tarima && c.profundidad === 1)!;
    const libre = mapa.find((c) => c.zona === 'A' && !c.id_tarima)!;
    return { tarima: t.id_tarima!, origen: t.id_posicion, destino: libre.id_posicion };
  });
  await page.goto(`/#/mover?tarima=${tarima}`);
  await expect(page.getByText('Posiciones sugeridas (RF-05)')).toBeVisible();
  await foto(page, 'mover-sugerencias');

  // Modo avión: el movimiento entra a la cola (Fig. 11c)
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await escanear(page, '2. Posición destino', destino);
  await page.getByRole('button', { name: /Confirmar movimiento/ }).click();
  await expect(page.locator('.aviso-flotante')).toContainText('Guardado sin red');
  await expect(page.locator('.red')).toHaveText('Sin red');
  await page.goto('/#/pendientes');
  await expect(page.getByText('1 movimiento pendiente')).toBeVisible();
  await foto(page, 'cola-sin-red');

  // Vuelve la señal: se sincroniza y la base aplica el movimiento
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Enviar ahora' }).click();
  await expect(page.getByText('No hay movimientos pendientes.')).toBeVisible();
  const ahora = await page.evaluate(async (id) => (await fetch(`/api/tarimas/${id}`).then((x) => x.json())).id_posicion, tarima);
  expect(ahora).toBe(destino);
  expect(ahora).not.toBe(origen);
  await foto(page, 'sincronizado');

  // Devolverla a su lugar deja el caso simulado como estaba
  await page.goto(`/#/mover?tarima=${tarima}`);
  await escanear(page, '2. Posición destino', origen);
  await page.getByRole('button', { name: /Confirmar movimiento/ }).click();
  await expect(page.locator('.aviso-flotante')).toContainText('movida');
});
