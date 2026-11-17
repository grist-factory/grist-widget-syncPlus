// SOURCE : renvois de lignes et de listes des clés, et rattrapage automatique tant qu'un
// propriétaire a la page du widget ouverte. Rien n'est modifié dans les tables : le widget écrit
// les lignes voulues dans Synchro_Renvoi et Grist recalcule le lot.
import { EXPORT_COL, KIND, LIST_COL, LOT_COL, MISSING_COL, RESEND_ALL, RESEND_COL, STATE_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, chunk, nowS, randomHex, sleep } from '../logic/common.js';
import { hookStatus, swapExports, tooLarge } from '../logic/exports.js';
import { ownsSync } from '../logic/strays.js';
import { parseList, parseLot } from '../logic/journal.js';
import {
  RESEND_CHUNK, addProg, addSpent, announceRest, budgetWait, chargeBusy, chunkCount, chunkMark, dueRows, eligibleRows, listRequest, lotCut, nextChunkSize, parseCharge,
  resendValue, rowsSince, startProg, trackState, trackedCounts,
} from '../logic/resend.js';
import { exportFlow } from '../logic/health.js';
import { rowDrops } from '../logic/notes.js';
import { apply, clearWebhookQueue, fetchRows, listWebhooks, page, prefs, readSchema, selectRows, withLock } from '../port.js';
import { chargeRow, isCharge, readHooks, readSourceNote, recordEvent, syncRows, watchRows, writeSync } from './synchro.js';
import { planFiles, sendFiles } from './files.js';
import { pauseDeadLinks } from './pausing.js';
import { noteError } from '../errors.js';

// Rythmes : file d'envoi relue (60 fois au plus, rapprochées au début : un envoi met en général
// moins d'une seconde) ; rattrapage toutes les 10 s, la minute quand l'onglet est caché ; file
// bloquée par un envoi trop gros vidée au plus une fois en 10 minutes ; signe de vie d'un renvoi
// toutes les 20 s ; attente du budget par pas de 30 s au plus. Un document sans table Synchro (qui
// ne fait que recevoir) n'est relu qu'à ce dernier rythme (HIDDEN_MS).
const QUEUE_READS = 60;
const QUEUE_FIRST_MS = 500;
const QUEUE_MS = 1500;
const CATCHUP_MS = 10000;
const HIDDEN_MS = 60000;
const REPAIR_MS = 600000;
const BEAT_S = 20;
const WAIT_STEP_S = 30;

async function waitForQueue(hookIds) {
  for (let i = 0; i < QUEUE_READS; i++) {
    const hooks = (await listWebhooks()).filter(h => hookIds.includes(h.id));
    if (hooks.some(tooLarge)) throw new Error('tooLarge');
    if (!hooks.some(h => h.usage && h.usage.numWaiting)) return;
    await beat();
    await sleep(i < 3 ? QUEUE_FIRST_MS : QUEUE_MS);
  }
  throw new Error('queueStuck');
}

// Vide la file de Grist (commune au document) et marque à renvoyer en entier les lots des exports
// servis : le rattrapage les renvoie ensuite.
export async function clearAndMark() {
  await clearWebhookQueue();
  const [rows, hooks] = await Promise.all([syncRows(), readHooks()]);
  const served = rows.filter(r => r[TYPE_COL] === KIND.lot && hooks.of(r[EXPORT_COL]).some(h => h.fields.enabled));
  await writeSync(served.map(r => r.id), { [MISSING_COL]: RESEND_ALL });
  for (const id of new Set(served.map(r => r[EXPORT_COL]))) await recordEvent(id, 'unblock');
}

// ---------------------------------------------------------------------------------------------
// Renvoi des tables d'un export depuis `since` (secondes ; RESEND_ALL : toutes les lignes), par
// tranches, puis de leur liste complète des clés (voir sendList). La tranche suivante attend que
// les destinataires aient tout reçu (un envoi reste sous la limite de taille de Grist) ; une
// tranche trop grosse pour un lot est coupée en deux. Le renvoi est reprenable : la marque du lot
// (MISSING_COL, voir chunkMark) est posée avant la première tranche et avance avec chacune ; une
// page fermée en cours de route, le rattrapage reprend à la prochaine ouverture. Une marque déjà
// plus ancienne l'emporte. Rend le nombre de lignes renvoyées. Un renvoi à la fois, tous onglets
// confondus, et un seul par document (voir withCharge) : si une autre page renvoie déjà, les lots
// sont seulement marqués, et le rattrapage les enverra ensuite (rend alors null). `progress`, s'il est
// donné, reçoit l'avancement à chaque tranche (l'état d'envoi, voir exportFlow ; null pour l'effacer) : le
// moteur ne dessine rien. Un renvoi est noté dans l'historique de l'export (`kind` : 'resend', ou 'catchup'
// pour le rattrapage automatique).
const startOf = (lot, since) => (lot[MISSING_COL] > 0 ? Math.min(lot[MISSING_COL], since) : since);
const lotsOf = async (exportId, tables) => (await syncRows()).filter(r => r[EXPORT_COL] === exportId && tables.includes(r[TABLE_COL]) && r[TYPE_COL] === KIND.lot);

export function resendTables(exportId, tables, progress, since = RESEND_ALL) {
  return withLock('gristsync-resend', async () => {
    try {
      return await withCharge(() => resendLocked(exportId, tables, progress, since), progress);
    } catch (e) {
      if (e.message !== 'resendBusy') throw e;
      for (const lot of await lotsOf(exportId, tables)) await writeSync([lot.id], { [MISSING_COL]: startOf(lot, since) });
      return null;
    }
  });
}

async function resendLocked(exportId, tables, progress, since, kind = 'resend') {
  const hookIds = (await readHooks()).of(exportId).filter(h => h.fields.enabled).map(h => h.id);
  if (!hookIds.length) return 0;
  const plans = await markLots(exportId, tables, since);
  const total = plans.reduce((n, p) => n + p.total, 0);
  charge.state = { ...charge.state, prog: startProg(exportId, total, plans.reduce((n, p) => n + chunkCount(p.rows.length), 0), nowS()) };
  let sentRows = 0;
  for (const plan of plans) {
    charge.state.prog.table = plan.table;
    sentRows += await sendRows(plan, hookIds, ({ rows, bytes }) => {
      charge.state = { ...charge.state, prog: addProg(charge.state.prog, { rows, bytes, now: nowS() }) };
      showProgress(progress);
    });
    // Un Échange n'efface rien d'après les listes des clés : inutile de l'envoyer.
    if (!swapExports(await syncRows()).has(exportId)) await sendList(exportId, plan.table, hookIds);
  }
  charge.state = { ...charge.state, prog: null };
  if (progress) progress(null);
  if (sentRows) await recordEvent(exportId, kind, { n: sentRows });
  return sentRows;
}

// L'avancement donné à `progress` (la fenêtre d'un assistant le dessine), dit comme sur la carte de
// l'export.
function showProgress(progress) {
  if (!progress || !charge || !charge.state.prog) return;
  const prog = charge.state.prog;
  progress(exportFlow({ exportId: prog.exp, owed: 1, recipients: ['active'], charge: { ...charge.state, le: nowS() }, page: pageName(), now: nowS() }));
}

// Marque de chaque lot posée avant tout envoi, et lignes à renvoyer. Une table retirée ou
// introuvable est passée : la carte le dit.
async function markLots(exportId, tables, since) {
  const schema = await readSchema();
  const plans = [];
  for (const lot of await lotsOf(exportId, tables)) {
    if (!schema.has(lot[TABLE_COL])) continue;
    const start = startOf(lot, since);
    await writeSync([lot.id], { [MISSING_COL]: start });
    const tableRows = await fetchRows(lot[TABLE_COL]);
    const rows = rowsSince(tableRows, start);
    // Lignes qui peuvent partir : celles du suivi (clé présente, filtre appliqué) pour toute la table.
    const allEligible = eligibleRows(await syncRows(), exportId, lot[TABLE_COL]);
    const eligible = start <= RESEND_ALL ? allEligible : null;
    // Part des lignes de la table qui partent vraiment (voir announceRest) ; 1 si le suivi ne le dit pas.
    const ratio = allEligible !== null && tableRows.length ? allEligible / tableRows.length : 1;
    plans.push({ table: lot[TABLE_COL], lot: lot.id, start, rows, total: eligible ?? rows.length, ratio });
  }
  return plans;
}

// Lignes d'une table, tranche par tranche. Une table sans ligne à renvoyer part quand même en lot
// de renvoi (vide) : la CIBLE remet à zéro son compte de lignes non arrivées. La marque est
// effacée à part à la fin : écrite avec le lot ordinaire, elle cacherait un nouvel envoi coupé.
async function sendRows({ lot, start, rows, ratio = 1 }, hookIds, onSent) {
  let size = RESEND_CHUNK;
  let sentRows = 0;
  const queue = rows.length ? chunk(rows, size) : [[]];
  while (queue.length) {
    const part = queue.shift();
    await waitForQueue(hookIds);
    // Chaque tranche annonce à la CIBLE ce qui reste à venir : une page fermée en cours de route ne
    // la laisse plus « À jour » avec une table à moitié reçue.
    const rest = announceRest(queue.reduce((n, p) => n + p.length, 0), ratio);
    await writeSync([lot], { [RESEND_COL]: resendValue(randomHex(4), part.map(r => r.id), rest), [MISSING_COL]: part.length ? chunkMark(part, start) : start });
    const cell = String(((await fetchRows(SYNC_TABLE)).find(r => r.id === lot) || {})[LOT_COL] || '');
    const bytes = cell.length * hookIds.length;
    await spend(bytes);
    const sent = parseLot(cell);
    // Lot coupé : il est parti pour rien ; les tranches qui suivent sont plus petites (au lieu de
    // couper chacune en deux), et celle-ci est refaite en tranches de cette taille.
    const cut = lotCut(sent) && part.length > 1;
    if (cut) {
      size = nextChunkSize(size, part.length, sent.lines.length);
      queue.unshift(...chunk(part, size));
    }
    const counted = cut || !sent ? 0 : sent.lines.length;
    sentRows += counted;
    onSent({ rows: counted, bytes });
  }
  await waitForQueue(hookIds);
  await writeSync([lot], { [MISSING_COL]: 0 });
  await writeSync([lot], { [RESEND_COL]: '' });
  return sentRows;
}

// Liste complète des clés d'une table, en morceaux, chacun quand le précédent est parti : la CIBLE
// efface les clés absentes une fois tous les morceaux arrivés. Ses lignes sont déjà là : c'est
// elle qui fait partir les suppressions qu'une liste des clés parties n'a pas portées (file vidée,
// pause, trop de clés parties d'un coup). La demande du morceau reste dans la ligne 'cles' jusqu'à
// la fin : une page fermée en cours de route, le rattrapage recommence.
async function sendList(exportId, table, hookIds) {
  const mine = async kind => (await fetchRows(SYNC_TABLE)).find(r => r[EXPORT_COL] === exportId && r[TABLE_COL] === table && r[TYPE_COL] === kind);
  const [keys, track] = [await mine(KIND.keys), await mine(KIND.track)];
  if (!keys) return;
  const overdue = trackState(track).trop;
  const mark = randomHex(4);
  for (let n = 1, after = ''; track; n++) {
    await waitForQueue(hookIds);
    await writeSync([keys.id], { [RESEND_COL]: listRequest(mark, n, after) });
    const cell = String((await mine(KIND.keys))[LIST_COL] || '');
    await spend(cell.length * hookIds.length);
    const { part } = parseList(cell) || {};
    if (!part || part.last || !part.keys.length) break;
    after = part.keys[part.keys.length - 1];
  }
  await waitForQueue(hookIds);
  await writeSync([keys.id], { [RESEND_COL]: '' });
  if (overdue) await writeSync([track.id], { [RESEND_COL]: overdue });
}

// ---------------------------------------------------------------------------------------------
// Rattrapage, tant qu'un propriétaire a la page du widget ouverte : à l'affichage, puis toutes les
// 10 secondes (la minute quand l'onglet est caché), un onglet à la fois.
//  - Envoi refusé pour sa taille (413 : plus de 1 Mo, quand Grist regroupe des envois qui ont
//    attendu) : Grist le retenterait sans fin et la file resterait bloquée. Le widget la vide, et
//    marque à renvoyer en entier chaque export qui a un destinataire actif. Pas plus d'une fois en
//    10 minutes.
//  - Lot marqué (envoi coupé, renvoi interrompu, file vidée) : ses lignes depuis la marque
//    repartent, puis la liste complète. Liste demandée (renvoi de la liste interrompu, trop de clés
//    parties d'un coup) : la liste complète repart. Export sans destinataire : marque et demande
//    effacées (un destinataire ajouté reçoit tout). Destinataires tous en pause : marque gardée
//    pour après la reprise. File bloquée par un autre échec (lien de réception mort) : rien ne part
//    tant que la carte le signale, renvoyer ne ferait qu'attendre.
//  - Pièces jointes : les fichiers que les destinataires n'ont pas encore partent (voir files.js).
// `onDone` est appelé quand quelque chose est parti.
let catching = false;
let notOwner = false;
let repairedAt = 0;
let caughtAt = 0;
// Dernier passage du rattrapage de cette page et ce qu'il a trouvé (`why` : 'idle' rien à renvoyer,
// 'sent' il a renvoyé, 'blocked' un destinataire est en erreur, 'busy' une autre page renvoie,
// 'nosync' pas de table Synchro) : la carte d'un export dit pourquoi rien ne part.
const lastPass = { at: 0, why: '' };
export const catchState = () => ({ at: lastPass.at, why: lastPass.why, running: catching });

export async function catchUp(onDone = () => {}) {
  if (catching || notOwner) return;
  catching = true;
  caughtAt = Date.now();
  lastPass.at = caughtAt;
  try {
    const sent = await withLock('gristsync-resend', catchUpLocked);
    if (sent || shrunk) {
      shrunk = false;
      await onDone();
    }
  } catch (e) {
    if (e.message === 'ownerOnly') notOwner = true;
    else if (e.message === 'resendBusy') lastPass.why = 'busy';
    else {
      console.warn(e);
      noteError(e);
    }
  } finally {
    catching = false;
  }
}

export function startAutoCatchUp(onDone) {
  prefs.write('browser', browser());
  // Page fermée en plein renvoi : elle rend la main si Grist reçoit encore son écriture (sinon une
  // autre page de ce navigateur la reprend aussitôt, une autre personne après LEASE_S secondes).
  page.onLeave(() => {
    if (charge) apply([['UpdateRecord', SYNC_TABLE, charge.id, { [RESEND_COL]: JSON.stringify({ ...charge.state, par: '', reprise: 0 }) }]]).catch(() => {});
  });
  setInterval(() => {
    if (page.visible() || Date.now() - caughtAt > HIDDEN_MS) catchUp(onDone);
  }, CATCHUP_MS);
}

async function catchUpLocked() {
  let rows = await lightRows();
  if (!rows) {
    lastPass.why = 'nosync';
    return 0;
  }
  let { hooks, conditions, of: recipients } = await readHooks();
  // Un lien de réception mort bloque la file de tout le document : le widget met ce destinataire en pause.
  if (await pauseDeadLinks(hooks, conditions)) ({ hooks, conditions, of: recipients } = await readHooks());
  await watchShrink(recipients).catch(console.warn);
  if (hooks.some(tooLarge) && Date.now() - repairedAt > REPAIR_MS) {
    repairedAt = Date.now();
    await clearAndMark();
    rows = await lightRows();
  }
  if (hooks.some(h => h.fields.enabled && !tooLarge(h) && hookStatus(h)[0] === 'error')) {
    lastPass.why = 'blocked';
    return 0;
  }
  const { late, lists } = dueRows(rows);
  const files = rows.some(r => r[TYPE_COL] === KIND.files) ? await planFiles(hooks, conditions, h => h.fields.enabled && hookStatus(h)[0] !== 'error') : [];
  lastPass.why = 'idle';
  if (!late.length && !lists.length && !files.length) return 0;
  const active = row => recipients(row[EXPORT_COL]).filter(h => h.fields.enabled).map(h => h.id);
  let sent = 0;
  await withCharge(async () => {
    for (const row of late) {
      if (!recipients(row[EXPORT_COL]).length) await writeSync([row.id], { [MISSING_COL]: 0 });
      else if (active(row).length) await resendLocked(row[EXPORT_COL], [row[TABLE_COL]], null, row[MISSING_COL], 'catchup');
    }
    for (const row of lists) {
      if (!recipients(row[EXPORT_COL]).length) await writeSync([row.id], { [RESEND_COL]: row[TYPE_COL] === KIND.keys ? '' : trackState(row).trop });
      else if (active(row).length) await sendList(row[EXPORT_COL], row[TABLE_COL], active(row));
    }
    sent = await sendFiles(files, spend);
  });
  lastPass.why = 'sent';
  return late.length + lists.length + sent + files.length;
}

// Lignes qui quittent un export (la CIBLE est passive, la SOURCE est prévenue, voir watchRows) : à chaque passage,
// un relevé léger des comptes de suivi (une requête, quelques octets par table) ; la note n'est lue que si un compte a
// changé, et au plus toutes les WATCH_MS. `shrunk` : un avertissement est noté, la carte se redessine.
const WATCH_MS = 30000;
let watched = ''; // derniers comptes traités (JSON)
let watchedAt = 0;
let lastCounts = {}; // comptes du passage précédent : une baisse d'un passage à l'autre passe sans attendre WATCH_MS
let shrunk = false;
async function watchShrink(recipients) {
  const rows = await selectRows(SYNC_TABLE, [EXPORT_COL, TABLE_COL, TYPE_COL, LIST_COL], { [TYPE_COL]: KIND.track });
  if (!rows) return;
  const counts = trackedCounts(rows);
  const seen = JSON.stringify(counts);
  const falling = Object.entries(counts).some(([id, tables]) => rowDrops(lastCounts[id] || {}, tables).length);
  lastCounts = counts;
  if (seen === watched || (!falling && Date.now() - watchedAt < WATCH_MS)) return;
  watched = seen;
  watchedAt = Date.now();
  const note = readSourceNote(await readSchema());
  if (await watchRows(note, counts, id => recipients(id).length)) shrunk = true;
}

// Lignes de Synchro utiles au rattrapage, sans les lots ni les listes (de grosses cellules), car
// lues toutes les 10 secondes. Null sans la table.
let noSyncAt = 0;
async function lightRows() {
  if (Date.now() - noSyncAt < HIDDEN_MS) return null;
  const rows = await selectRows(SYNC_TABLE, [EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, STATE_COL]);
  if (rows) return rows.filter(r => !isCharge(r));
  if (ownsSync(await readSchema())) return syncRows();
  noSyncAt = Date.now();
  return null;
}

// ---------------------------------------------------------------------------------------------
// Renvois ménagés (voir parseCharge) : la ligne 'charge' de Synchro dit quelle page renvoie et ce
// qui est parti ces dix dernières minutes. Une page qui dépasse le budget attend, en donnant signe
// de vie ; une autre page (autre personne, autre navigateur) ne lance rien pendant ce temps.
// Lus au premier usage, pas à l'import : le port n'est branché qu'après.
let browserId = null;
let pageId = null;
const browser = () => (browserId ||= prefs.read('browser') || randomHex(4));
const pageName = () => (pageId ||= `${browser()}.${randomHex(4)}`);
let charge = null; // { id, state, saved, progress } pendant un renvoi de cette page

async function readCharge() {
  const rows = await selectRows(SYNC_TABLE, [TYPE_COL, RESEND_COL]);
  return (rows && rows.find(isCharge)) || chargeRow();
}

async function withCharge(fn, progress = null) {
  const row = await readCharge();
  const state = parseCharge(row[RESEND_COL]);
  if (chargeBusy(state, pageName(), nowS())) throw new Error('resendBusy');
  charge = { id: row.id, state: { ...state, par: pageName(), reprise: 0, prog: null }, saved: 0, progress };
  await saveCharge();
  try {
    const result = await fn();
    charge.state = { ...charge.state, prog: null };
    return result;
  } finally {
    charge.state = { ...charge.state, par: '', reprise: 0 };
    await saveCharge().catch(() => {});
    charge = null;
  }
}

// Écrit l'état, avec un signe de vie. Une autre page qui aurait pris la main entre-temps (deux
// renvois lancés au même instant) la garde : celle-ci s'arrête, ses marques restent pour le
// rattrapage.
async function saveCharge() {
  const current = parseCharge((await readCharge())[RESEND_COL]);
  if (charge.state.par && chargeBusy(current, pageName(), nowS())) throw new Error('resendBusy');
  if (!charge.state.par && current.par && current.par !== pageName()) return;
  charge.state.le = nowS();
  charge.saved = nowS();
  await writeSync([charge.id], { [RESEND_COL]: JSON.stringify(charge.state) });
}

// Signe de vie pendant une longue attente (file d'envoi, budget).
async function beat() {
  if (charge && nowS() - charge.saved > BEAT_S) await saveCharge();
}

// Octets partis (une copie par destinataire). Au-delà du budget, attendre que la fenêtre se vide.
async function spend(bytes) {
  charge.state = addSpent(charge.state, nowS(), bytes);
  const wait = budgetWait(charge.state, nowS());
  if (wait > 0) {
    charge.state.reprise = nowS() + wait;
    await saveCharge();
    showProgress(charge.progress);
    while (nowS() < charge.state.reprise) {
      await sleep(Math.min(WAIT_STEP_S, charge.state.reprise - nowS()) * 1000);
      await saveCharge();
    }
    charge.state.reprise = 0;
  }
  await beat();
}

// État des renvois du document, le plus récent : celui de cette page quand elle renvoie, sinon la
// ligne 'charge' de Synchro.
export async function currentCharge() {
  if (charge) return { ...charge.state, le: nowS() };
  return parseCharge((await readCharge())[RESEND_COL]);
}

// Où en est un export (voir exportFlow) vu de cette page. `exp` : { id, owed, recipients }.
export function flowOf(exp, state) {
  return exportFlow({
    exportId: exp.id, owed: exp.owed, recipients: exp.recipients.map(h => hookStatus(h)[0]), charge: state, page: pageName(), now: nowS(), lastPass,
  });
}
