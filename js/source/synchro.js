// SOURCE : la seule table technique du widget, Synchro, quel que soit le nombre d'exports et de
// tables. Chaque table d'un export y a sa liste des clés, son lot de lignes modifiées et son suivi
// des clés (voir logic/formulas.js) ; une ligne 'charge' suit les renvois du document. Les exports
// (nom, lien public), les invitations en attente (et l'empreinte de leur secret) et les pauses sont
// notés dans la description de sa colonne Synchro_Export : des métadonnées, que le webhook
// n'envoie pas. Synchro n'a pas de page : elle reste dans « Données source ».
import {
  EXPORT_COL, KEY_COL, KIND, LIST_COL, LOT_COL, RECALC_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TRACK_COL, TYPE_COL,
} from '../logic/common.js';
import { RECALC_SPEC, majleAction, prepareSourceActions, syncColumns, syncFormulas } from '../logic/formulas.js';
import { addTrackRowsAction, exportRowsActions, exportTables } from '../logic/exports.js';
import { apply, fetchRows, readSchema } from '../grist.js';
import { dropPages, exportsViewRef, removeTechnicalTables } from '../pages.js';

const SORT_COL = 'manualSort'; // colonne d'ordre que Grist donne à toute table (voir ensureSyncTable)

// Lignes de Synchro des exports ([] sans la table), sans la ligne 'charge'. `schema` : instantané
// déjà lu, s'il y en a un.
export const isCharge = row => row[TYPE_COL] === KIND.load;
export const syncRows = async (schema = null) => ((schema || await readSchema()).has(SYNC_TABLE) ? (await fetchRows(SYNC_TABLE)).filter(r => !isCharge(r)) : []);

// Ligne 'charge' de Synchro (voir parseCharge), créée au premier renvoi.
export async function chargeRow() {
  const row = (await fetchRows(SYNC_TABLE)).find(isCharge);
  if (row) return row;
  const fields = { [TYPE_COL]: KIND.load, [EXPORT_COL]: '', [TABLE_COL]: '', [SCHEMA_COL]: '', [RESEND_COL]: '' };
  return { ...fields, id: (await apply([['AddRecord', SYNC_TABLE, null, fields]])).retValues[0] };
}

// Note de la table Synchro : { exports: [{ id, name, at, public }], invitations: [{ id, export,
// hash, at }], pauses: [{ hook, export, at, columns }] }.
const exportColumn = schema => (schema.columns(SYNC_TABLE) || []).find(c => c.colId === EXPORT_COL);

export function readSourceNote(schema) {
  let note = null;
  try { note = JSON.parse((exportColumn(schema) || {}).description || 'null'); } catch (e) { /* note illisible */ }
  return { exports: [], invitations: [], pauses: [], ...(note && typeof note === 'object' ? note : {}) };
}

async function writeSourceNote(note) {
  const column = exportColumn(await readSchema());
  if (column) await apply([['UpdateRecord', '_grist_Tables_column', column.id, { description: JSON.stringify(note) }]]);
}

// Relit la note, la change (`change` la modifie en place) et l'écrit.
export async function updateSourceNote(change) {
  const note = readSourceNote(await readSchema());
  change(note);
  await writeSourceNote(note);
}

// Les formules de Synchro nomment les tables qu'elles lisent : réécrites quand l'ensemble change.
// Une table renommée ou effacée dans la SOURCE n'y figure plus (la carte de l'export le signale) :
// son nom inconnu mettrait en erreur les lignes de tous les exports.
async function refreshFormulas(schema, rows) {
  const { keys, lot, state } = syncFormulas(rows.map(r => r[TABLE_COL]).filter(table => schema.has(table)));
  const cols = schema.columns(SYNC_TABLE);
  const actions = [[LIST_COL, keys], [LOT_COL, lot], [TRACK_COL, state]]
    .filter(([colId, formula]) => (cols.find(c => c.colId === colId) || {}).formula !== formula)
    .map(([colId, formula]) => ['ModifyColumn', SYNC_TABLE, colId, { formula }]);
  await apply(actions);
  return actions.length > 0;
}

// Table Synchro à jour : une colonne ajoutée par une version suivante du widget est créée, la
// colonne de suivi (marque d'envoi coupé des lots, suivi des clés, heure de la dernière
// consolidation d'un Échange) accepte du texte et surveille le lot, la liste et la demande de
// renvoi (dépendances posées après coup : Grist les refuse à la création), les formules
// sont celles de cette version, pour les tables de `rows` (lignes de Synchro, ou à venir), et
// chaque table d'un export a son suivi des clés. Synchro n'a pas de colonne manualSort : le webhook
// l'enverrait, et chaque ligne reçue se placerait au même rang dans le journal ; au bout d'une
// cinquantaine d'envois en attente (page de la CIBLE fermée), Grist renumérote les lignes voisines,
// ce que la clé du formulaire n'a pas le droit de faire (403), et la file se bloque (vérifié). Rend
// vrai si quelque chose a changé.
export async function ensureSyncTable(rows = null) {
  let schema = await readSchema();
  if (!schema.has(SYNC_TABLE)) return false;
  const have = new Set(schema.columns(SYNC_TABLE).map(c => c.colId));
  const missing = syncColumns([]).filter(c => !have.has(c.id));
  const sorted = have.has(SORT_COL);
  if (missing.length || sorted) {
    await apply([...missing.map(({ id, ...info }) => ['AddColumn', SYNC_TABLE, id, info]), ...(sorted ? [['RemoveColumn', SYNC_TABLE, SORT_COL]] : [])]);
    schema = await readSchema();
  }
  const cols = schema.columns(SYNC_TABLE);
  const watch = cols.find(c => c.colId === TRACK_COL);
  const deps = ['L', ...[LOT_COL, LIST_COL, RESEND_COL].map(id => cols.find(c => c.colId === id).id)];
  const depsChanged = JSON.stringify(watch.recalcDeps || null) !== JSON.stringify(deps) || watch.type !== 'Any';
  if (watch.type !== 'Any') await apply([['ModifyColumn', SYNC_TABLE, TRACK_COL, { type: 'Any' }]]);
  if (depsChanged) await apply([['UpdateRecord', '_grist_Tables_column', watch.id, { recalcWhen: 0, recalcDeps: deps }]]);
  const formulasChanged = await refreshFormulas(schema, rows || await syncRows(schema));
  const track = addTrackRowsAction(await fetchRows(SYNC_TABLE));
  if (track) await apply([track]);
  return missing.length > 0 || sorted || depsChanged || formulasChanged || Boolean(track);
}

// MajLe de chaque table envoyée suit les colonnes que ses exports envoient (voir majleAction), et
// la table a sa colonne RecalculLe. Rend vrai si quelque chose a changé.
export async function refreshMajLe() {
  const schema = await readSchema();
  const rows = await syncRows(schema);
  const sent = new Map(); // table -> colonnes envoyées par l'un de ses exports
  for (const id of new Set(rows.map(r => r[EXPORT_COL]))) {
    // Une colonne de filtre compte aussi : une ligne qui entre dans le filtre doit partir.
    for (const { table, columns, filter } of exportTables(rows, id)) {
      sent.set(table, new Set([...(sent.get(table) || []), ...columns.map(c => c.id), ...(filter ? [filter.id] : [])]));
    }
  }
  const tables = [...sent].filter(([table]) => schema.has(table));
  // RecalculLe (repère des annulations) manque aux tables exportées avant la version 0.4.3, et
  // était une date avant la version 0.5.
  const recalc = table => schema.columns(table).find(c => c.colId === RECALC_COL);
  const actions = [
    ...tables.flatMap(([table]) => (recalc(table) ? [] : prepareSourceActions(table, [RECALC_COL]))),
    ...tables.filter(([table]) => recalc(table) && (recalc(table).type !== RECALC_SPEC.type || recalc(table).formula !== RECALC_SPEC.formula))
      .map(([table]) => ['ModifyColumn', table, RECALC_COL, RECALC_SPEC]),
    ...tables.map(([table, ids]) => majleAction(schema.columns(table), [...ids])).filter(Boolean),
  ];
  await apply(actions);
  return actions.length > 0;
}

// Enregistre les tables et colonnes d'un export (`tables` : [{ table, columns }]). Crée la table
// Synchro au premier export. Rend les tables dont les lignes sont à envoyer (nouvelles ou aux
// colonnes changées). `swap` : export en Échange (voir exportRowsActions).
export async function saveExport(exportId, tables, { isPublic = false, swap = false } = {}) {
  if (!(await readSchema()).has(SYNC_TABLE)) {
    await apply([['AddTable', SYNC_TABLE, syncColumns(tables.map(tb => tb.table))]]);
    await dropPages([SYNC_TABLE]);
  }
  const before = await fetchRows(SYNC_TABLE);
  const { actions, changed } = exportRowsActions(before, exportId, tables, { isPublic, swap });
  // Les formules d'abord quand une table s'ajoute (elles doivent pouvoir la lire), après quand une
  // table s'en va (elles ne la lisent plus quand ses lignes disparaissent).
  const all = [...before.filter(r => r[EXPORT_COL] !== exportId), ...tables.map(tb => ({ [TABLE_COL]: tb.table }))];
  await ensureSyncTable([...before, ...all]);
  await apply(actions);
  await refreshFormulas(await readSchema(), all);
  await refreshMajLe();
  return changed;
}

// Efface les lignes d'un export ; la table Synchro disparaît avec le dernier export.
export async function removeExport(exportId) {
  const rows = await syncRows();
  const left = rows.filter(r => r[EXPORT_COL] !== exportId);
  if (!left.length) {
    await removeTechnicalTables([SYNC_TABLE]);
    return;
  }
  await apply([['BulkRemoveRecord', SYNC_TABLE, rows.filter(r => r[EXPORT_COL] === exportId).map(r => r.id)]]);
  await refreshFormulas(await readSchema(), left);
}

// Écrit les mêmes champs dans des lignes de Synchro (renvoi, marque d'envoi coupé).
export const writeSync = (ids, fields) => apply(ids.length
  ? [['BulkUpdateRecord', SYNC_TABLE, ids, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, ids.map(() => v)]))]] : []);

// Montage d'avant la version 0.4 : une vue d'export et une table liste par table envoyée, et la
// page Synchro_Exports. Ces tables sont reconnues à leur nom et à leur colonne Synchro_Ids.
export const legacyTables = schema => [
  ...schema.tableIds.filter(id => id.startsWith('Synchro_') && (schema.columns(id) || []).some(c => c.colId === LIST_COL && c.isFormula)),
  ...schema.tableIds.map(id => `${id}_summary_${KEY_COL}`).filter(id => schema.has(id)),
];

export async function removeLegacy(schema) {
  await removeTechnicalTables(legacyTables(schema));
  const page = await exportsViewRef();
  if (page) await apply([['RemoveView', page]]);
}
