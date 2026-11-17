// CIBLE : ce que le schéma dit des exports reçus (journaux, destinations, clés de signature), en
// fonctions pures sur le schéma lu (voir readSchema dans grist.js). Les écritures sont dans
// target/journals.js.
import { JOURNAL_PREFIX, KEY_COL, LIST_COL, SIG_KEY, columnNote, isUserTable, noteAction } from './common.js';
import { destColumns } from './journal.js';
import { columnOptions, fillOptions, isChoice, ownsColumn, receivedChoices, replaceOptions, ruleStyle, ruleStyles, sentRules, withRuleStyles } from './options.js';
import { parseRule, printRule } from './rules.js';
import { destContext } from './schema.js';

// Note d'un journal : JSON dans la description de sa colonne Synchro_Ids (description de référence).
// - invitation : id, export, name, secret (pour le code de la réponse), from { email, docId,
//   docName }, mode (absent : réponse ; 'echange', 'public' avec base, l'adresse de la SOURCE),
//   renforce, reserve (journal réservé aux éditeurs, voir acl.js), reserved (règle posée), archive
//   (une ligne effacée à la SOURCE reste ici, cochée), verrou (tables reçues en lecture seule,
//   voir target/options.js), ask (les colonnes que la SOURCE ajoute attendent l'accord de la personne, voir
//   structure.js), pub et
//   pubSource (clés publiques de la réponse et de l'invitation, pour le code de la réponse et son
//   code de contrôle ; jamais de clé privée, voir linkKeys) ;
// - Échange : retour (journal de retour, chez qui a invité), hook (webhook du participant) ;
// - par table : tables [{ table, dest, columns, map, match, label, refs, dropped, addedCols,
//   waiting }] (voir loop.js), refused (tables refusées) ;
// - état des arrivées : missing { table: lignes manquantes }, big { table: clés trop grosses },
//   tooBig (lien public), suspect (arrivées suspectes), ended (heure de l'avis de fin) ;
// - sceau : empreinte de la clé qui scelle les lignes dépliées (voir trust.js). Une fois notée, une
//   clé de signature introuvable arrête le dépliage (voir sealing dans loop.js).
const listColumn = (schema, tableId) => (schema.columns(tableId) || []).find(c => c.colId === LIST_COL);
export const journalNote = (schema, tableId) => columnNote(listColumn(schema, tableId));
export const journalNoteAction = (schema, tableId, note) => noteAction(listColumn(schema, tableId), note);

// Ce que la note garde des options d'une réception (rien pour une option décochée).
export const optionsNote = ({ archive, verrou, ask }) => ({ ...(archive ? { archive: true } : {}), ...(verrou ? { verrou: true } : {}), ...(ask ? { ask: true } : {}) });

// Journaux d'exports reçus : { journal, note } (note : voir plus haut), dont la note dit d'où ils
// viennent et où va chaque table.
export function receivedJournals(schema) {
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX)).map((journal) => {
    const note = journalNote(schema, journal);
    return note && note.export && Array.isArray(note.tables) ? { journal, note: { refused: [], missing: {}, ...note } } : null;
  }).filter(Boolean);
}

// Tables reçues ici, avec la table envoyée et le document qui l'envoie : pour refuser les boucles,
// repérer un relais et dire ce qu'une destination reçoit déjà.
export const receivedDests = schema => receivedJournals(schema)
  .flatMap(({ note }) => note.tables.map(tb => ({ dest: tb.dest, table: tb.table, fromDocId: (note.from || {}).docId || '' })));

// Colonnes envoyées qui manquent à la destination, sous le nom choisi dans `map` (colonne envoyée
// -> colonne de la destination). La clé `id_sync` en fait partie. Les colonnes de données
// s'affichent dans les vues de la table (`AddColumn` ne les mettrait que dans « Données source » et
// la fiche : une colonne ajoutée plus tard à l'export arrivait cachée) ; la clé non. Chacune prend
// la liste de choix et le format de la SOURCE (voir options.js).
export function addDestColumnsActions(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return [...destColumns(columns), { id: KEY_COL, type: 'Text', label: KEY_COL }]
    .map(({ id, type, label, opts }) => ({ id: map[id] || id, type, label: map[id] ? map[id] : label, key: id === KEY_COL, opts: columnOptions(type, opts, { extras: true }) }))
    .filter(c => !have.has(c.id))
    .map(({ id, key, opts, ...info }) => {
      const { rules, ...format } = opts || {}; // les règles conditionnelles se posent après (voir planRules)
      return [key ? 'AddColumn' : 'AddVisibleColumn', dest, id, { ...info, isFormula: false, ...(Object.keys(format).length ? { widgetOptions: JSON.stringify(format) } : {}) }];
    });
}

// Colonnes envoyées (leur nom dans l'export) que addDestColumnsActions créerait : la CIBLE les note
// comme siennes (`own` de l'entrée), seules à recevoir plus tard les choix ajoutés à la SOURCE.
export function missingColumns(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return destColumns(columns).map(c => c.id).filter(id => !have.has(map[id] || id));
}

// Listes de choix et formats reçus, ajoutés à ce qui manque aux colonnes de la destination que la
// CIBLE a créées (voir ownsColumn et fillOptions). `columns` : colonnes envoyées, avec `opts`.
export function optionActions(schema, entry, columns) {
  const { here } = destContext(schema, entry);
  return destColumns(columns).filter(c => c.opts).flatMap((c) => {
    const column = here.get((entry.map || {})[c.id] || c.id);
    if (!column || !ownsColumn(entry.own, c.id, column)) return [];
    const text = fillOptions(column.type, column.widgetOptions, c.opts);
    return text ? [['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: text }]] : [];
  });
}

// « Reprendre la mise en forme » : le style de chaque colonne reçue prend celui de la SOURCE (voir
// replaceOptions), colonnes créées ici ou non. `columns` : colonnes envoyées, avec `opts`.
export function restyleOptionActions(schema, entry, columns) {
  const { here } = destContext(schema, entry);
  return destColumns(columns).flatMap((c) => {
    const column = here.get((entry.map || {})[c.id] || c.id);
    const text = column ? replaceOptions(column.type, column.widgetOptions, c.opts || {}) : null;
    return text ? [['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: text }]] : [];
  });
}

// Règles de mise en forme conditionnelle à poser sur les colonnes reçues. Chaque règle envoyée est relue par
// la grammaire de rules.js et sa formule réécrite d'ici, avec les noms des colonnes d'ici ; une règle qui lit
// une colonne absente d'ici est laissée. Hors `replace`, seules les colonnes créées par le widget (`own`) dont
// le sort n'est pas encore décidé (`entry.styled`) en reçoivent, et seulement si elles n'en ont pas déjà :
// ce qui est décidé, retouché ou supprimé ici n'est plus refait. Avec `replace` (la personne l'a demandé),
// les règles d'ici sont retirées et remplacées par celles de la SOURCE. Rend `todo` (colonne, règles,
// colonnes cachées à retirer) et `settled` (colonnes décidées sans rien poser : elles ont déjà leurs règles).
export function planRules(schema, entry, columns, { replace = false } = {}) {
  const cols = schema.columns(entry.dest) || [];
  const here = new Map(cols.map(c => [c.colId, c]));
  const map = entry.map || {};
  const context = {
    here, map, replace, byRow: new Map(cols.map(c => [c.id, c])),
    rename: id => (here.has(map[id] || id) ? map[id] || id : null),
    decided: new Set(entry.styled || []), own: new Set(Array.isArray(entry.own) ? entry.own : []),
  };
  const todo = [];
  const settled = [];
  for (const sent of destColumns(columns)) {
    const planned = planColumnRules(sent, context);
    if (!planned) continue;
    if (planned.settled) settled.push(sent.id);
    else todo.push(planned.todo);
  }
  return { todo, settled };
}

// Les règles d'une colonne envoyée : à poser (`todo`) ou déjà là (`settled`) ; null quand la colonne n'est pas à traiter.
function planColumnRules(c, { here, map, replace, byRow, rename, decided, own }) {
  const rules = sentRules(c.opts).map(r => ({ formula: printRule(parseRule(r.when), rename), style: ruleStyle(r) })).filter(r => r.formula);
  const column = here.get(map[c.id] || c.id);
  if (!rules.length || !column || (!replace && (decided.has(c.id) || !own.has(c.id)))) return null;
  const old = (Array.isArray(column.rules) ? column.rules.slice(1) : []).map(ref => (byRow.get(ref) || {}).colId).filter(Boolean);
  if (!replace && (old.length || ruleStyles(column.widgetOptions).length)) return { settled: true };
  return { todo: { id: c.id, column, rules, old: replace ? old : [] } };
}

// Première étape de la pose des règles : les colonnes cachées d'ici à retirer, puis une règle vide par règle
// à poser. Grist ne dit le nom de la colonne cachée d'une règle qu'une fois celle-ci ajoutée (`owners` : pour
// chaque action, le numéro de l'élément de `todo` à qui elle revient, -1 pour un retrait).
export function startRules(dest, todo) {
  const actions = [];
  const owners = [];
  todo.forEach((item, i) => {
    for (const helper of item.old) { actions.push(['RemoveColumn', dest, helper]); owners.push(-1); }
    for (let n = 0; n < item.rules.length; n++) { actions.push(['AddEmptyRule', dest, 0, item.column.id]); owners.push(i); }
  });
  return { actions, owners };
}

// Seconde étape : la formule de chaque règle (écrite par rules.js) et les styles dans les options de la
// colonne. `retValues` : ce que Grist a rendu à la première étape.
export function finishRules(dest, todo, owners, retValues) {
  const made = todo.map(() => []);
  owners.forEach((owner, k) => { if (owner >= 0 && retValues[k] && retValues[k].colId) made[owner].push(retValues[k].colId); });
  return todo.flatMap((item, i) => (made[i].length !== item.rules.length ? [] : [
    ...made[i].map((helper, n) => ['ModifyColumn', dest, helper, { formula: item.rules[n].formula }]),
    ['UpdateRecord', '_grist_Tables_column', item.column.id, { widgetOptions: withRuleStyles(item.column.widgetOptions, item.rules.map(r => r.style)) }],
  ]));
}

// Colonnes cachées créées à la première étape (à retirer si la seconde échoue).
export const madeHelpers = (owners, retValues) => owners.map((owner, k) => (owner >= 0 && retValues[k] ? retValues[k].colId : '')).filter(Boolean);

// Colonnes de choix d'ici créées par le widget, dont la SOURCE n'envoie pas de liste (export filtré,
// ou colonne sans liste) : la liste se complète des valeurs reçues (voir receivedChoices).
// `rows` : fonction qui rend les dernières versions reçues, lues seulement s'il y a une colonne.
export function valueChoiceActions(schema, entry, columns, rows) {
  const { here } = destContext(schema, entry);
  const wanted = destColumns(columns).filter(c => isChoice(c.type) && !(c.opts && c.opts.choices)).map(c => ({ c, column: here.get((entry.map || {})[c.id] || c.id) }))
    .filter(({ c, column }) => column && isChoice(column.type) && ownsColumn(entry.own, c.id, column));
  const received = wanted.length ? rows() : [];
  return wanted.flatMap(({ c, column }) => {
    const text = receivedChoices(column.widgetOptions, received.map(row => row[c.id]));
    return text ? [['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: text }]] : [];
  });
}

// Clé qui signe les envois d'un export reçu (voir trust.js) : dans la note (les options, voir columnNote)
// de la colonne id_sync de ses destinations ({ signature: { <place>: <clé> } }), pas dans la note du
// journal, que la clé du formulaire peut lire. Les options d'id_sync sont cachées aux lecteurs par une règle
// d'accès (keyAclRules). La place est l'export ; pour un journal de retour d'Échange,
// le journal lui-même : chaque participant signe avec sa propre clé, donnée dans sa réponse.
export const keySlot = (journal, note) => (note.retour ? journal : note.export);
const keyColumn = (schema, table) => (schema.columns(table) || []).find(c => c.colId === KEY_COL);
function keysOf(column) {
  const { signature } = columnNote(column) || {};
  return signature && typeof signature === 'object' ? signature : {};
}
// Tables d'ici dont la colonne id_sync porte une clé de signature : celles dont la colonne est cachée aux lecteurs.
export const signedTables = schema => schema.tableIds.filter(isUserTable)
  .filter(table => Object.keys(keysOf(keyColumn(schema, table))).length > 0).sort();
// Nom actuel de la destination d'une table reçue : renommée ici, elle se retrouve par son numéro dans Grist (`refs`,
// voir followRenames). Sans cela, renommer la seule table d'un export faisait perdre la clé (donc la réception).
const destNow = (schema, tb) => {
  const ref = (tb.refs || {}).table;
  return (ref && schema.tableIdOf && schema.tableIdOf(ref)) || tb.dest;
};
export function receivedKey(schema, journal, note) {
  const slot = keySlot(journal, note);
  return (note.tables || []).map(tb => keysOf(keyColumn(schema, destNow(schema, tb)))[slot]).find(k => SIG_KEY.test(k || '')) || '';
}
// Clé notée à sa place dans les destinations `tables` qui ne l'ont pas déjà.
export function storeKeyActions(schema, tables, slot, key) {
  if (!SIG_KEY.test(key || '')) return [];
  return tables.map(table => keyColumn(schema, table)).filter(c => c && keysOf(c)[slot] !== key)
    .map(c => noteAction(c, { signature: { ...keysOf(c), [slot]: key } }));
}
// Clé retirée de sa place dans les destinations `tables` (retour à l'ancien fonctionnement, voir reinforce.js).
export function dropKeyActions(schema, tables, slot) {
  return tables.map(table => keyColumn(schema, table)).filter(c => c && slot in keysOf(c))
    .map((c) => {
      const { [slot]: gone, ...rest } = keysOf(c);
      return noteAction(c, Object.keys(rest).length ? { signature: rest } : null);
    });
}
