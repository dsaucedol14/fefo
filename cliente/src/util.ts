/** UUID v4 para id_mov (lo genera el dispositivo; la base lo usa para la idempotencia). */
export const randomId = () => crypto.randomUUID();
