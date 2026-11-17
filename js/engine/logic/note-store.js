// Où le widget garde ses notes (voir columnNote dans common.js) : les colonnes qui en portent une, et le
// déplacement des notes d'avant la 3.0.0, qui étaient dans la description des colonnes.
//
// Pourquoi : `GET /api/docs/<id>/tables/_grist_Tables_column/records` est lisible par tout lecteur du
// document, lien public compris. Pour une colonne qu'il n'a pas le droit de lire, Grist en vide le nom, le
// type, la formule et les options, mais pas la description (`CensorshipInfo`, vérifié sur Grist 1.7.22) : la
// note de la SOURCE (courriel du propriétaire, documents des destinataires, clé privée d'une invitation en
// attente), celle d'un journal (secret d'invitation) et la clé de signature d'une table reçue étaient donc
// lisibles. Dans les options, elles disparaissent avec la colonne cachée.
import { EXPORT_COL, JOURNAL_PREFIX, KEY_COL, LIST_COL, SYNC_TABLE, isUserTable, legacyNote, hasNoteOption, noteAction } from './common.js';
import { ownsSync } from './strays.js';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Colonnes qui portent une note du widget : { column, table, note } où `note` est celle d'avant (description),
// si elle y est encore. La clé de signature d'une table reçue (colonne id_sync) n'est une note du widget que
// si elle porte `signature` : une description écrite à la main sur cette colonne n'est jamais touchée.
function carriers(schema) {
  const found = [];
  const add = (table, colId, accepts) => {
    const column = (schema.columns(table) || []).find(c => c.colId === colId);
    if (column) found.push({ column, table, accepts });
  };
  if (ownsSync(schema)) add(SYNC_TABLE, EXPORT_COL, () => true);
  for (const table of schema.tableIds) {
    if (table.startsWith(JOURNAL_PREFIX)) add(table, LIST_COL, () => true);
    else if (isUserTable(table)) add(table, KEY_COL, note => isObject(note.signature));
  }
  return found;
}

// Actions qui déplacent dans les options les notes encore dans la description (vides si rien n'est à faire) :
// une note d'avant devient la note de la colonne (`noteAction` vide sa description) ; si la colonne a déjà une
// note dans ses options, c'est elle qui fait foi et la description d'avant (réécrite par une version plus
// ancienne restée ouverte, par exemple) est seulement vidée.
export function legacyNoteActions(schema) {
  return carriers(schema).flatMap(({ column, accepts }) => {
    const legacy = legacyNote(column);
    if (!legacy || !accepts(legacy)) return [];
    return [hasNoteOption(column) ? ['UpdateRecord', '_grist_Tables_column', column.id, { description: '' }] : noteAction(column, legacy)];
  });
}
