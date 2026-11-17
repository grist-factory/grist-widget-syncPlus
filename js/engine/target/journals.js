// CIBLE : un journal par export reçu, Journal_<export>, où le webhook dépose les listes et les lots.
// Ce que la CIBLE a choisi (destinations, colonnes) est noté dans la description de sa colonne
// Synchro_Ids (voir journalNote dans logic/received.js pour sa forme) ; la clé du formulaire peut
// la lire, mais pas l'écrire. Le journal n'a pas de page : seul son formulaire en a une (voir
// pages.js).
import {
  APPLIED_COL, AUTHOR_COL, BEFORE_COL, DATA_COL, DELETE_COL, KEY_COL, MISSING_COL, ORDER_COL, RECEIVED_COL, SEAL_COL, STATE_COL,
} from '../logic/common.js';
import { syncColumns } from '../logic/formulas.js';
import { addDestColumnsActions, dropKeyActions, journalNote, journalNoteAction, storeKeyActions } from '../logic/received.js';
import { apply, readSchema } from '../port.js';
import { dropPages, hideColumn } from '../pages.js';

// Colonnes du journal : celles de la table Synchro (le webhook envoie chaque ligne entière), puis
// les colonnes des lignes dépliées et leurs marques (clé, date, suppression, bloc des colonnes ;
// recopiée, effet, valeurs remplacées, auteur, date d'arrivée, sceau). Le webhook n'écrit que les
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
  { id: SEAL_COL, type: 'Text', isFormula: false },
];

// Un journal créé par une version précédente du widget reçoit les colonnes techniques qui lui
// manquent. Renvoie vrai si le schéma a changé.
export async function upgradeJournal(schema, journal) {
  const have = new Set(schema.columns(journal).map(c => c.colId));
  const missing = JOURNAL_COLUMNS.filter(c => !have.has(c.id));
  await apply(missing.map(({ id, ...info }) => ['AddColumn', journal, id, info]));
  return missing.length > 0;
}

// Clé de signature notée dans les destinations (voir receivedKey).
export async function storeKey(tables, slot, key) {
  await apply(storeKeyActions(await readSchema(), tables, slot, key));
}

// Clé de signature retirée des destinations (voir dropKeyActions).
export async function dropKey(tables, slot) {
  await apply(dropKeyActions(await readSchema(), tables, slot));
}

export async function createJournal(journal, note) {
  await apply([['AddTable', journal, JOURNAL_COLUMNS]]);
  await apply([journalNoteAction(await readSchema(), journal, note)]);
  await dropPages([journal]);
}

// Destination d'une table reçue : créée, ou complétée des colonnes qui lui manquent ; sa clé
// `id_sync` est masquée de sa page.
export async function prepareDest({ dest, columns, map = {} }) {
  if (!(await readSchema()).has(dest)) await apply([['AddTable', dest, []]]);
  await apply(addDestColumnsActions(await readSchema(), dest, columns, map));
  await hideColumn(dest, KEY_COL);
}

// Note d'un journal relue, changée par `change` (qui rend la nouvelle note), puis écrite. Rend la
// note écrite.
export async function updateJournalNote(journal, change) {
  const schema = await readSchema();
  const note = change(journalNote(schema, journal));
  await apply([journalNoteAction(schema, journal, note)]);
  return note;
}
