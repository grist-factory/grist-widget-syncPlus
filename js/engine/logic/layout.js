// Ordre et colonnes cachées de la page d'une table, que la SOURCE peut envoyer avec ses colonnes (case « Ordre et
// colonnes cachées » de l'assistant d'export). Ce n'est que de l'affichage : jamais une donnée, jamais un droit.
//
// Ce que Grist en dit (vérifié dans un Grist 1.7) : une table a une section de données brutes (`rawViewSectionRef`), une
// section de fiche (`recordCardViewSectionRef`) et, pour chaque page qui la montre, une section de la page. Les colonnes
// cachées n'existent que dans une section de page (une section de données brutes ne peut pas retirer un champ). Chaque
// colonne montrée y est un champ (`_grist_Views_section_field`, `colRef`), rangé par `parentPos`. La « section modèle » est
// la première section de type tableau (`record`) d'une page de la table : c'est elle que la SOURCE lit et que la CIBLE écrit.
//
// Dans la description signée des colonnes (`Synchro_Colonnes`) : `pos` sur chaque colonne d'un export qui envoie la mise en
// page d'une table qui a une section modèle : son rang parmi les colonnes envoyées et montrées (0, 1, 2…), ou -1 si la page
// la cache. La présence de la clé dit que l'export l'envoie.
//
// Chez le destinataire, la mise en page ne touche que les colonnes que le widget a créées (`own`) : une colonne qui existait
// déjà garde sa place. Les colonnes créées sont décidées une fois (`laid` de l'entrée de la note), puis à la demande
// (« Reprendre depuis la SOURCE »).
import { destContext } from './schema.js';

export const POS_MAX = 100000;

// Un rang envoyé, valide : un entier de -1 à POS_MAX.
export const isPos = pos => Number.isInteger(pos) && pos >= -1 && pos <= POS_MAX;

// La section modèle de la table `table` (ligne de `_grist_Tables`) dans `sections` (lignes de `_grist_Views_section`), ou null :
// la première section de type tableau d'une page, hors données brutes et fiche.
export function modelSection(table, sections) {
  if (!table || !Array.isArray(sections)) return null;
  const found = sections.filter(s => s && s.tableRef === table.id && s.parentKey === 'record' && s.parentId > 0
    && s.id !== table.rawViewSectionRef && s.id !== table.recordCardViewSectionRef);
  return found.sort((a, b) => a.id - b.id)[0] || null;
}

// Les colonnes exportées `columns` de la table `table` avec leur rang dans sa section modèle (`pos`). `live` : ses colonnes
// (`schema.columns(table)`), `tableRow` : sa ligne de `_grist_Tables`, `sections` et `fields` : les lignes de
// `_grist_Views_section` et de `_grist_Views_section_field`. Sans section modèle, les colonnes sont rendues sans `pos`.
export function withLayout(columns, live, tableRow, sections, fields) {
  const section = modelSection(tableRow, sections);
  if (!section || !Array.isArray(fields)) return columns.map(({ pos, ...c }) => c);
  const refs = new Map(live.map(c => [c.colId, c.id]));
  const sent = new Set(columns.map(c => refs.get(c.id)));
  const order = fields.filter(f => f.parentId === section.id && sent.has(f.colRef)).sort((a, b) => a.parentPos - b.parentPos).map(f => f.colRef);
  return columns.map(c => ({ ...c, pos: order.includes(refs.get(c.id)) ? order.indexOf(refs.get(c.id)) : -1 }));
}

// Cet export envoie-t-il la mise en page : une colonne au moins porte un rang.
export const layoutSent = columns => (Array.isArray(columns) ? columns : []).some(c => c && isPos(c.pos));

// La mise en page à poser dans la destination `entry.dest` (voir la note de l'entrée : `own`, `map`, `laid`). Seules les colonnes
// créées par le widget sont décidées, une fois (`laid`) ; avec `replace` (« Reprendre depuis la SOURCE »), toutes, et une colonne
// que la SOURCE montre et que cette page cache est remontrée.
// - une colonne que la SOURCE cache perd son champ dans la section modèle d'ici ;
// - les colonnes montrées gardent entre elles l'ordre de la SOURCE : elles se répartissent les places que leurs champs occupaient
//   (les autres champs ne bougent pas) ; une colonne à remontrer prend une place de plus, après les autres.
// `columns` : colonnes envoyées (avec `pos`), `sections` et `fields` : lignes de `_grist_Views_section` et de `_grist_Views_section_field`.
// Rend `actions` (à appliquer) et `laid` (les colonnes décidées, par identifiant envoyé).
export function planLayout(schema, entry, columns, { sections, fields, replace = false } = {}) {
  const section = modelSection(schema.table(entry.dest), sections);
  if (!section || !Array.isArray(fields)) return { actions: [], laid: [] };
  const { here, map, own } = destContext(schema, entry);
  const done = new Set(entry.laid || []);
  const field = new Map(fields.filter(f => f.parentId === section.id).map(f => [f.colRef, f]));
  const asked = columns.filter(c => isPos(c.pos) && own.has(c.id) && here.has(map[c.id] || c.id) && (replace || !done.has(c.id)))
    .map(c => ({ id: c.id, pos: c.pos, column: here.get(map[c.id] || c.id) }));
  const actions = [];
  const hidden = asked.filter(a => a.pos < 0 && field.has(a.column.id));
  if (hidden.length) actions.push(['BulkRemoveRecord', '_grist_Views_section_field', hidden.map(a => field.get(a.column.id).id)]);
  // Les colonnes montrées, dans l'ordre de la SOURCE ; celles qui n'ont plus de champ ici (remontrées seulement sur demande).
  const shown = asked.filter(a => a.pos >= 0 && (field.has(a.column.id) || replace)).sort((a, b) => a.pos - b.pos);
  const missing = shown.filter(a => !field.has(a.column.id));
  const last = Math.max(0, ...[...field.values()].map(f => f.parentPos));
  const slots = [...shown.filter(a => field.has(a.column.id)).map(a => field.get(a.column.id).parentPos).sort((a, b) => a - b),
    ...missing.map((_, i) => last + i + 1)];
  const moved = [];
  const added = [];
  shown.forEach((a, i) => {
    if (!field.has(a.column.id)) added.push(['AddRecord', '_grist_Views_section_field', null, { parentId: section.id, colRef: a.column.id, parentPos: slots[i] }]);
    else if (field.get(a.column.id).parentPos !== slots[i]) moved.push([field.get(a.column.id).id, slots[i]]);
  });
  if (moved.length) actions.push(['BulkUpdateRecord', '_grist_Views_section_field', moved.map(([id]) => id), { parentPos: moved.map(([, pos]) => pos) }]);
  return { actions: [...actions, ...added], laid: asked.map(a => a.id) };
}
