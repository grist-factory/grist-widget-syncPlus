// Descriptions des colonnes et de la table, que la SOURCE peut envoyer avec ses colonnes (case « Descriptions » de
// l'assistant d'export). Un texte libre, montré par Grist dans l'infobulle d'une colonne ou d'une table : jamais
// interprété ici, mais nettoyé et borné, comme tout ce qu'un code ou un journal dit.
//
// Dans la description signée des colonnes (`Synchro_Colonnes`) : `desc` (texte, vide s'il n'y en a pas) sur chaque
// colonne d'un export qui envoie les descriptions de colonnes ; `tdesc` sur la première colonne d'un export qui
// envoie celle de la table. La présence de la clé dit que l'export l'envoie, même vide.

import { formulasSent } from './column-formulas.js';
import { layoutSent } from './layout.js';
import { destContext } from './schema.js';

// Longueur maximale d'une description de colonne, et de la table. La description des colonnes part avec chaque
// envoi (un lot la porte) : 40 colonnes de 300 caractères restent loin du mégaoctet que Grist accepte par envoi.
export const NOTE_MAX = 300;
export const TABLE_NOTE_MAX = 500;

// Texte d'une description, nettoyé : sans caractères de contrôle (sauf le retour à la ligne) ni de sens d'écriture
// (un U+202E retournerait le texte qui suit), lignes vides en trop retirées, borné à `max` caractères (une
// ellipse dit qu'il est coupé). Un texte qui n'en est pas un donne ''.
export function cleanNote(text, max = NOTE_MAX) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁯﻿]/g, '')
    .replace(/[ ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : clean;
}

// Description de la table `table` (ligne de `_grist_Tables`) : celle de sa section de données brutes, dans
// `sections` (lignes de `_grist_Views_section`). '' s'il n'y en a pas.
export function tableNoteOf(table, sections) {
  const raw = table && table.rawViewSectionRef;
  const section = raw && Array.isArray(sections) ? sections.find(s => s.id === raw) : null;
  return section ? cleanNote(section.description, TABLE_NOTE_MAX) : '';
}

// Ce qu'une liste de colonnes envoyées dit sur les descriptions : `notes` (celles des colonnes) et `table`
// (celle de la table) sont vrais quand l'export les envoie. `table` rend aussi le texte (ou null).
export function noteSent(columns) {
  const list = Array.isArray(columns) ? columns : [];
  const tdesc = list.find(c => c && typeof c.tdesc === 'string');
  return { notes: list.some(c => c && typeof c.desc === 'string'), table: Boolean(tdesc), tableNote: tdesc ? tdesc.tdesc : null };
}

// Les colonnes avec la description de la table sur la première (et pas ailleurs) ; `note` null ou absent : aucune.
export const withTableNote = (columns, note) => columns.map(({ tdesc, ...c }, i) => (i === 0 && typeof note === 'string' ? { ...c, tdesc: note } : c));

// Ce que l'export envoie, vu de la CIBLE d'après ses colonnes : `style` (la mise en forme, marque `fmt`),
// `notes` (descriptions de colonnes), `table` (description de la table), `layout` (ordre et colonnes cachées de la page, voir
// layout.js) et `formulas` (au moins une formule de colonne, voir column-formulas.js). Les éléments envoyés, sous forme de liste.
export function sentElements(columns) {
  const list = Array.isArray(columns) ? columns : [];
  const sent = noteSent(list);
  return [...(list.some(c => c && c.fmt) ? ['style'] : []), ...(sent.notes ? ['notes'] : []), ...(sent.table ? ['table'] : []), ...(layoutSent(list) ? ['layout'] : []), ...(formulasSent(list) ? ['formulas'] : [])];
}

// Descriptions à poser dans la destination `entry.dest` (voir la note de l'entrée : `own`, `map`, `described`,
// `tabled`). Comme pour les formats, la CIBLE ne fait que compléter ce qui est à elle : une colonne créée par le
// widget (`own`) qui n'a pas de description en reçoit celle de la SOURCE, une seule fois (`described`) ; une
// description retouchée ou effacée ici n'est plus refaite. La description de la table est posée de même quand
// elle est vide (`tabled`). Avec `replace` (« Reprendre depuis la SOURCE »), la description de chaque colonne
// reçue (`replaceTable` : de la table) devient celle de la SOURCE, vide comprise.
// `columns` : colonnes envoyées (avec `desc`), `tableNote` : description de la table envoyée (ou null),
// `sections` : lignes de `_grist_Views_section` (nécessaires seulement pour la table).
// Rend `actions` (à appliquer), `described` (colonnes décidées) et `tabled` (vrai si la table l'est).
export function planNotes(schema, entry, columns, { replace = false, replaceTable = false, tableNote = null, sections = null } = {}) {
  const forColumns = columnNotePlan(schema, entry, columns, replace);
  const forTable = tableNotePlan(schema, entry, { replaceTable, tableNote, sections });
  return { actions: [...forColumns.actions, ...forTable.actions], described: forColumns.described, tabled: forTable.tabled };
}

// Faut-il écrire `text` : remplacer ce qui est là s'il diffère (`replace`), sinon seulement remplir une description vide.
const noteChange = (current, text, replace) => (replace ? (current || '') !== text : !current && Boolean(text));

// Description de chaque colonne reçue : posée une fois si la colonne est de celles que le widget a créées et n'en a pas ; remplacée
// par celle de la SOURCE avec `replace`.
function columnNotePlan(schema, entry, columns, replace) {
  const { here, map, own } = destContext(schema, entry);
  const done = new Set(entry.described || []);
  const actions = [];
  const described = [];
  for (const sent of columns) {
    const column = here.get(map[sent.id] || sent.id);
    if (typeof sent.desc !== 'string' || !column || (!replace && (done.has(sent.id) || !own.has(sent.id)))) continue;
    const text = cleanNote(sent.desc);
    if (noteChange(column.description, text, replace)) actions.push(['UpdateRecord', '_grist_Tables_column', column.id, { description: text }]);
    if (text || replace) described.push(sent.id);
  }
  return { actions, described };
}

// Description de la table : celle de sa section de données brutes, posée quand elle est vide, remplacée avec `replaceTable`.
function tableNotePlan(schema, entry, { replaceTable, tableNote, sections }) {
  const actions = [];
  let tabled = Boolean(entry.tabled);
  const raw = (schema.table(entry.dest) || {}).rawViewSectionRef;
  const section = raw && typeof tableNote === 'string' && Array.isArray(sections) ? sections.find(s => s.id === raw) : null;
  if (section && (replaceTable || (!tabled && tableNote))) {
    const text = cleanNote(tableNote, TABLE_NOTE_MAX);
    if (noteChange(section.description, text, replaceTable)) actions.push(['UpdateRecord', '_grist_Views_section', raw, { description: text }]);
    tabled = Boolean(text) || replaceTable;
  }
  return { actions, tabled };
}
