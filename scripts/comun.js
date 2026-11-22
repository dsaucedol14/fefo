/** Utilidades de los scripts de carga: reiniciar la base y un generador pseudoaleatorio con semilla. */
const mysql = require('mysql2/promise');
const config = require('../src/config');

/** Borra la base completa (la bitácora y los movimientos son de solo inserción, por eso se borra la base). */
async function reiniciarBase() {
  const { database, ...conexion } = config.db;
  const con = await mysql.createConnection(conexion);
  await con.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await con.end();
}

/** Mulberry32: mismo resultado con la misma semilla. */
function generador(semilla) {
  let a = semilla >>> 0;
  const azar = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  azar.entero = (min, max) => min + Math.floor(azar() * (max - min + 1));
  azar.elegir = (arr) => arr[Math.floor(azar() * arr.length)];
  return azar;
}

/**
 * Posiciones del caso «Distribuidora Sierra Norte» (P2, Sección II): zona A rack de 3 niveles (96),
 * zona B piso en 28 filas de 4 de profundidad (112) y zona C cámara fría (24). Claves de RN-04.
 */
function posicionesCaso() {
  const pos = [];
  const dos = (n) => String(n).padStart(2, '0');
  for (let p = 1; p <= 4; p++) for (let r = 1; r <= 8; r++) for (let n = 1; n <= 3; n++) {
    pos.push({ id: `A-P${dos(p)}-R${dos(r)}-N${n}`, zona: 'A', tipo: 'RACK', fila: null, prof: 1, frio: 0 });
  }
  for (let f = 1; f <= 28; f++) for (let d = 1; d <= 4; d++) {
    pos.push({ id: `B-F${dos(f)}-D${d}`, zona: 'B', tipo: 'PISO', fila: `B-F${dos(f)}`, prof: d, frio: 0 });
  }
  for (let p = 1; p <= 2; p++) for (let r = 1; r <= 4; r++) for (let n = 1; n <= 3; n++) {
    pos.push({ id: `C-P${dos(p)}-R${dos(r)}-N${n}`, zona: 'C', tipo: 'RACK', fila: null, prof: 1, frio: 1 });
  }
  return pos;
}

module.exports = { reiniciarBase, generador, posicionesCaso };
