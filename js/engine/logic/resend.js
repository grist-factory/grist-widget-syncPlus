// SOURCE : renvois de lignes et de listes des clés, ménagés pour l'instance (un renvoi à la fois par
// document, un budget d'octets par fenêtre de temps).
import { EXPORT_COL, KIND, LIST_COL, MISSING_COL, ORDER_COL, RESEND_ALL, RESEND_COL, TABLE_COL, TRACK_COL, TYPE_COL, parseJson } from './common.js';
import { swapExports } from './exports.js';

export const RESEND_CHUNK = 200; // lignes par tranche de renvoi

// Renvoi de lignes (numéros de ligne de la table SOURCE) : une marque nouvelle à chaque fois, pour
// que la valeur change même si les lignes sont les mêmes. `rest` : combien de lignes de la table
// partiront encore après cette tranche (voir announceRest) ; la formule du lot l'annonce à la CIBLE
// (`restant`). Une formule d'avant ne lit que la dernière partie, les numéros : le reste lui est
// inconnu et sans effet.
export const resendValue = (mark, ids, rest = null) => (rest === null ? `${mark}:${ids.join(',')}` : `${mark}:${rest}:${ids.join(',')}`);

// Ce que la CIBLE doit savoir d'un renvoi en tranches : les lignes qui n'ont pas encore été envoyées
// (`left` : celles des tranches à venir). Le widget compte toutes les lignes de la table, la formule
// n'en envoie que celles qui ont une clé et passent le filtre : `ratio` (part des lignes de la table
// qui peuvent partir, 1 sans filtre) ramène le compte à ce qui arrivera, arrondi vers le haut tant qu'il
// reste des tranches. La dernière tranche annonce 0 : c'est ce qui efface l'avis de la CIBLE.
export const announceRest = (left, ratio = 1) => (left > 0 ? Math.max(1, Math.ceil(left * Math.min(1, Math.max(0, ratio)))) : 0);

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

// Lot d'une table dont des lignes ne sont pas parties (lot coupé, voir Sync_Etat).
export const lotLate = r => r[TYPE_COL] === KIND.lot && r[MISSING_COL] > 0;

// Ce que le rattrapage SOURCE doit renvoyer : les lots coupés (`late`), et les listes des clés dues
// (`lists`), sauf celles d'une table dont le lot est coupé (son renvoi porte la liste) ou d'un
// export qui change de forme (ligne `swap`).
export function dueRows(rows) {
  const late = rows.filter(lotLate);
  const same = (a, b) => a[EXPORT_COL] === b[EXPORT_COL] && a[TABLE_COL] === b[TABLE_COL];
  const swaps = swapExports(rows);
  return { late, lists: rows.filter(r => listDue(r) && !late.some(l => same(l, r)) && !swaps.has(r[EXPORT_COL])) };
}

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
    envoye: pairs.map(([at, n]) => [Number(at) || 0, Number(n) || 0]), prog: parseProg(charge.prog),
  };
}

// ---------------------------------------------------------------------------------------------
// Avancement d'un renvoi (`prog` de la ligne 'charge') : { exp, table, done, total, lots, lotsTotal,
// bytes, at, last } = lignes parties sur lignes à envoyer, lots partis sur lots prévus (environ : un
// lot coupé en refait), octets écrits dans les lots (une copie par destinataire), début et dernier
// signe, en secondes. Gardé après une page fermée en route : la carte dit où le renvoi s'est arrêté.
export function parseProg(p) {
  if (!p || typeof p !== 'object' || typeof p.exp !== 'string' || !p.exp) return null;
  const num = x => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0);
  return {
    exp: p.exp, table: typeof p.table === 'string' ? p.table : '', done: num(p.done), total: num(p.total), lots: num(p.lots),
    lotsTotal: num(p.lotsTotal), bytes: num(p.bytes), at: num(p.at), last: num(p.last),
  };
}

export const startProg = (exp, total, lotsTotal, now) => ({ exp, table: '', done: 0, total, lots: 0, lotsTotal, bytes: 0, at: Math.floor(now), last: Math.floor(now) });
export const addProg = (prog, { rows, bytes, now }) => ({ ...prog, done: prog.done + rows, lots: prog.lots + 1, bytes: prog.bytes + bytes, last: Math.floor(now) });
export const percent = prog => (prog.total > 0 ? Math.min(100, Math.floor((prog.done * 100) / prog.total)) : 0);

// Octets déjà écrits dans la fenêtre du budget.
export const windowSpent = (charge, now) => charge.envoye.filter(([at]) => at > now - BUDGET_WINDOW).reduce((sum, [, n]) => sum + n, 0);

// Secondes qu'il reste à un renvoi : le plus grand de deux calculs, celui du rythme tenu jusqu'ici
// (pauses comprises) et celui du budget (ce qui reste à écrire, moins ce que la fenêtre peut encore
// prendre). Null tant qu'il est trop tôt pour le dire.
export function etaSeconds(prog, charge, now) {
  if (!prog || prog.done < 1 || prog.total <= prog.done) return null;
  const elapsed = now - prog.at;
  if (elapsed < 15) return null;
  const left = prog.total - prog.done;
  const byRate = left / (prog.done / elapsed);
  const room = Math.max(0, RESEND_BUDGET - windowSpent(charge, now));
  const byBudget = Math.max(0, ((left * (prog.bytes / prog.done) - room) / RESEND_BUDGET) * BUDGET_WINDOW);
  return Math.round(Math.max(byRate, byBudget));
}

// Un lot est coupé quand il ne porte pas toutes les lignes demandées (hors lignes trop grosses pour
// un envoi, qui ne partiront jamais : `big`).
export const lotCut = sent => Boolean(sent) && sent.total > sent.lines.length + sent.big.length;

// Taille des tranches suivantes après un lot coupé : un peu moins que ce qui a tenu (`fit` lignes
// sur `asked`), au lieu de couper chaque tranche en deux (un lot coupé est parti pour rien et pèse
// sur le budget). Jamais plus grande qu'avant.
export function nextChunkSize(size, asked, fit) {
  if (fit >= asked) return size;
  return Math.max(1, Math.min(size, Math.floor(fit * 0.9) || 1));
}

// Nombre de lots que demandera un renvoi de `rows` lignes en tranches de `size`.
export const chunkCount = (rows, size = RESEND_CHUNK) => (rows > 0 ? Math.ceil(rows / size) : 1);

// Lignes que la table d'un export peut envoyer : le nombre lu dans la ligne 'suivi' (clés présentes
// et filtre appliqué), ou null. `Synchro_Ids` d'une ligne 'suivi' vaut « nombre:somme ».
export function eligibleRows(syncRows, exportId, table) {
  const row = syncRows.find(r => r[EXPORT_COL] === exportId && r[TABLE_COL] === table && r[TYPE_COL] === KIND.track);
  const m = row ? /^(\d+):[0-9a-f]+$/.exec(String(row[LIST_COL] || '')) : null;
  return m ? Number(m[1]) : null;
}

// Lignes que peut envoyer chaque table de chaque export : { export: { table: nombre } }, lues dans les lignes
// 'suivi' (voir eligibleRows). Les tables sans suivi lisible n'y sont pas.
export function trackedCounts(syncRows) {
  const counts = {};
  for (const row of syncRows) {
    const m = row[TYPE_COL] === KIND.track ? /^(\d+):[0-9a-f]+$/.exec(String(row[LIST_COL] || '')) : null;
    if (m) (counts[row[EXPORT_COL]] ||= {})[row[TABLE_COL]] = Number(m[1]);
  }
  return counts;
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
