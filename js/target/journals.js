// CIBLE : un journal par export reçu, Journal_<export>, où le webhook dépose les listes et les lots.
// Ce que la CIBLE a choisi (destinations, colonnes) est noté dans la description de sa colonne
// Synchro_Ids (voir awaitingPartner pour sa forme) ; la clé du formulaire peut la lire, mais pas
// l'écrire. Le journal n'a pas de page : seul son formulaire en a une (voir pages.js).
import {
  APPLIED_COL, AUTHOR_COL, BEFORE_COL, DATA_COL, DELETE_COL, JOURNAL_PREFIX, KEY_COL, LIST_COL, MISSING_COL, ORDER_COL, RECEIVED_COL, STATE_COL,
} from '../logic/common.js';
import { syncColumns } from '../logic/formulas.js';
import { apply, readSchema } from '../grist.js';
import { dropPages, hideColumn } from '../pages.js';

// Colonnes du journal : celles de la table Synchro (le webhook envoie chaque ligne entière), puis
// les colonnes des lignes dépliées et leurs marques (clé, date, suppression, bloc des colonnes ;
// recopiée, effet, valeurs remplacées, auteur, date d'arrivée). Le webhook n'écrit que les
// premières : une colonne propre au journal ne gêne pas.
const JOURNAL_COLUMNS = [
  ...syncColumns([]).map(({ id, type }) => ({ id, type, isFormula: false })).filter(c => ![AUTHOR_COL, MISSING_COL].includes(c.id)),
  { id: KEY_COL, type: 'Text', isFormula: false },
  { id: ORDER_COL, type: 'DateTime:UTC', isFormula: false },
  { id: DELETE_COL, type: 'Bool', isFormula: false },
  { id: DATA_COL, type: 'Text', isFormula: false },
  { id: APPLIED_COL, type: 'Bool', isFormula: false },
  { id: STATE_COL, type: 'Text', isFormula: false },
  { id: BEFORE_COL, type: 'Text', isFormula: false },
  { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  { id: RECEIVED_COL, type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 0 },
];

// Journaux d'exports reçus : leur note dit d'où ils viennent et où va chaque table.
// { journal, note: { id, export, name, secret, from, mode, base, tables: [{ table, dest, columns,
// map, match, label }], refused: [], missing: {} } }
export function receivedJournals(schema) {
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX)).map((journal) => {
    const note = readNote(schema, journal);
    return note && note.export && Array.isArray(note.tables) ? { journal, note: { refused: [], missing: {}, ...note } } : null;
  }).filter(Boolean);
}

// Journaux d'avant la version 0.4 (un par table reçue) : à refaire.
export function legacyJournals(schema) {
  const current = new Set(receivedJournals(schema).map(r => r.journal));
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX) && !current.has(id) && (schema.columns(id) || []).some(c => c.colId === LIST_COL));
}

// Tables reçues ici, avec le document qui les envoie : pour refuser les boucles et repérer un relais.
export const receivedDests = schema => receivedJournals(schema)
  .flatMap(({ note }) => note.tables.map(tb => ({ dest: tb.dest, fromDocId: (note.from || {}).docId || '' })));

// Un journal créé par une version précédente du widget reçoit les colonnes techniques qui lui
// manquent. Renvoie vrai si le schéma a changé.
export async function upgradeJournal(schema, journal) {
  const have = new Set(schema.columns(journal).map(c => c.colId));
  const missing = JOURNAL_COLUMNS.filter(c => !have.has(c.id));
  await apply(missing.map(({ id, ...info }) => ['AddColumn', journal, id, info]));
  return missing.length > 0;
}

// Colonnes que la destination reçoit : les colonnes de données.
export const destColumns = columns => columns.filter(c => ![KEY_COL, ORDER_COL, DELETE_COL].includes(c.id));

// CIBLE : colonnes envoyées qui manquent à la destination, sous le nom choisi dans `map`
// (colonne envoyée -> colonne de la destination). La clé `id_sync` en fait partie. Les colonnes de
// données s'affichent dans les vues de la table (`AddColumn` ne les mettrait que dans « Données
// source » et la fiche : une colonne ajoutée plus tard à l'export arrivait cachée) ; la clé non.
export function addDestColumnsActions(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return [...destColumns(columns), { id: KEY_COL, type: 'Text', label: KEY_COL }]
    .map(({ id, type, label }) => ({ id: map[id] || id, type, label: map[id] ? map[id] : label, key: id === KEY_COL }))
    .filter(c => !have.has(c.id))
    .map(({ id, key, ...info }) => [key ? 'AddColumn' : 'AddVisibleColumn', dest, id, { ...info, isFormula: false }]);
}

export async function createJournal(journal, note) {
  await apply([['AddTable', journal, JOURNAL_COLUMNS]]);
  await writeNote(await readSchema(), journal, note);
  await dropPages([journal]);
}

// Destination d'une table reçue : créée, ou complétée des colonnes qui lui manquent ; sa clé
// `id_sync` est masquée de sa page.
export async function prepareDest({ dest, columns, map = {} }) {
  if (!(await readSchema()).has(dest)) await apply([['AddTable', dest, []]]);
  await apply(addDestColumnsActions(await readSchema(), dest, columns, map));
  await hideColumn(dest, KEY_COL);
}

// Note JSON dans la description de la colonne Synchro_Ids d'un journal.
const listColumn = (schema, tableId) => (schema.columns(tableId) || []).find(c => c.colId === LIST_COL);

function readNote(schema, tableId) {
  const column = listColumn(schema, tableId);
  try { return JSON.parse((column && column.description) || 'null'); } catch (e) { return null; }
}

async function writeNote(schema, tableId, value) {
  await apply([['UpdateRecord', '_grist_Tables_column', listColumn(schema, tableId).id, { description: value == null ? '' : JSON.stringify(value) }]]);
}

// Note d'un journal relue, changée par `change` (qui rend la nouvelle note), puis écrite.
export async function updateJournalNote(journal, change) {
  const schema = await readSchema();
  await writeNote(schema, journal, change(readNote(schema, journal)));
}
