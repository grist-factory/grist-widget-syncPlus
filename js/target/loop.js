// CIBLE : la recopie, tant qu'un éditeur a la page du widget ouverte. Toutes les 10 secondes (la
// minute quand rien n'est arrivé depuis une minute), chaque journal est déplié, recopié dans ses
// destinations, puis nettoyé. Le résultat de chaque passage est gardé ici pour l'onglet.
import { EXPORT_COL, KEY_COL, KIND, LIST_COL, RESEND_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, randomHex } from '../logic/common.js';
import { exchangeColumns, exportTables } from '../logic/exports.js';
import { awaitingPartner, expandRows, isRaw, nextGaps, planPull, planPurge, planUnpack, recentChanges, rowsByTable, sentColumns } from '../logic/journal.js';
import { copyColumns, destRefs, followRenames, newColumnsMap, planConsolidation } from '../logic/consolidation.js';
import { apply, docIdentity, fetchRows, gristFetch, readSchema, withLock } from '../grist.js';
import { addDestColumnsActions, destColumns, receivedJournals, updateJournalNote, upgradeJournal } from './journals.js';
import { syncRows } from '../source/synchro.js';
import { wireExchange } from '../exchange.js';
import { errorText } from '../ui.js';
import { t } from '../i18n.js';
import { readPref, writePref } from '../prefs.js';

const POLL_MS = 10000;
const IDLE_MS = 60000;
// Lignes reçues dépliées par passage, au plus ; au-delà de FLOOD_PER_MIN lignes reçues par minute,
// l'arrivée est anormale (le webhook n'en dépose que quelques-unes) : la carte le signale.
const RAW_BATCH = 500;
const FLOOD_PER_MIN = 600;

// Ce que l'onglet montre. `results` : dernier passage par journal ({ at, rows, gaps } ; { at,
// error, text } en cas d'erreur) et par table reçue (clé `journal|table` : { at, text, table,
// stats, recent, labelCol, labelCols }, ou { at, error, text }). `offers` : tables proposées par
// journal ([{ table, columns, n }]). `readOnly` : le document refuse l'écriture (lecteur).
// `lastVisit` : date de la visite précédente sur ce document (secondes), ou 0.
export const state = { results: new Map(), offers: new Map(), readOnly: false, viewer: false, lastVisit: null };
export const tableKey = (journal, table) => `${journal}|${table}`;
// Refus de Grist faute de droits (lecteur) : le widget passe en lecture seule.
export const isAccessError = e => /access|denied|blocked|permission/i.test(e.message);

let busy = false;
let lastArrival = Date.now(); // dernière arrivée dans un journal (ou retour sur la page)
let onChange = async () => {}; // l'onglet, redessiné quand un passage a changé quelque chose
const inflow = new Map(); // journal -> { ids, at } : lignes reçues vues au passage précédent
const settled = new Map(); // `journal|table` -> lignes du journal déjà recopiées sans effet
const pulled = new Map(); // journal -> empreintes des instantanés publics déjà lus

export function startAutoConsolidation(render) {
  onChange = render;
  const tick = async () => {
    if (document.visibilityState === 'visible') await consolidateAll();
    setTimeout(tick, Date.now() - lastArrival > IDLE_MS ? IDLE_MS : POLL_MS);
  };
  setTimeout(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    lastArrival = Date.now();
    consolidateAll();
  });
}

// Date de la visite précédente, retenue par navigateur et par document : la seule chose que le
// widget garde hors de Grist pour l'historique (aucune donnée des tables).
async function readLastVisit() {
  if (state.lastVisit !== null) return;
  const key = `visit.${(await docIdentity()).docId}`;
  state.lastVisit = Number(readPref(key)) || 0;
  writePref(key, String(Math.floor(Date.now() / 1000)));
}

// Oublie ce qui est gardé d'un journal (réception arrêtée).
export function forgetJournal(journal) {
  for (const key of [...state.results.keys()]) if (key === journal || key.startsWith(`${journal}|`)) state.results.delete(key);
  state.offers.delete(journal);
}

// ---------------------------------------------------------------------------------------------
// Un passage sur un journal

// Lien public : lit les instantanés de l'export dans la table Synchro de la SOURCE, sans
// identifiant, et ajoute au journal ce qui a changé, comme l'aurait fait un webhook. Les
// instantanés ne sont relus que si leur empreinte (taille et CRC-32, une petite ligne à part) a
// changé depuis la dernière lecture de cette page. Rend vrai si quelque chose est arrivé.
async function pull(note, journal) {
  const read = async (kind) => {
    const filter = encodeURIComponent(JSON.stringify({ [EXPORT_COL]: [note.export], [TYPE_COL]: [kind] }));
    const response = await gristFetch(`${note.base}/tables/${SYNC_TABLE}/records?filter=${filter}`).catch(() => null);
    if (!response || !response.ok) throw new Error('publicClosed');
    return (await response.json()).records || [];
  };
  // Une SOURCE d'avant la version 0.5 n'a pas d'empreinte : l'instantané est relu à chaque fois.
  const marks = await read(KIND.mark);
  const seen = JSON.stringify(marks.map(r => [r.fields[TABLE_COL], r.fields[LIST_COL]]).sort());
  if (marks.length && pulled.get(journal) === seen) return false;
  const { actions, tooBig } = planPull({ records: await read(KIND.full), journalRows: await fetchRows(journal), journalTable: journal });
  await apply(actions);
  if (JSON.stringify(tooBig) !== JSON.stringify(note.tooBig || [])) await updateJournalNote(journal, n => ({ ...n, tooBig }));
  pulled.set(journal, seen);
  return actions.length > 0;
}

// Arrivée anormale : plus de FLOOD_PER_MIN lignes reçues par minute depuis le passage précédent.
// Le premier passage d'un chargement ne peut pas le dire (on ne sait pas depuis quand elles sont là).
function flooded(journal, raw) {
  const at = Date.now() / 1000;
  const was = inflow.get(journal);
  inflow.set(journal, { ids: new Set(raw.map(r => r.id)), at });
  if (!was) return false;
  return raw.filter(r => !was.ids.has(r.id)).length > FLOOD_PER_MIN * Math.max(1, (at - was.at) / 60);
}

function nextSuspect(was = {}, rejected, flood) {
  const at = Math.floor(Date.now() / 1000);
  return { n: (was.n || 0) + rejected, at, ...(flood ? { flood: at } : was.flood ? { flood: was.flood } : {}) };
}

// Déplie ce qui est arrivé, et note dans le journal ce qui manque encore, les arrivées suspectes
// (lignes rejetées, flot anormal) et la fin de l'envoi annoncée par la SOURCE (`ended`, heure ;
// effacée si des données arrivent ensuite). Rend la note à jour, les lignes du journal, et s'il
// reste des lignes reçues pour le passage suivant.
async function unpack(journal, note) {
  let rows = await fetchRows(journal);
  const flood = flooded(journal, rows.filter(isRaw));
  const plan = planUnpack(rows, journal, { exportId: note.mode === 'public' ? null : note.export, max: RAW_BATCH });
  if (!plan.actions.length) return { note, rows, left: 0 };
  lastArrival = Date.now();
  await apply(plan.actions);
  const gaps = nextGaps(note, plan);
  if (plan.rejected || flood) gaps.suspect = nextSuspect(note.suspect, plan.rejected, flood);
  const ended = (plan.ended === undefined ? note.ended : plan.ended && (plan.ended.at || Math.floor(Date.now() / 1000))) || undefined;
  if (gaps.suspect || ended !== note.ended || JSON.stringify(gaps) !== JSON.stringify({ missing: note.missing || {}, big: note.big || {} })) {
    note = { ...note, ...gaps, ended };
    await updateJournalNote(journal, n => ({ ...n, ...gaps, ended }));
  }
  rows = await fetchRows(journal);
  return { note, rows, left: plan.left };
}

// Tables que la SOURCE a ajoutées à l'export, pas encore rangées ni refusées (`pending`), et
// celles qu'on peut déjà proposer (leurs colonnes sont connues).
function offersOf(groups, note) {
  const known = new Set(note.tables.map(tb => tb.table));
  const pending = [...groups.keys()].filter(table => !known.has(table) && !note.refused.includes(table));
  const offers = pending.map((table) => {
    const tableRows = groups.get(table);
    return { table, columns: sentColumns(tableRows, []), n: new Set(tableRows.map(r => r[KEY_COL]).filter(Boolean)).size };
  }).filter(o => o.columns.length);
  return { pending, offers };
}

// Colonnes reçues pour une table, et la correspondance. Échange, côté du document qui a invité
// (`allowed` : colonnes que son export envoie pour cette destination) : l'autre document n'écrit
// que celles-là (voir exchangeColumns). Une colonne ajoutée à l'export après coup ne remplace
// jamais une colonne de la destination qui porte déjà son nom (elle prend un nom libre).
function receivedColumns(entry, tableRows, schema, allowed) {
  let sent = sentColumns(tableRows, entry.columns || []);
  let next = entry;
  if (allowed) {
    const kept = exchangeColumns(sent, allowed, entry.map);
    sent = kept.sent;
    next = { ...entry, map: kept.map };
  }
  const map = newColumnsMap(next, destColumns(sent), schema.columns(next.dest).map(c => c.colId));
  return { sent, entry: map ? { ...next, map } : next };
}

// Recopie d'une table dans sa destination (une colonne nouvelle y est d'abord ajoutée). Rend
// l'entrée à jour (destination renommée, correspondance), les compteurs et les colonnes recopiées.
async function copyTable(ctx, noted) {
  const { journal, groups, exchange, swap, allowedFor } = ctx;
  let entry = followRenames(noted, ctx.schema);
  if (!ctx.schema.has(entry.dest)) return { entry, error: t('error.destMissing', { dest: entry.dest }) };
  const tableRows = groups.get(entry.table) || [];
  const received = receivedColumns(entry, tableRows, ctx.schema, allowedFor(entry.dest));
  const added = addDestColumnsActions(ctx.schema, received.entry.dest, received.sent, received.entry.map);
  if (added.length) {
    await apply(added);
    ctx.schema = await readSchema();
  }
  entry = { ...received.entry, refs: destRefs(ctx.schema, received.entry.dest) };
  const copyCols = copyColumns(received.sent.map(c => ({ colId: c.id })), ctx.schema.columns(entry.dest), entry.map);
  // La destination n'est relue que si le journal de cette table a changé depuis le dernier
  // passage resté sans effet (une retouche dans la destination n'appelle rien).
  const key = tableKey(journal, entry.table);
  const signature = JSON.stringify([tableRows.map(r => r.id), copyCols, entry.match || '', entry.dest]);
  if (settled.get(key) === signature) return { entry, stats: { added: 0, updated: 0, removed: 0 }, copyCols };
  const { actions, stats } = planConsolidation({
    journalRows: tableRows, destRows: await fetchRows(entry.dest), copyCols, destTable: entry.dest, journalTable: journal, matchCol: entry.match || '', exchange,
  });
  // Échange : la ligne 'echange' de l'export est touchée dans le même lot (voir syncFormulas) :
  // les lignes reçues ne repartent pas vers l'autre document.
  const written = stats.added + stats.updated + stats.removed > 0;
  await apply(swap && written ? [['UpdateRecord', SYNC_TABLE, swap.id, { [RESEND_COL]: randomHex(4) }], ...actions] : actions);
  if (actions.length) settled.delete(key);
  else settled.set(key, signature);
  return { entry, stats, copyCols };
}

// Contexte de la recopie d'un journal. Échange : la ligne 'echange' de l'export et, côté du
// document qui a invité, les colonnes que son export envoie par table.
async function copyContext(schema, journal, note, groups) {
  const exchange = note.mode === 'echange';
  const rows = exchange ? await syncRows(schema) : [];
  const own = note.retour ? new Map(exportTables(rows, note.export).map(tb => [tb.table, new Set(tb.columns.map(c => c.id))])) : null;
  return {
    schema, journal, groups, exchange,
    swap: rows.find(r => r[EXPORT_COL] === note.export && r[TYPE_COL] === KIND.swap) || null,
    allowedFor: dest => (own ? own.get(dest) || new Set() : null),
  };
}

// Notes des tables changées (destination renommée, colonnes arrivées après coup). Échange, côté
// CIBLE : l'export de retour suit.
async function saveEntries(journal, note, updates) {
  if (!updates.size) return;
  const noted = ({ dest, map, match, refs }) => JSON.parse(JSON.stringify({ dest, map, match, refs }));
  const tables = note.tables.map(tb => (updates.has(tb.table) ? { ...tb, ...noted(updates.get(tb.table)) } : tb));
  await updateJournalNote(journal, n => ({ ...n, tables }));
  if (note.mode === 'echange' && !note.retour) await wireExchange({ ...note, tables });
}

// Ce que la carte montre d'une table : compteurs, colonne qui nomme les lignes, historique.
function tableResult({ entry, stats, copyCols, error }, groups) {
  if (error) return { table: entry.table, error };
  const labelCol = copyCols.some(([from]) => from === entry.label) ? entry.label : (copyCols[0] || [])[0];
  const recent = recentChanges(groups.get(entry.table) || [], labelCol, state.lastVisit, Infinity);
  return { table: entry.table, stats, labelCol, labelCols: copyCols.map(([c]) => c), recent };
}

// Un passage sur un journal : déplier, recopier chaque table rangée, noter les tables proposées,
// nettoyer. Chaque étape est un seul lot d'écritures, donc tout ou rien.
async function consolidate(schema, { journal, note: noteBefore }) {
  if (noteBefore.mode === 'public' && await pull(noteBefore, journal)) lastArrival = Date.now();
  const { note, rows, left } = await unpack(journal, noteBefore);
  const groups = rowsByTable(expandRows(rows));
  const { pending, offers } = offersOf(groups, note);
  state.offers.set(journal, offers);
  const ctx = await copyContext(schema, journal, note, groups);
  const tables = [];
  for (const noted of note.tables) {
    const done = await copyTable(ctx, noted);
    tables.push({ ...done, changed: !done.error && JSON.stringify(done.entry) !== JSON.stringify(noted) });
  }
  await saveEntries(journal, note, new Map(tables.filter(tb => tb.changed).map(tb => [tb.entry.table, tb.entry])));
  const after = await fetchRows(journal);
  await apply(planPurge(after, journal, { keep: pending, drop: note.refused }));
  // Lignes reçues laissées pour le passage suivant : il vient sans attendre la minute.
  if (left) lastArrival = Date.now();
  const afterGroups = rowsByTable(expandRows(after));
  return { rows: after.length, note, tables: tables.map(tb => tableResult(tb, afterGroups)) };
}

// ---------------------------------------------------------------------------------------------
// Un passage sur tous les journaux

const summary = s => (s.added || s.updated || s.removed ? t('recv.result', s) : t('recv.result.none'));

// Résultat d'un passage noté pour l'onglet ; rend vrai si la carte change.
function notePass(journal, pass, before, offersBefore, at) {
  // Ce que la carte montre du journal : lignes manquantes, trop grosses, arrivées suspectes, fin.
  const gaps = JSON.stringify([pass.note.missing, pass.note.big, pass.note.suspect, pass.note.ended]);
  state.results.set(journal, { at, rows: pass.rows, gaps });
  let changed = !before || Boolean(before.error) || !before.rows !== !pass.rows || before.gaps !== gaps || offersBefore !== JSON.stringify(state.offers.get(journal) || []);
  for (const tb of pass.tables) {
    const key = tableKey(journal, tb.table);
    const was = state.results.get(key);
    state.results.set(key, tb.error ? { at, error: true, text: tb.error } : { at, text: summary(tb.stats), ...tb });
    changed ||= Boolean(tb.error) !== Boolean(was && was.error) || Boolean(tb.stats && tb.stats.added + tb.stats.updated + tb.stats.removed);
  }
  return changed;
}

async function passAll() {
  let changed = false;
  let schema = await readSchema();
  let upgraded = false;
  for (const { journal } of receivedJournals(schema)) upgraded = (await upgradeJournal(schema, journal)) || upgraded;
  if (upgraded) schema = await readSchema();
  for (const received of receivedJournals(schema).filter(r => !awaitingPartner(r.note))) {
    const { journal } = received;
    const before = state.results.get(journal);
    const offersBefore = JSON.stringify(state.offers.get(journal) || []);
    const at = Date.now() / 1000;
    try {
      changed = notePass(journal, await consolidate(schema, received), before, offersBefore, at) || changed;
      state.readOnly = state.viewer;
      schema = await readSchema();
    } catch (e) {
      state.readOnly = state.viewer || isAccessError(e);
      state.results.set(journal, { ...before, at, text: errorText(e), error: true });
      changed ||= !(before && before.error);
    }
  }
  return changed;
}

// Un passage sur tous les journaux. Deux onglets du même navigateur ne recopient pas en même
// temps (verrou du navigateur) ; entre deux navigateurs, les écritures sont idempotentes.
// L'onglet n'est redessiné que si un passage a changé quelque chose. Rend vrai si c'est le cas,
// null si un passage était déjà en cours.
export async function consolidateAll() {
  if (busy) return null;
  busy = true;
  let changed = false;
  try {
    await readLastVisit();
    changed = await withLock('gristsync-consolidation', passAll);
  } catch (e) {
    // Document illisible (droits, réseau) : la boucle continue, le prochain passage réessaie.
    if (isAccessError(e)) state.readOnly = true;
    console.warn(e);
  } finally {
    busy = false;
  }
  if (changed) await onChange();
  return changed;
}
