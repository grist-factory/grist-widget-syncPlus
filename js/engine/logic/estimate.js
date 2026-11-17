// SOURCE : ce qu'un envoi va coûter (poids, lots, durée), estimé avant de le lancer d'après un
// échantillon de lignes. Une estimation, pas une mesure : elle sert à prévenir (« environ 40
// minutes »), pas à promettre.
import { LOT_MAX } from './formulas.js';
import { BUDGET_WINDOW, RESEND_BUDGET, RESEND_CHUNK, nextChunkSize } from './resend.js';

// Ce que chaque ligne d'un lot porte en plus de ses valeurs : clé, heure, marque de suppression et
// ponctuation (« ["…", 1760000000.0, false, {…}], »).
export const LINE_OVERHEAD = 64;
// Secondes par lot : écriture dans Synchro, recalcul de la formule, envoi, accusé de la file de Grist.
// Mesuré (Grist 1.7.22, 30 000 lignes de 20 colonnes) : 160 lots en 2 min 40.
export const LOT_SECONDS = 1;

// Poids moyen d'une ligne du lot, d'après des lignes d'exemple (objets { colonne: valeur }). Le nom
// de chaque colonne est répété à chaque ligne, d'où le poids qui grandit avec leur nombre.
export function lineBytes(sample) {
  const lines = sample.filter(Boolean);
  if (!lines.length) return LINE_OVERHEAD;
  const total = lines.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
  return Math.ceil(total / lines.length) + LINE_OVERHEAD;
}

// Coût d'une table de `rows` lignes de `bytesPerLine` octets, pour un destinataire : { rows, bytes,
// lots, perLot }. `lots` compte les lots utiles, plus un lot coupé au premier envoi si une tranche
// normale ne tient pas dans un lot (les suivantes sont alors plus petites, voir nextChunkSize).
export function tableCost({ rows, bytesPerLine }) {
  const fit = Math.floor(LOT_MAX / Math.max(1, bytesPerLine));
  const cutFirst = rows > 0 && fit < RESEND_CHUNK ? 1 : 0;
  const per = cutFirst ? Math.max(1, nextChunkSize(RESEND_CHUNK, RESEND_CHUNK, fit)) : RESEND_CHUNK;
  const lots = rows > 0 ? Math.ceil(rows / per) + cutFirst : 0;
  return { rows, bytes: Math.ceil(rows * bytesPerLine + cutFirst * Math.min(LOT_MAX, RESEND_CHUNK * bytesPerLine)), lots, perLot: per };
}

// Envoi complet de `tables` ([{ rows, bytesPerLine }]) à `recipients` destinataires : { rows, bytes,
// lots, seconds }. Les octets comptent une copie par destinataire (le budget aussi). Durée : au moins
// le temps des lots, et au moins ce que le budget laisse passer (la fenêtre glissante autorise le
// budget plein tout de suite, puis un budget de plus par fenêtre).
export function estimateSend({ tables, recipients = 1 }) {
  const costs = tables.map(tableCost);
  const sum = key => costs.reduce((n, c) => n + c[key], 0);
  const copies = Math.max(1, recipients);
  const bytes = sum('bytes') * copies;
  const lots = sum('lots');
  const seconds = Math.round(Math.max(lots * LOT_SECONDS, (bytes / RESEND_BUDGET - 1) * BUDGET_WINDOW));
  return { rows: sum('rows'), bytes, lots, seconds: Math.max(0, seconds), recipients: copies };
}

// Durée à dire à une personne : { h, min } arrondis à ce qui a un sens (la minute jusqu'à 10 minutes,
// 5 minutes jusqu'à une heure, 10 minutes ensuite). `{ h: 0, min: 0 }` : moins d'une minute.
export function durationParts(seconds) {
  const minutes = seconds / 60;
  if (minutes < 1) return { h: 0, min: 0 };
  const step = minutes <= 10 ? 1 : minutes <= 60 ? 5 : 10;
  const rounded = Math.max(1, Math.round(minutes / step) * step);
  return { h: Math.floor(rounded / 60), min: rounded % 60 };
}

// Poids à dire : « 33 Mo », « 850 Ko ».
export function sizeParts(bytes) {
  return bytes >= 1000000 ? { n: Math.round(bytes / 1000000), unit: 'MB' } : { n: Math.max(1, Math.round(bytes / 1000)), unit: 'KB' };
}

// Un envoi long mérite une confirmation et un avertissement : au-delà de ce nombre de secondes.
export const LONG_SECONDS = 180;
