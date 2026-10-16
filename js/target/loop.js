// CIBLE : la recopie, tant qu'un éditeur a la page du widget ouverte. Toutes les 10 secondes, le
// widget demande à Grist quelles tables ont changé (voir due) ; si un journal ou une destination a
// changé, et au moins une fois par minute, chaque journal est déplié, recopié dans ses
// destinations, puis nettoyé. Le résultat de chaque passage est gardé ici pour l'onglet.
import { EXPORT_COL, KEY_COL, KIND, LIST_COL, RESEND_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, randomHex } from '../logic/common.js';
import { exchangeColumns, exportTables } from '../logic/exports.js';
import { awaitingPartner, expandRows, isRaw, nextGaps, planPull, planPurge, planUnpack, recentChanges, rowsByTable, sentColumns, touchedTables } from '../logic/journal.js';
import { addedColumns, copyColumns, destRefs, droppedColumns, followRenames, manualEdits, newColumnsMap, planConsolidation, restoreActions, rowNumbers } from '../logic/consolidation.js';
import { apply, docChanges, docIdentity, fetchRows, gristFetch, readSchema, withLock } from '../grist.js';
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
// Une destination dont le journal n'a pas changé n'est relue, pour y voir les retouches faites à la
// main, que si Grist dit qu'elle a changé (voir due), au retour sur la page, sur « Synchroniser »,
// et au plus tard au bout de 5 minutes.
const REREAD_MS = 300000;
const DRIFT_KEPT = 20;

// Ce que l'onglet montre. `results` : dernier passage par journal ({ at, rows, gaps } ; { at,
// error, text } en cas d'erreur) et par table reçue (clé `journal|table` : { at, text, table,
// stats, recent, dest, copyCols, labelCol, labelCols, types, drift, droppedCols, driftCount,
// driftGone }, ou { at, error, text }). `drift` : les premières lignes retouchées à la main
// (DRIFT_KEPT), `droppedCols` : les colonnes reçues effacées ici ([colonne du journal, d'ici]),
// `driftCount` : le nombre de retouches en tout (cellules, lignes et colonnes effacées),
// `driftGone` : celui des lignes effacées. `offers` : tables proposées par
// journal ([{ table, columns, n }]). `readOnly` : le document refuse l'écriture (lecteur).
// `lastVisit` : date de la visite précédente sur ce document (secondes), ou 0.
export const state = { results: new Map(), offers: new Map(), readOnly: false, viewer: false, lastVisit: null };
export const tableKey = (journal, table) => `${journal}|${table}`;
// Refus de Grist faute de droits (lecteur) : le widget passe en lecture seule.
export const isAccessError = e => /access|denied|blocked|permission/i.test(e.message);

let busy = false;
let lastArrival = Date.now(); // dernière arrivée dans un journal (ou retour sur la page)
let lastPass = 0; // début du dernier passage
// Coup d'œil sur le document (voir due) : son état au coup d'œil précédent (`hash`), les journaux
// et destinations du dernier passage (`tables`), un journal en lien public (`pull`) ; `compare`
// passe à faux si Grist refuse.
const watch = { hash: '', tables: new Set(), pull: false, compare: true };
let onChange = async () => {}; // l'onglet, redessiné quand un passage a changé quelque chose
const inflow = new Map(); // journal -> { ids, at } : lignes reçues vues au passage précédent
const settled = new Map(); // `journal|table` -> { signature, at } : journal déjà recopié sans effet
const lastRead = new Map(); // `journal|table` -> { numbers, drift } : numéros de ligne et retouches, à la dernière lecture
const pulled = new Map(); // journal -> empreintes des instantanés publics déjà lus

export function startAutoConsolidation(render) {
  onChange = render;
  const tick = async () => {
    if (document.visibilityState === 'visible' && await due()) await consolidateAll();
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    lastArrival = Date.now();
    consolidateAll({ reread: true });
  });
}

// Un passage est-il dû ? Grist dit quelles tables ont changé depuis le coup d'œil précédent
// (docChanges) : un journal où des lignes sont arrivées, une destination retouchée à la main (elle
// est alors relue), ou le schéma. Sinon un passage par minute suffit (retouche que la comparaison
// n'aurait pas dite). Un lien public, que rien ne signale ici, et le cas où Grist refuse la
// comparaison (droits) gardent le rythme d'avant : toutes les POLL_MS tant que des lignes
// arrivent, puis toutes les minutes.
async function due() {
  if (busy) return false; // un passage en cours : le coup d'œil attend le suivant
  const elapsed = Date.now() - lastPass;
  const steady = elapsed >= (Date.now() - lastArrival > IDLE_MS ? IDLE_MS : POLL_MS);
  if (watch.compare) {
    const changes = await docChanges(watch.hash).catch(() => ({ hash: watch.hash, tables: null }));
    if (changes) {
      const touched = changes.hash === watch.hash ? [] : touchedTables(changes.tables, watch.tables);
      watch.hash = changes.hash;
      if (touched === null) settled.clear();
      else for (const [key, was] of settled) if (touched.includes(was.dest)) settled.delete(key);
      return elapsed >= IDLE_MS || touched === null || touched.length > 0 || (watch.pull && steady);
    }
    watch.compare = false;
  }
  return steady;
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
  for (const map of [settled, lastRead]) for (const key of [...map.keys()]) if (key.startsWith(`${journal}|`)) map.delete(key);
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
// jamais une colonne de la destination qui porte déjà son nom (elle prend un nom libre) ; elle
// est notée pour l'historique (`addedCols`).
function receivedColumns(entry, tableRows, schema, allowed) {
  let sent = sentColumns(tableRows, entry.columns || []);
  let next = entry;
  if (allowed) {
    const kept = exchangeColumns(sent, allowed, entry.map);
    sent = kept.sent;
    next = { ...entry, map: kept.map };
  }
  const map = newColumnsMap(next, destColumns(sent), schema.columns(next.dest).map(c => c.colId));
  return { sent, entry: map ? { ...next, map, addedCols: addedColumns(next, map, Math.floor(Date.now() / 1000)) } : next };
}

// Recopie d'une table dans sa destination (une colonne nouvelle y est d'abord ajoutée ; une colonne
// effacée ici ne l'est pas, elle est notée). Rend l'entrée à jour (destination renommée,
// correspondance, colonnes effacées), les compteurs, les colonnes recopiées et leurs types, les
// numéros de ligne et les retouches faites à la main (lus après la recopie).
async function copyTable(ctx, noted) {
  const { journal, groups, exchange, swap, allowedFor } = ctx;
  let entry = followRenames(noted, ctx.schema);
  if (!ctx.schema.has(entry.dest)) return { entry, error: t('error.destMissing', { dest: entry.dest }) };
  const tableRows = groups.get(entry.table) || [];
  const received = receivedColumns(entry, tableRows, ctx.schema, allowedFor(entry.dest));
  // Échange : une colonne effacée est recréée, comme avant (la destination repart vers l'autre document).
  const dropped = exchange ? [] : droppedColumns(received.entry, received.sent, ctx.schema.columns(received.entry.dest).map(c => c.colId));
  const kept = received.sent.filter(c => !dropped.some(([from]) => from === c.id));
  const added = addDestColumnsActions(ctx.schema, received.entry.dest, kept, received.entry.map);
  if (added.length) {
    await apply(added);
    ctx.schema = await readSchema();
  }
  entry = { ...received.entry, refs: destRefs(ctx.schema, received.entry.dest), dropped: dropped.length ? dropped.map(([, to]) => to) : undefined };
  const copyCols = copyColumns(received.sent.map(c => ({ colId: c.id })), ctx.schema.columns(entry.dest), entry.map);
  const types = Object.fromEntries(received.sent.map(c => [c.id, c.type]));
  // La destination n'est relue que si le journal de cette table a changé depuis le dernier
  // passage resté sans effet, ou pour y revoir les retouches (REREAD_MS).
  const key = tableKey(journal, entry.table);
  const signature = JSON.stringify([tableRows.map(r => r.id), copyCols, entry.match || '', entry.dest]);
  const was = settled.get(key);
  if (was && was.signature === signature && Date.now() - was.at < REREAD_MS && lastRead.has(key)) {
    return { entry, stats: { added: 0, updated: 0, removed: 0 }, copyCols, types, dropped, ...lastRead.get(key) };
  }
  const destRows = await fetchRows(entry.dest);
  const { actions, stats, gone } = planConsolidation({
    journalRows: tableRows, destRows, copyCols, destTable: entry.dest, journalTable: journal, matchCol: entry.match || '', exchange,
  });
  // Échange : la ligne 'echange' de l'export est touchée dans le même lot (voir syncFormulas) :
  // les lignes reçues ne repartent pas vers l'autre document.
  const written = stats.added + stats.updated + stats.removed > 0;
  await apply(swap && written ? [['UpdateRecord', SYNC_TABLE, swap.id, { [RESEND_COL]: randomHex(4) }], ...actions] : actions);
  if (actions.length) settled.delete(key);
  else settled.set(key, { signature, at: Date.now(), dest: entry.dest });
  const after = written ? await fetchRows(entry.dest) : destRows;
  lastRead.set(key, { numbers: rowNumbers(after), drift: manualEdits({ journalRows: tableRows, destRows: after, copyCols, exchange, except: gone }) });
  return { entry, stats, copyCols, types, dropped, ...lastRead.get(key) };
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
  const noted = ({ dest, map, match, refs, dropped, addedCols }) => JSON.parse(JSON.stringify({ dest, map, match, refs, dropped, addedCols }));
  const tables = note.tables.map(tb => (updates.has(tb.table) ? { ...tb, dropped: undefined, ...noted(updates.get(tb.table)) } : tb));
  await updateJournalNote(journal, n => ({ ...n, tables }));
  if (note.mode === 'echange' && !note.retour) await wireExchange({ ...note, tables });
}

// Retouches gardées pour la carte : les premières lignes, nommées, les colonnes effacées et les comptes.
const driftResult = (drift, labelCol, droppedCols) => ({
  drift: drift.slice(0, DRIFT_KEPT).map(({ n, row, cells, gone }) => ({ n, label: labelCol ? String(row[labelCol] ?? '') : '', cells, ...(gone ? { gone } : {}) })),
  droppedCols,
  driftCount: drift.reduce((sum, d) => sum + (d.gone ? 1 : d.cells.length), 0) + droppedCols.length,
  driftGone: drift.filter(d => d.gone).length,
});

// Ce que la carte montre d'une table : compteurs, colonne qui nomme les lignes, historique (dont
// les colonnes ajoutées par la SOURCE, `added`), valeurs retouchées à la main (`drift`).
function tableResult({ entry, stats, copyCols, types, numbers, drift, dropped, error }, groups) {
  if (error) return { table: entry.table, error };
  const labelCol = copyCols.some(([from]) => from === entry.label) ? entry.label : (copyCols[0] || [])[0];
  const recent = recentChanges(groups.get(entry.table) || [], labelCol, state.lastVisit, Infinity, { copyCols, numbers });
  const added = (entry.addedCols || []).filter(a => a.at > (state.lastVisit || 0));
  return { table: entry.table, stats, dest: entry.dest, copyCols, labelCol, labelCols: copyCols.map(([c]) => c), types, recent, added, ...driftResult(drift, labelCol, dropped) };
}

// « Corriger » : une table reçue reprend l'état exact de la SOURCE (la dernière version reçue de
// chaque ligne), relu au moment du clic : les colonnes effacées ici sont recréées, les lignes
// effacées reviennent, les cellules retouchées reprennent leur valeur. La carte suit aussitôt.
export async function restoreSource(journal, table) {
  const key = tableKey(journal, table);
  const result = state.results.get(key);
  if (!result || !result.copyCols) return;
  const { dest, labelCol, types = {}, droppedCols = [] } = result;
  const copyCols = [...result.copyCols, ...droppedCols];
  await withLock('gristsync-consolidation', async () => {
    if (droppedCols.length) {
      const columns = droppedCols.map(([from]) => ({ id: from, type: types[from] || 'Any', label: from }));
      await apply(addDestColumnsActions(await readSchema(), dest, columns, Object.fromEntries(droppedCols)));
      await updateJournalNote(journal, n => ({ ...n, tables: n.tables.map(tb => (tb.table === table ? { ...tb, dropped: undefined } : tb)) }));
    }
    const journalRows = rowsByTable(expandRows(await fetchRows(journal))).get(table) || [];
    await apply(restoreActions(manualEdits({ journalRows, destRows: await fetchRows(dest), copyCols }), dest, copyCols));
    const after = await fetchRows(dest);
    const drift = manualEdits({ journalRows, destRows: after, copyCols });
    lastRead.set(key, { numbers: rowNumbers(after), drift });
    state.results.set(key, { ...state.results.get(key), copyCols, ...driftResult(drift, labelCol, []) });
  });
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
    changed ||= Boolean(tb.error) !== Boolean(was && was.error) || Boolean(tb.stats && tb.stats.added + tb.stats.updated + tb.stats.removed)
      || JSON.stringify([(was && was.drift) || [], (was && was.driftCount) || 0]) !== JSON.stringify([tb.drift || [], tb.driftCount || 0]);
  }
  return changed;
}

async function passAll() {
  let changed = false;
  lastPass = Date.now();
  let schema = await readSchema();
  let upgraded = false;
  for (const { journal } of receivedJournals(schema)) upgraded = (await upgradeJournal(schema, journal)) || upgraded;
  if (upgraded) schema = await readSchema();
  watch.tables = new Set(receivedJournals(schema).flatMap(r => [r.journal, ...r.note.tables.map(tb => tb.dest)]));
  watch.pull = receivedJournals(schema).some(r => r.note.mode === 'public');
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
// null si un passage était déjà en cours. `reread` : relire toutes les destinations.
export async function consolidateAll({ reread = false } = {}) {
  if (busy) return null;
  busy = true;
  if (reread) settled.clear();
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
