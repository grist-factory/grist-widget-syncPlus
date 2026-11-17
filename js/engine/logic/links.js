// Références conservées entre tables d'un même export. Une colonne Référence ou Liste de références
// part toujours comme le texte qu'elle affiche (la CIBLE la lit sans rien savoir de plus) ; quand la
// personne choisit d'en garder le lien (étape Colonnes de l'assistant d'export), le lot porte en plus la
// clé de la ligne visée, ou la liste des clés des lignes visées (`Synchro_Cle_<colonne>` dans le bloc de
// données, voir formulas.js), et la description de la colonne dit vers quelle table (`link`). La CIBLE
// transforme alors la colonne qu'elle a créée en vraie Référence (ou Liste de références) vers la table
// reçue : la valeur écrite est le numéro de la ligne d'ici qui porte cette clé (la liste des numéros).
// Une ligne visée pas encore arrivée laisse la cellule vide (ou la liste incomplète) ; elle est
// complétée à son arrivée (voir fillLinks).
import { APPLIED_COL, DELETE_COL, KEY_COL, LINK_PREFIX, chunk, isBlank, isTrue } from './common.js';
import { latestByKey } from './journal.js';

const linkKey = id => `${LINK_PREFIX}${id}`;
const REF = /^(Ref|RefList):(\w+)$/;

// Ce que vise une colonne Référence (`Ref:T`) ou Liste de références (`RefList:T`) de la SOURCE
// (`c.source`) : sa table et si c'est une liste. Rien pour une autre colonne.
export const refOf = (c) => {
  const found = REF.exec((c && c.source) || '');
  return found ? { list: found[1] === 'RefList', target: found[2] } : null;
};

// Identifiant d'un choix de lien : la table et la colonne qui garde (ou non) son lien.
export const refKey = (table, id) => `${table}.${id}`;

// Table visée par une colonne Référence qui pourrait garder son lien : elle est dans l'export (la
// même table convient), avec la colonne que la Référence affiche (la CIBLE la reprend pour afficher
// la Référence ; sans elle, elle montrerait des numéros). Une Liste de références n'est reprise que
// si `lists` (le choix par colonne, voir linkTables ; l'ancien « tout ou rien » ne les connaissait pas).
const aim = (tables, c, lists = true) => {
  const ref = refOf(c);
  const there = ref && (lists || !ref.list) && tables.find(tb => tb.table === ref.target);
  return there && c.visible && there.columns.some(x => x.id === c.visible) ? ref.target : '';
};

// SOURCE : les colonnes Référence d'un export qui gardent leur lien reçoivent `link` (le nom de la
// table visée) ; les autres le perdent. `on` : `true` (comme avant la 0.27 : toutes les Références qui
// visent une table de l'export, pas les listes), ou un ensemble de `refKey` (exactement ces colonnes,
// Références comme Listes de références, quand la table visée est dans l'export avec sa colonne
// affichée). `tables` : [{ table, columns, filter }], colonnes de exportableColumns.
export const linkTables = (tables, on) => {
  const keys = on && on !== true ? new Set(on) : null;
  const kept = (table, c) => (on === true ? aim(tables, c, false) : keys && keys.has(refKey(table, c.id)) ? aim(tables, c) : '');
  // Une Liste de références garde son lien avec `list` : la CIBLE en fait une Liste de références, pas une Référence.
  return tables.map(tb => ({
    ...tb,
    columns: tb.columns.map(({ link, list, ...c }) => (kept(tb.table, c) ? { ...c, link: kept(tb.table, c), ...(refOf(c).list ? { list: true } : {}) } : c)),
  }));
};

// SOURCE, étape Colonnes : ce que la personne peut décider pour chaque colonne Référence ou Liste de
// références cochée, et les tables qu'il faut ajouter à l'export pour en garder le lien. `chosen` :
// tables cochées à l'étape Tables ; `columnsOf(table)` : colonnes envoyables (exportableColumns) ;
// `picked(table)` : colonnes cochées d'une table (rien : celles d'une table ajoutée pour un lien, qui ne
// part qu'avec sa colonne affichée) ; `choices` : choix faits dans cette fenêtre (refKey -> garder le
// lien ou non) ; `saved` : pour un export modifié, refKey -> la colonne gardait son lien. Sans choix ni
// état d'avant, le lien est gardé quand la table visée est déjà cochée (rien n'est ajouté) et que sa
// colonne affichée part ; sinon les valeurs seules partent (aucune table ne s'ajoute sans le choix).
// Rend `rows` (une par colonne : `key`, `table`, `id`, `label`, `list`, `target`, `shown`, `inside`
// (la table visée est cochée à l'étape Tables : rien ne s'ajoute), `ok` et `why` (`numbers` : la colonne n'affiche aucune colonne de sa
// table, `hidden` : la colonne affichée ne part pas), `link` : le lien est gardé) et `pulled` (table
// ajoutée -> colonnes affichées requises, en cascade : une table ajoutée peut avoir ses propres
// Références cochées).
export function linkOffers({ chosen, columnsOf, picked, choices = new Map(), saved = null }) {
  const pulled = new Map();
  const ticked = (table) => {
    const own = chosen.includes(table) ? new Set(picked(table) || []) : new Set([...(pulled.get(table) || []), ...(picked(table) || [])]);
    return own;
  };
  const rowsOf = (table) => {
    const have = ticked(table);
    return columnsOf(table).filter(c => have.has(c.id) && refOf(c)).map((c) => {
      const { target, list } = refOf(c);
      const key = refKey(table, c.id);
      const there = columnsOf(target) || [];
      const inside = chosen.includes(target);
      const shownThere = c.visible && there.some(x => x.id === c.visible);
      const hidden = shownThere && chosen.includes(target) && !ticked(target).has(c.visible);
      const ok = Boolean(shownThere) && !hidden;
      const why = ok ? '' : shownThere ? 'hidden' : 'numbers';
      const wanted = choices.has(key) ? choices.get(key) : saved && saved.has(key) ? saved.get(key) : chosen.includes(target);
      return { key, table, id: c.id, label: c.label || c.id, list, target, shown: c.visible || '', inside, ok, why, link: Boolean(wanted) && ok };
    });
  };
  let rows = [];
  for (let pass = 0; pass <= 50; pass++) {
    rows = [...chosen, ...pulled.keys()].flatMap(rowsOf);
    let grown = false;
    for (const r of rows) {
      if (!r.link || chosen.includes(r.target)) continue;
      const need = pulled.get(r.target) || new Set();
      if (!pulled.has(r.target) || !need.has(r.shown)) grown = true;
      pulled.set(r.target, new Set([...need, r.shown]));
    }
    if (!grown) break;
  }
  return { rows, pulled: new Map([...pulled].map(([table, set]) => [table, [...set]])) };
}

// CIBLE : une colonne envoyée qui garde son lien (`c.link`), avec ce qu'il faut pour en faire une
// Référence : son numéro et son type ici, la table d'ici visée, et la colonne que la Référence
// affiche (numéro et nom ici). Rien si la colonne, ou la colonne affichée, n'est pas là.
// `aim` : entrée de la note de la table visée (destination et correspondance de colonnes).
const columnFor = (schema, entry, id) => {
  const to = (entry.map || {})[id] || id;
  return { to, column: schema.columns(entry.dest).find(x => x.colId === to) };
};
function linkSpec(schema, entry, c, aim) {
  const { to, column } = columnFor(schema, entry, c.id);
  const shownId = (aim.map || {})[c.visible] || c.visible;
  const shown = c.visible && (schema.columns(aim.dest).find(x => x.colId === shownId) || {}).id;
  return column && shown ? { from: c.id, to, ref: column.id, type: column.type, target: aim.dest, shownId, shown, list: c.list === true } : null;
}

// CIBLE : les colonnes reçues qui gardent leur lien, pour la table `entry` de la note (`sent` :
// colonnes envoyées ; `dests` : table envoyée -> entrée de la note). `ready` : déjà des Références
// vers la table reçue. `todo` : colonnes créées par le widget (`entry.own`), encore du texte, dont
// le sort n'est pas encore décidé (`entry.linked`) ; elles deviennent des Références si elles sont
// vides (toutes, avec `relink`). `text` : celles qui sont restées du texte parce qu'elles étaient remplies. `undo` : colonnes que le widget avait faites des Références et que la SOURCE n'envoie plus
// avec leur lien (case décochée, table retirée de l'export) : elles redeviennent du texte.
export function planLinks(schema, entry, sent, dests, { relink = false } = {}) {
  if (!schema.has(entry.dest)) return { ready: [], todo: [], undo: [], text: [] };
  const decided = new Set(entry.linked || []);
  const own = new Set(entry.own || []);
  const specs = sent.filter(c => c.link && dests.has(c.link) && schema.has(dests.get(c.link).dest))
    .map(c => linkSpec(schema, entry, c, dests.get(c.link))).filter(Boolean);
  const received = new Set([...dests.values()].map(d => d.dest));
  const undo = sent.filter(c => !c.link && own.has(c.id) && decided.has(c.id)).map((c) => {
    const { to, column } = columnFor(schema, entry, c.id);
    return column && /^Ref(List)?:/.test(column.type) && received.has(column.type.replace(/^Ref(List)?:/, '')) ? { from: c.id, to } : null;
  }).filter(Boolean);
  // Colonnes créées par le widget, restées du texte alors que la SOURCE en garde le lien : déjà remplies quand le sort a
  // été décidé. Avec `relink` (« Refaire les références », sur le clic d'un propriétaire), elles sont à convertir.
  const text = specs.filter(s => s.type === 'Text' && own.has(s.from) && decided.has(s.from));
  return {
    ready: specs.filter(s => s.type === refType(s)),
    todo: specs.filter(s => s.type === 'Text' && own.has(s.from) && (relink || !decided.has(s.from))),
    undo,
    text: relink ? [] : text,
  };
}

// Type d'une colonne qui garde son lien : Référence ou Liste de références vers la table reçue.
const refType = spec => `${spec.list ? 'RefList' : 'Ref'}:${spec.target}`;

// Actions qui font d'une colonne de texte vide une Référence (ou une Liste de références) vers
// `spec.target`, affichant la colonne que la SOURCE affichait (le texte reçu reste dans la description du lot).
export const linkActions = (table, spec) => [
  ['ModifyColumn', table, spec.to, { type: refType(spec) }],
  ['UpdateRecord', '_grist_Tables_column', spec.ref, { visibleCol: spec.shown }],
  ['SetDisplayFormula', table, null, spec.ref, `$${spec.to}.${spec.shownId}`],
];

// Texte seul : le type d'une colonne dont la SOURCE ne garde plus le lien.
export const unlinkActions = (table, specs) => specs.map(spec => ['ModifyColumn', table, spec.to, { type: 'Text' }]);

// Cellules d'une colonne rendue au texte : Grist y a laissé les numéros de ligne (vérifié), et non
// le texte affiché. Chacune reprend le texte de la dernière version reçue de sa ligne (recopiée ou
// non : un renvoi sans changement serait sans effet et laisserait le numéro).
export function textFill({ journalRows, destRows, specs, destTable }) {
  if (!specs.length) return [];
  const latest = latestByKey(journalRows);
  return specs.flatMap((s) => {
    const cells = destRows.map(row => [row.id, latest.get(row[KEY_COL])]).filter(([, v]) => v && Object.hasOwn(v.row, s.from));
    return chunk(cells).map(part => ['BulkUpdateRecord', destTable, part.map(([id]) => id), { [s.to]: part.map(([, v]) => v.row[s.from] ?? '') }]);
  });
}

// Colonnes à décider : `empty` dit si la colonne d'ici n'a aucune valeur. Les vides deviennent des
// Références (`convert`), toutes avec `all` (« Refaire les références ») ; toutes sont notées décidées (`decided`, ids envoyés), pour ne plus
// relire la destination.
export function decideLinks(todo, empty, { all = false } = {}) {
  return { convert: all ? todo : todo.filter(spec => empty(spec.to)), decided: todo.map(spec => spec.from) };
}

// Numéro de la ligne d'ici de chaque clé : Map(clé -> numéro).
export function keyIds(rows) {
  const ids = new Map();
  for (const r of rows) if (!isBlank(r[KEY_COL]) && !ids.has(r[KEY_COL])) ids.set(r[KEY_COL], r.id);
  return ids;
}

// Ce que la recopie sait d'une table d'ici visée par une Référence : numéro de la ligne de chaque clé
// (`keys`, voir keyIds) et numéros de toutes ses lignes (`live`).
export const targetRows = rows => ({ keys: keyIds(rows), live: new Set(rows.map(r => r.id)) });

// Clés citées par une cellule du lot (`Synchro_Cle_<colonne>`) : une clé seule, ou la liste des clés
// d'une Liste de références (['L', …] une fois le lot déplié).
const keysOf = value => (Array.isArray(value) ? value.slice(value[0] === 'L' ? 1 : 0) : isBlank(value) ? [] : [value]);

// Numéros des lignes d'ici qui portent les clés citées, sans doublon, dans l'ordre de la SOURCE.
const idsFor = (value, keys) => [...new Set(keysOf(value).map(k => keys.get(k)).filter(Boolean))];

// Valeur d'une cellule Liste de références : ['L', numéros…], ou vide (la valeur vide de Grist).
const listCell = ids => (ids.length ? ['L', ...ids] : null);

// Éléments d'une cellule Liste de références lue dans la destination.
const cellItems = cell => (Array.isArray(cell) ? cell.slice(cell[0] === 'L' ? 1 : 0) : isBlank(cell) ? [] : [cell]);

// Lignes du journal dont les cellules Référence (`specs`) valent le numéro de la ligne d'ici visée
// (0, la valeur vide de Grist, si elle n'est pas là ou si la version ne porte pas la clé), ou, pour une
// Liste de références, la liste des numéros des lignes d'ici qui sont là (vide si aucune).
// `lookups` : table d'ici visée -> targetRows.
export function resolveLinks(rows, specs, lookups) {
  if (!specs.length) return rows;
  return rows.map((row) => {
    const here = specs.filter(s => Object.hasOwn(row, s.from));
    const value = s => (s.list ? listCell(idsFor(row[linkKey(s.from)], lookups.get(s.target).keys)) : lookups.get(s.target).keys.get(row[linkKey(s.from)]) || 0);
    return here.length ? { ...row, ...Object.fromEntries(here.map(s => [s.from, value(s)])) } : row;
  });
}

// Ce qu'il faut écrire dans la cellule d'une destination, ou rien (undefined) : `want`, le numéro de la ligne visée
// (une Référence) ou les numéros des lignes visées (une Liste de références), tels que la recopie les résout. Une
// Référence est complétée si elle est vide ou vise une ligne qui n'existe plus (effacée puis revenue sous un autre
// numéro) ; une retouche vers une ligne qui existe reste. Une Liste de références, si elle est vide, garde des éléments
// qui ne sont plus là, ou s'il lui manque des lignes visées (arrivées depuis). Une colonne qu'on vient de refaire
// (`relink`) reprend exactement la SOURCE : ce que Grist a laissé de l'ancien texte est remplacé ou vidé.
const fillable = (s, cell, want, live) => (s.list ? fillableList(s, cell, want, live) : fillableRef(s, cell, want, live));

function fillableList(s, cell, want, live) {
  const have = cellItems(cell);
  const same = JSON.stringify(have) === JSON.stringify(want);
  if (s.relink) return same ? undefined : listCell(want);
  const stale = have.some(id => typeof id !== 'number' || !live.has(id));
  const missing = have.length < want.length && have.every(id => want.includes(id));
  return want.length && (!have.length || stale || missing) && !same ? listCell(want) : undefined;
}

function fillableRef(s, cell, want, live) {
  if (s.relink) {
    if (want) return want === cell ? undefined : want;
    return cell && !live.has(cell) ? 0 : undefined;
  }
  return want && want !== cell && (!cell || !live.has(cell)) ? want : undefined;
}

// Cellules à compléter : la dernière version déjà recopiée d'une ligne cite une ligne visée arrivée
// depuis (`journalRows` non résolues, dans l'état où la recopie les a laissées). Voir fillable pour
// ce qui est complété. Cas limite d'une Liste de références : un élément retiré à la main d'une liste
// qui n'a plus que des lignes qui existent est remis au passage suivant (la liste de la SOURCE fait foi).
export function fillLinks({ journalRows, destRows, specs, lookups, destTable }) {
  if (!specs.length) return [];
  const latest = latestByKey(journalRows);
  const updates = new Map(); // colonne d'ici -> [[ligne, valeur]]
  for (const row of destRows) {
    const version = latest.get(row[KEY_COL]);
    if (!version || !isTrue(version.row[APPLIED_COL]) || isTrue(version.row[DELETE_COL])) continue;
    for (const s of specs) {
      const { keys, live } = lookups.get(s.target);
      const cited = version.row[linkKey(s.from)];
      const value = fillable(s, row[s.to], s.list ? idsFor(cited, keys) : keys.get(cited), live);
      if (value !== undefined) updates.set(s.to, [...(updates.get(s.to) || []), [row.id, value]]);
    }
  }
  return [...updates].flatMap(([to, list]) => chunk(list).map(part => ['BulkUpdateRecord', destTable, part.map(([id]) => id), { [to]: part.map(([, value]) => value) }]));
}
