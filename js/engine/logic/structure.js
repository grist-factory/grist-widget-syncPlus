// CIBLE : changements de structure que la SOURCE apporte à une table reçue après l'acceptation, et l'accord de la
// personne. Une réception « demande » (`ask` dans sa note, choisi à l'acceptation, jamais sur une réception d'avant) ou
// applique tout seule (comme avant). Quand elle demande :
//  - une colonne ajoutée à l'export n'est ni créée ni recopiée tant que la personne n'a pas cliqué (`held` de
//    receivedColumns) ; ses valeurs restent dans le journal, la SOURCE n'a rien à renvoyer ;
//  - un clic crée la colonne puis la remplit depuis la dernière version reçue de chaque ligne (`backfillActions`) ;
//  - ce qui ne se décide pas ici est seulement dit : colonne que la SOURCE n'envoie plus (elle reste, ses valeurs ne
//    bougent plus), type qui a changé pour une colonne créée par le widget (la destination garde le sien).
// Un avis dit n'est pas répété une fois la personne passée par « Appliquer » (`ack` de l'entrée). Rien n'est noté
// pour un Échange, ni pour un lien public : leurs colonnes suivent d'autres règles.
import { DELETE_COL, KEY_COL, chunk, isBlank, isTrue } from './common.js';
import { destColumns, latestByKey } from './journal.js';

const baseType = type => String(type || '').split(':')[0];

// Les avis de l'entrée `entry` pour une table : `held` (colonnes arrivées à valider, voir freshColumns), `gone`
// (colonnes que la SOURCE n'envoie plus), `retyped` (colonne créée par le widget dont le type envoyé n'est plus celui d'ici).
// `all` : toutes les colonnes envoyées ; `described` : la SOURCE a déjà décrit ses colonnes (sans cela, `all` est la liste
// de l'invitation et rien n'a pu disparaître) ; `here` : les colonnes de la destination.
export function structureChanges(entry, { held = [], all, described, here }) {
  const ack = new Set(entry.ack || []);
  const sentIds = new Set(all.map(c => c.id));
  const known = new Set([...(entry.columns || []).map(c => c.id), ...Object.keys(entry.map || {})]);
  const gone = described
    ? destColumns([...known].map(id => ({ id }))).map(c => c.id).filter(id => !sentIds.has(id) && !ack.has(goneKey(id))).map(id => ({ id, to: (entry.map || {})[id] || id }))
    : [];
  const byName = new Map(here.map(c => [c.colId, c]));
  const retyped = destColumns(all).filter(c => (entry.own || []).includes(c.id)).flatMap((c) => {
    const column = byName.get((entry.map || {})[c.id] || c.id);
    if (!column || /^Ref(List)?$/.test(baseType(column.type)) || baseType(column.type) === baseType(c.type) || ack.has(typeKey(c.id, c.type))) return [];
    return [{ id: c.id, to: column.colId, sent: baseType(c.type), here: baseType(column.type) }];
  });
  const result = { held, gone, retyped };
  return held.length + gone.length + retyped.length ? result : null;
}

const goneKey = id => `gone:${id}`;
const typeKey = (id, type) => `type:${id}:${baseType(type)}`;

// Avis à ne plus répéter une fois que la personne les a vus (`entry.ack`, sans doublon).
export function acknowledged(entry, structure) {
  if (!structure) return entry.ack;
  const keys = [...structure.gone.map(g => goneKey(g.id)), ...structure.retyped.map(r => typeKey(r.id, r.sent))];
  return keys.length ? [...new Set([...(entry.ack || []), ...keys])] : entry.ack;
}

// Cellules d'une colonne créée à l'instant (`specs` : [{ from, to }]) : chaque ligne d'ici qui a une clé reprend la valeur de la dernière
// version reçue de cette clé, si la cellule est vide. `rows` : lignes du journal de la table, fichiers et liens déjà résolus.
export function backfillActions({ journalRows, destRows, specs, destTable }) {
  if (!specs.length) return [];
  const latest = latestByKey(journalRows);
  return specs.flatMap((s) => {
    const cells = destRows.map(row => [row, latest.get(row[KEY_COL])])
      .filter(([row, v]) => v && !isTrue(v.row[DELETE_COL]) && Object.hasOwn(v.row, s.from) && !isBlank(v.row[s.from]) && isBlank(row[s.to]));
    return chunk(cells).map(part => ['BulkUpdateRecord', destTable, part.map(([row]) => row.id), { [s.to]: part.map(([, v]) => v.row[s.from]) }]);
  });
}
