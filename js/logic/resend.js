// SOURCE : renvois de lignes et de listes des clés, ménagés pour l'instance (un renvoi à la fois par
// document, un budget d'octets par fenêtre de temps).
import { KIND, ORDER_COL, RESEND_ALL, RESEND_COL, TRACK_COL, TYPE_COL, parseJson } from './common.js';

export const RESEND_CHUNK = 200; // lignes par tranche de renvoi

// Renvoi de lignes (numéros de ligne de la table SOURCE) : une marque nouvelle à chaque fois, pour
// que la valeur change même si les lignes sont les mêmes.
export const resendValue = (mark, ids) => `${mark}:${ids.join(',')}`;

// Renvoi reprenable : lignes d'une table à renvoyer depuis `since` (RESEND_ALL : toutes), dans
// l'ordre de MajLe. Chaque tranche part avec la marque `chunkMark` : ses lignes et les suivantes
// restent à envoyer, de sorte qu'un renvoi interrompu reprend à la dernière tranche.
const majle = r => r[ORDER_COL] || 0;
export const rowsSince = (rows, since) => rows.filter(r => since <= RESEND_ALL || majle(r) >= since)
  .sort((a, b) => majle(a) - majle(b) || a.id - b.id);
export const chunkMark = (part, since) => Math.max(since, majle(part[0]));

// Morceau `n` de la liste complète d'un renvoi, après la clé `after` (Synchro_Renvoi de la ligne
// 'cles'). `mark` distingue un renvoi des autres.
export const listRequest = (mark, n, after) => JSON.stringify({ marque: mark, n, apres: after });

// Suivi des clés d'une table (ligne 'suivi') : { t, top, s, seaux, trop } ; {} s'il n'y en a pas.
export const trackState = row => (row && row[TYPE_COL] === KIND.track ? parseJson(row[TRACK_COL], null) || {} : {});

// Trop de clés à envoyer d'un coup, et la liste complète pas encore renvoyée depuis.
export const listOverdue = (row) => {
  const { trop } = trackState(row);
  return Boolean(trop) && trop !== row[RESEND_COL];
};

// Ligne Synchro qui demande d'envoyer la liste complète de sa table : renvoi de la liste interrompu
// (la demande est restée dans la ligne 'cles'), ou trop de clés parties d'un coup (suivi).
export const listDue = r => (r[TYPE_COL] === KIND.keys && Boolean(r[RESEND_COL])) || listOverdue(r);

// ---------------------------------------------------------------------------------------------
// Renvois ménagés (ligne 'charge' de Synchro, colonne Synchro_Renvoi, en JSON) : un renvoi à la
// fois par document, toutes pages et personnes confondues (`par` : la page qui renvoie, `le` : son
// dernier signe de vie, en secondes ; au-delà de LEASE_S sans signe, une autre page reprend), et au
// plus RESEND_BUDGET octets envoyés par fenêtre de BUDGET_WINDOW secondes, tous destinataires
// comptés (`envoye` : [[minute, octets]]) ; au-delà, le renvoi attend jusqu'à `reprise`. Les
// modifications ordinaires ne passent pas par là : elles partent toujours.
export const RESEND_BUDGET = 20000000;
export const BUDGET_WINDOW = 600;
export const LEASE_S = 120;

export function parseCharge(text) {
  const charge = parseJson(text, null) || {};
  const pairs = Array.isArray(charge.envoye) ? charge.envoye.filter(e => Array.isArray(e) && e.length === 2) : [];
  return {
    par: typeof charge.par === 'string' ? charge.par : '', le: Number(charge.le) || 0, reprise: Number(charge.reprise) || 0,
    envoye: pairs.map(([at, n]) => [Number(at) || 0, Number(n) || 0]),
  };
}

// Une autre page renvoie, et a donné signe de vie depuis moins de LEASE_S secondes. Une page se
// nomme `navigateur.page` ; la question n'est posée que sous le verrou du navigateur (une page de ce
// navigateur qui renverrait encore le tiendrait) : une page du même navigateur est donc fermée.
export function chargeBusy(charge, page, now) {
  const browser = id => id.split('.')[0];
  return Boolean(charge.par) && browser(charge.par) !== browser(page) && now - charge.le < LEASE_S;
}

// Ajoute `bytes` octets envoyés à l'instant `now` ; oublie ce qui est sorti de la fenêtre.
export function addSpent(charge, now, bytes) {
  const minute = Math.floor(now / 60) * 60;
  const envoye = charge.envoye.filter(([at]) => at > now - BUDGET_WINDOW).map(([at, n]) => [at, n]);
  const last = envoye[envoye.length - 1];
  if (last && last[0] === minute) last[1] += bytes;
  else envoye.push([minute, bytes]);
  return { ...charge, envoye };
}

// Secondes à attendre avant d'envoyer encore : 0 tant que la fenêtre n'a pas atteint le budget,
// sinon le temps que les plus anciens envois en sortent.
export function budgetWait(charge, now) {
  const recent = charge.envoye.filter(([at]) => at > now - BUDGET_WINDOW).sort((a, b) => a[0] - b[0]);
  let spent = recent.reduce((sum, [, n]) => sum + n, 0);
  let wait = 0;
  for (const [at, n] of recent) {
    if (spent < RESEND_BUDGET) break;
    spent -= n;
    wait = at + BUDGET_WINDOW - now;
  }
  return Math.max(0, wait);
}
