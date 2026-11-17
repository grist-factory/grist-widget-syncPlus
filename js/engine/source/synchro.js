// SOURCE : la seule table technique du widget, Synchro, quel que soit le nombre d'exports et de
// tables. Chaque table d'un export y a sa liste des clés, son lot de lignes modifiées et son suivi
// des clés (voir logic/formulas.js) ; une ligne 'charge' suit les renvois du document. Les exports
// (nom, lien public), les invitations en attente (et l'empreinte de leur secret) et les pauses sont
// notés dans la description de sa colonne Synchro_Export : des métadonnées, que le webhook
// n'envoie pas. Synchro n'a pas de page : elle reste dans « Données source ».
import {
  EXPORT_COL, KIND, LIST_COL, LOT_COL, SIG_KEY, RECALC_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TRACK_COL, TYPE_COL, columnNote, noteAction, nowS, pool, randomHex,
} from '../logic/common.js';
import { cleanLabel } from '../logic/codes.js';
import { RECALC_SPEC, majleAction, prepareSourceActions, syncColumns, syncFormulas } from '../logic/formulas.js';
import { endNotice, exportRowsActions, exportTables, hooksOf, optionsActions } from '../logic/exports.js';
import { filterColumns } from '../logic/filters.js';
import { docFormatOf } from '../logic/docformat.js';
import { keptKeys, readKeys, signText } from '../logic/trust.js';
import { foreignSync, ownsSync, strayColumns } from '../logic/strays.js';
import { addEvent, docNameOf, dropDest, identifyHooks, isMemoToken, observeRows, putDest, setDocName, staleDest } from '../logic/notes.js';
import { apply, docIdentity, fetchRows, listWebhooks, readSchema, renameWebhook, webhookConditions, withLock } from '../port.js';
import { dropPages, isOnPage, removeTechnicalTables } from '../pages.js';
import { moveNotes } from '../note-move.js';

const SORT_COL = 'manualSort'; // colonne d'ordre que Grist donne à toute table (voir ensureSyncTable)

// Lignes de Synchro des exports ([] sans la table), sans la ligne 'charge'. `schema` : instantané
// déjà lu, s'il y en a un.
export const isCharge = row => row[TYPE_COL] === KIND.load;
export const syncRows = async (schema = null) => (ownsSync(schema || await readSchema()) ? (await fetchRows(SYNC_TABLE)).filter(r => !isCharge(r)) : []);

// Webhooks du document et leurs conditions (propriétaires seulement) ; `of(id)` : les
// destinataires d'un export (voir hooksOf). Le mémo de chaque webhook est la fiche du destinataire (voir identifyHooks).
export async function readHooks() {
  const [hooks, conditions, schema] = await Promise.all([listWebhooks(), webhookConditions(), readSchema()]);
  const known = identifyHooks(hooks, readSourceNote(schema));
  return { hooks: known, conditions, of: id => hooksOf(known, conditions, id) };
}

// Les webhooks du document avec la fiche de leur destinataire en guise de mémo, pour un écran qui a déjà lu `note`.
export const identified = (hooks, note) => identifyHooks(hooks, note);

// Range la fiche d'un destinataire (« e-mail · document · équipe/nom », voir hookMemo) dans la note et rend le jeton à mettre
// dans le mémo de son webhook : Grist montre les mémos à toute personne qui lit le document, lien public compris. À appeler
// AVANT de créer le webhook.
export async function rememberDest(memo) {
  const token = `r-${randomHex(6)}`;
  await updateSourceNote(note => putDest(note, token, memo, nowS()));
  return token;
}

// Délai avant qu'un jeton sans webhook soit retiré de la note (le temps de créer le webhook qui le porte).
const DEST_GRACE_S = 600;

// Met les fiches des destinataires à l'abri (propriétaires, une fois par affichage) : les webhooks dont le mémo est encore la
// fiche elle-même (créés par une version d'avant la 4.0 du moteur) prennent un jeton, la fiche rejoignant la note ; les
// fiches de destinataires partis sont retirées de la note. Rend vrai si un mémo a changé. Une erreur d'un webhook (supprimé
// entre-temps) ne coupe pas les autres.
export const protectMemos = () => withLock('gristsync-memos', async () => {
  const schema = await readSchema();
  if (!ownsSync(schema)) return false;
  let hooks;
  try { hooks = await listWebhooks(); } catch (e) { if (e.message === 'ownerOnly') return false; throw e; }
  const mine = hooks.filter(h => h.fields.tableId === SYNC_TABLE);
  const legacy = mine.filter(h => h.fields.memo && !isMemoToken(h.fields.memo));
  const tokens = new Map(legacy.map(h => [h.id, `r-${randomHex(6)}`]));
  const live = new Set(hooks.map(h => h.fields.memo));
  await updateSourceNote((note) => {
    const kept = tokens.size ? legacy.reduce((acc, h) => putDest(acc, tokens.get(h.id), h.fields.memo, nowS()), note) : note;
    return dropDest(kept, staleDest(kept, live, nowS(), DEST_GRACE_S));
  });
  let changed = false;
  await pool(legacy, 6, async (h) => {
    try {
      await renameWebhook(h.id, h.fields.name, tokens.get(h.id));
      changed = true;
    } catch (e) {
      console.warn(e);
    }
  });
  return changed;
});
export const exportHooks = async exportId => (await readHooks()).of(exportId);

// Ligne 'charge' de Synchro (voir parseCharge), créée au premier renvoi.
export async function chargeRow() {
  const row = (await fetchRows(SYNC_TABLE)).find(isCharge);
  if (row) return row;
  const fields = { [TYPE_COL]: KIND.load, [EXPORT_COL]: '', [TABLE_COL]: '', [SCHEMA_COL]: '', [RESEND_COL]: '' };
  return { ...fields, id: (await apply([['AddRecord', SYNC_TABLE, null, fields]])).retValues[0] };
}

// Note de la table Synchro, dans la description de Synchro_Export : forme et opérations dans
// logic/notes.js.
const exportColumn = schema => (schema.columns(SYNC_TABLE) || []).find(c => c.colId === EXPORT_COL);

export const readSourceNote = schema => ({ exports: [], invitations: [], pauses: [], ...columnNote(exportColumn(schema)) });

// Relit la note, la change (`change` rend la nouvelle note, voir logic/notes.js) et l'écrit. Une
// seule lecture-modification-écriture à la fois entre les onglets du navigateur (le rattrapage, une
// action et l'historique écrivent tous dans cette note : la dernière écriture ferait perdre l'autre).
// Une note que `change` rend telle quelle n'est pas réécrite.
export const updateSourceNote = change => withLock('gristsync-source-note', async () => {
  const schema = await readSchema();
  const column = exportColumn(schema);
  if (!column) return;
  const note = readSourceNote(schema);
  const next = change(note);
  if (next !== note) await apply([noteAction(column, next)]);
});

// Nom que la personne a donné à ce document, pour les invitations (voir setDocName) : le widget ne peut pas le lire
// lui-même. `rememberDocName('')` l'efface.
export const sourceDocName = async () => docNameOf(readSourceNote(await readSchema()));
export const rememberDocName = name => updateSourceNote(note => (docNameOf(note) === cleanLabel(name) ? note : setDocName(note, name)));

// Ce que l'invitation dit du document SOURCE : qui l'envoie, son identifiant, son équipe (la CIBLE en refait
// l'adresse du document, voir docUrl) et le nom saisi, s'il y en a un. `identity` : docIdentity().
export async function sourceFrom(email, { docId, team }) {
  const docName = await sourceDocName();
  return { email, docId, team, ...(docName ? { docName } : {}) };
}

// Événement d'envoi noté pour l'historique de l'export (voir addEvent) ; un échec de la note ne
// fait jamais échouer l'action qu'il raconte.
export const recordEvent = (exportId, kind, fields = {}) => updateSourceNote(note => addEvent(note, exportId, { at: nowS(), kind, ...fields })).catch(console.warn);

// Lignes des tables de chaque export (`counts` : { export: { table: nombre } }, voir trackedCounts) comparées à la
// dernière observation de la note : une baisse au-delà du seuil y laisse son événement `shrink`, que la carte de
// l'export montre (voir observeRows). `recipients(export)` : combien de personnes reçoivent cet export ; un
// Échange ne prévient pas (ses suppressions passent par la case Supprime), un export public compte un
// destinataire. `note` : celle déjà lue, pour ne rien écrire quand rien n'a changé. Rend vrai si la note a changé.
export async function watchRows(note, counts, recipients) {
  const now = nowS();
  const observed = Object.entries(counts).map(([id, n]) => ({ id, entry: note.exports.find(e => e.id === id), counts: n }))
    .filter(o => o.entry)
    .map(o => ({ ...o, warn: !o.entry.echange && !o.entry.retour && recipients(o.id) + (o.entry.public ? 1 : 0) > 0 }));
  const observe = base => observed.reduce((next, o) => observeRows(next, o.id, o.counts, now, o.warn) || next, base);
  if (observe(note) === note) return false;
  await updateSourceNote(observe).catch(console.warn);
  return true;
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
// renvoi (dépendances posées après coup : Grist les refuse à la création), et les formules
// sont celles de cette version, pour les tables de `rows` (lignes de Synchro, ou à venir ; lues
// ici si absentes). `schema` : déjà lu par l'appelant. Synchro n'a pas de colonne manualSort : le
// webhook l'enverrait, et chaque ligne reçue se placerait au même rang dans le journal ; au bout d'une
// cinquantaine d'envois en attente (page de la CIBLE fermée), Grist renumérote les lignes voisines,
// ce que la clé du formulaire n'a pas le droit de faire (403), et la file se bloque (vérifié). Rend
// vrai si quelque chose a changé.
export async function ensureSyncTable(schema = null, rows = null) {
  schema ||= await readSchema();
  if (!ownsSync(schema)) return false;
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
  const moved = await moveNotes(schema);
  return missing.length > 0 || sorted || depsChanged || formulasChanged || moved;
}

// Retire de Synchro des colonnes qui ne sont pas au widget (voir strayColumns) ; `ids` : leurs
// noms. Seules celles qui sont encore là et que le widget ne gère pas partent : un nom de colonne
// du widget, ou déjà retiré par un autre onglet, est laissé.
export async function removeStrayColumns(ids) {
  const schema = await readSchema();
  const stray = new Set(strayColumns(schema.columns(SYNC_TABLE) || []).map(c => c.id));
  await apply(ids.filter(id => stray.has(id)).map(id => ['RemoveColumn', SYNC_TABLE, id]));
}

// Rend son nom à Synchro : la table de ce nom qui n'est pas celle du widget (voir foreignSync) est
// renommée `name`. Grist garde ses colonnes, ses valeurs et ses formules (les formules et les règles
// qui la nomment suivent), et le widget crée alors la sienne au premier export.
export async function renameForeignSync(name) {
  const schema = await readSchema();
  if (!foreignSync(schema)) return;
  if (schema.resolve(name)) throw new Error('tableNameTaken');
  await apply([['RenameTable', SYNC_TABLE, name]]);
}

// Listes de choix et formats changés dans les tables des exports (voir optionsActions). Rend vrai
// si quelque chose a changé.
export async function refreshOptions(schema, rows) {
  const sends = key => rows.some(r => String(r[SCHEMA_COL] || '').includes(key));
  // Un export qui envoie sa mise en forme (colonnes `fmt`) dit aussi la langue et la monnaie du document ; un qui
  // envoie la description de sa table (`tdesc`) la tient de la section de données brutes de la table.
  const doc = sends('"fmt":true') ? docFormatOf(await fetchRows('_grist_DocInfo')) : null;
  // un qui envoie la mise en page de ses colonnes (`pos`, voir layout.js) la tient de la section de la page de la table.
  const laidOut = sends('"pos":');
  const sections = sends('"tdesc"') || laidOut ? await fetchRows('_grist_Views_section') : null;
  const fields = laidOut ? await fetchRows('_grist_Views_section_field') : null;
  const actions = optionsActions(rows, schema, doc, sections, fields);
  await apply(actions);
  return actions.length > 0;
}

// MajLe de chaque table envoyée suit les colonnes que ses exports envoient (voir majleAction), et
// la table a sa colonne RecalculLe. `schema` et `rows` (lignes de Synchro) : déjà lus par
// l'appelant, sinon lus ici. Rend vrai si quelque chose a changé.
export async function refreshMajLe(schema = null, rows = null) {
  schema ||= await readSchema();
  rows ||= await syncRows(schema);
  const sent = new Map(); // table -> colonnes envoyées par l'un de ses exports
  for (const id of new Set(rows.map(r => r[EXPORT_COL]))) {
    // Une colonne de filtre compte aussi : une ligne qui entre dans le filtre doit partir.
    for (const { table, columns, filter } of exportTables(rows, id)) {
      sent.set(table, new Set([...(sent.get(table) || []), ...columns.map(c => c.id), ...filterColumns(filter)]));
    }
  }
  const tables = [...sent].filter(([table]) => schema.has(table));
  // RecalculLe (repère des annulations) remise en état si elle manque ou a été changée à la main.
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

// Crée la table Synchro quand elle manque (sans page ; vide si `tables`, les noms des tables à envoyer, l'est).
// Rend vrai si elle vient d'être créée. Une table du même nom qui n'est pas la nôtre n'est pas touchée.
export async function createSyncTable(tables = [], schema = null) {
  if ((schema || await readSchema()).has(SYNC_TABLE)) return false;
  // manualSort part avec la création, dans la même action : sinon deux onglets (l'écran qui s'affiche et l'assistant qui crée l'export)
  // la retireraient chacun de leur côté, et le second se verrait répondre « No such column: Synchro.manualSort » (vu à l'e2e).
  await apply([['AddTable', SYNC_TABLE, syncColumns(tables)], ['RemoveColumn', SYNC_TABLE, SORT_COL]]);
  await dropPages([SYNC_TABLE]);
  return true;
}

// Enregistre les tables et colonnes d'un export (`tables` : [{ table, columns }]). Crée la table
// Synchro au premier export (voir protectSync : ses règles d'accès sont posées avant, par l'écran). Rend les tables dont les lignes sont à envoyer (nouvelles ou aux
// colonnes changées). `swap` : export en Échange (voir exportRowsActions).
export async function saveExport(exportId, tables, { isPublic = false, swap = false } = {}) {
  const schema = await readSchema();
  // Une table nommée Synchro qui n'est pas la nôtre n'est pas reprise (voir foreignSync).
  if (foreignSync(schema)) throw new Error('syncTableForeign');
  await createSyncTable(tables.map(tb => tb.table), schema);
  const before = await fetchRows(SYNC_TABLE);
  const { actions, changed } = exportRowsActions(before, exportId, tables, { isPublic, swap });
  // Les formules d'abord quand une table s'ajoute (elles doivent pouvoir la lire), après quand une
  // table s'en va (elles ne la lisent plus quand ses lignes disparaissent).
  const all = [...before.filter(r => r[EXPORT_COL] !== exportId), ...tables.map(tb => ({ [TABLE_COL]: tb.table }))];
  await ensureSyncTable(null, [...before, ...all]);
  await apply(actions);
  await refreshFormulas(await readSchema(), all);
  await refreshMajLe();
  return changed;
}

// Efface les lignes d'un export ; la table Synchro disparaît avec le dernier export.
export async function removeExport(exportId) {
  const rows = await syncRows();
  const left = rows.filter(r => r[EXPORT_COL] !== exportId);
  // La table disparaît avec le dernier export, sauf si une page la montre (le widget posé sur elle).
  if (!left.length && !(await isOnPage(SYNC_TABLE))) {
    await removeTechnicalTables([SYNC_TABLE]);
    return;
  }
  await apply([['BulkRemoveRecord', SYNC_TABLE, rows.filter(r => r[EXPORT_COL] === exportId).map(r => r.id)]]);
  await refreshFormulas(await readSchema(), left);
}

// Clés qui signent les envois d'un export, une par destinataire (ligne 'signature' de Synchro,
// réservée aux propriétaires : { webhook : clé }, voir readKeys). Les formules signent pour chacune
// dès qu'elle est là (voir formulas.js). `change` rend les nouvelles clés ; rien n'est écrit si
// elles n'ont pas changé (sinon tous les lots de l'export seraient recalculés et renvoyés).
async function updateKeys(exportId, change) {
  const row = (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.sign);
  const before = readKeys(row ? row[SCHEMA_COL] : '');
  const after = change(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  const value = JSON.stringify(after);
  await apply([row ? ['UpdateRecord', SYNC_TABLE, row.id, { [SCHEMA_COL]: value }]
    : ['AddRecord', SYNC_TABLE, null, { [EXPORT_COL]: exportId, [TABLE_COL]: '', [TYPE_COL]: KIND.sign, [SCHEMA_COL]: value, [RESEND_COL]: '' }]]);
}

// Clé d'un destinataire, rangée sous `label` (l'invitation, le temps de créer son webhook, puis le
// webhook) ; `was` : l'étiquette qu'elle remplace.
export async function putRecipientKey(exportId, label, key, was = '') {
  if (!SIG_KEY.test(key || '')) throw new Error('codeInvalid');
  await updateKeys(exportId, (keys) => {
    const rest = Object.fromEntries(Object.entries(keys).filter(([k]) => k !== was));
    return { ...rest, [label]: key };
  });
}

// Seule clé d'un export : celle de l'envoi de retour d'un Échange, côté CIBLE (un seul webhook).
export async function setOnlyKey(exportId, label, key) {
  if (!SIG_KEY.test(key || '')) throw new Error('codeInvalid');
  await updateKeys(exportId, () => ({ [label]: key }));
}

// Clés des destinataires partis effacées (voir keptKeys) : un webhook révoqué ne reçoit plus de
// lot signé pour lui, et une ancienne clé ne signe plus rien.
export async function pruneKeys(exportId) {
  const [hooks, schema] = await Promise.all([exportHooks(exportId), readSchema()]);
  const pending = readSourceNote(schema).invitations.filter(inv => inv.export === exportId).map(inv => inv.id);
  await updateKeys(exportId, keys => keptKeys(keys, hooks.map(h => h.id), pending));
}

// Avis de fin d'un export pour le webhook `hookId` (voir endNotice), signé avec la clé de ce
// destinataire. Une clé illisible (réseau) arrête l'action en cours : un avis non signé serait
// rejeté par la CIBLE, qui ne saurait jamais la fin.
export async function endRows(exportId, hookId) {
  const row = (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.sign);
  const keys = readKeys(row ? row[SCHEMA_COL] : '');
  const key = keys[hookId] || keys['*'];
  const rows = endNotice(exportId);
  return key ? Promise.all(rows.map(async r => ({ ...r, [LOT_COL]: await signText(key, r, '{"fin": true}') }))) : rows;
}

// Écrit les mêmes champs dans des lignes de Synchro (renvoi, marque d'envoi coupé).
export const writeSync = (ids, fields) => apply(ids.length
  ? [['BulkUpdateRecord', SYNC_TABLE, ids, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, ids.map(() => v)]))]] : []);
