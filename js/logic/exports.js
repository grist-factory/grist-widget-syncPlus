// SOURCE : un export (des tables, leurs colonnes, un filtre de lignes facultatif) et ses lignes
// dans Synchro ; ses destinataires (un webhook filtré sur l'export) ; son lien public (règles
// d'accès) ; ce qu'un Échange renvoie.
import { COL_ID, DELETE_COL, EXPORT_COL, HEX16, KEY_COL, KIND, ORDER_COL, RECALC_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, is, parseJson } from './common.js';

// Colonnes qu'une table SOURCE peut envoyer : toutes ses colonnes de données et formules, hors
// colonnes de la synchro et colonnes internes de Grist. Les pièces jointes ne peuvent pas partir
// (`blocked`). Une Référence part comme le texte qu'elle affiche.
export function exportableColumns(cols) {
  const skip = new Set(['manualSort', KEY_COL, ORDER_COL, RECALC_COL, DELETE_COL]);
  return cols.filter(c => !skip.has(c.colId) && !c.colId.startsWith('gristHelper_')).map(c => ({
    id: c.colId, label: c.label || c.colId, type: /^Ref(List)?:/.test(c.type) ? 'Text' : c.type, source: c.type,
    visible: c.visible || '', blocked: c.type === 'Attachments',
  }));
}

// Filtre de lignes d'une table : n'envoyer que les lignes dont la colonne `id` vaut `value` (texte
// affiché, sans tenir compte des majuscules ; une case à cocher vaut « oui » ou « non »). Rend le
// filtre tel que la formule le lit, ou null s'il est vide ou mal formé.
const YES = ['oui', 'yes', 'vrai', 'true', '1', 'x'];
export function rowFilter(filter) {
  if (!filter || !COL_ID.test(String(filter.id || ''))) return null;
  const source = String(filter.source || '');
  const text = String(filter.value ?? '').trim().toLowerCase();
  const value = source === 'Bool' ? (YES.includes(text) ? 'oui' : 'non') : text;
  return { id: filter.id, source, visible: String(filter.visible || ''), value };
}

// ---------------------------------------------------------------------------------------------
// Lignes Synchro d'un export

const SYNC_FIELDS = [EXPORT_COL, TABLE_COL, TYPE_COL, SCHEMA_COL, RESEND_COL];

// Valeur de Synchro_Colonnes voulue pour chaque type de ligne d'une table : ses colonnes, ou son
// filtre (ligne 'filtre', seulement s'il y en a un).
function wantedValues({ columns, filter }, kinds) {
  const schema = JSON.stringify(columns.map(({ id, type, label, source, visible, as }) => ({ id, type, label, source, visible, ...(as ? { as } : {}) })));
  const kept = rowFilter(filter);
  return new Map([...kinds.map(kind => [kind, schema]), ...(kept ? [[KIND.filter, JSON.stringify(kept)]] : [])]);
}

// Table nouvelle, aux colonnes changées ou au filtre changé : ses lignes sont à renvoyer.
function tableChanged(here, values) {
  const filterWas = (here.find(r => r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL] || '';
  return !here.length || here.some(r => r[TYPE_COL] !== KIND.filter && r[SCHEMA_COL] !== values.get(KIND.keys))
    || filterWas !== (values.get(KIND.filter) || '');
}

// Lignes Synchro d'un export : par table, sa liste des clés, son lot, son suivi des clés, son
// filtre s'il en a un, et son instantané complet avec son empreinte s'il est partagé par lien
// public ; un export en Échange (`swap`) a en plus sa ligne 'echange' (sans table). `rows` : lignes
// Synchro existantes. Rend les actions qui amènent l'export à `tables` ([{ table, columns, filter }],
// colonnes de `exportableColumns`) et `changed`, les tables dont les lignes sont à renvoyer.
export function exportRowsActions(rows, exportId, tables, { isPublic = false, swap = false } = {}) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId);
  const kinds = [KIND.keys, KIND.lot, KIND.track, ...(isPublic ? [KIND.full, KIND.mark] : [])];
  const wanted = [];
  const changed = [];
  for (const tb of tables) {
    const values = wantedValues(tb, kinds);
    const here = mine.filter(r => r[TABLE_COL] === tb.table);
    if (tableChanged(here, values)) changed.push(tb.table);
    for (const [kind, value] of values) wanted.push({ table: tb.table, kind, value, row: here.find(r => r[TYPE_COL] === kind) });
  }
  if (swap) wanted.push({ table: '', kind: KIND.swap, value: '', row: mine.find(r => r[TYPE_COL] === KIND.swap) });
  const keys = new Set(wanted.map(w => `${w.table}|${w.kind}`));
  const add = wanted.filter(w => !w.row)
    .map(w => ({ [EXPORT_COL]: exportId, [TABLE_COL]: w.table, [TYPE_COL]: w.kind, [SCHEMA_COL]: w.value, [RESEND_COL]: '' }));
  const update = wanted.filter(w => w.row && w.kind !== KIND.swap && w.row[SCHEMA_COL] !== w.value);
  const remove = mine.filter(r => !keys.has(`${r[TABLE_COL]}|${r[TYPE_COL]}`)).map(r => r.id);
  const actions = [];
  if (add.length) actions.push(['BulkAddRecord', SYNC_TABLE, add.map(() => null), Object.fromEntries(SYNC_FIELDS.map(c => [c, add.map(r => r[c])]))]);
  if (update.length) actions.push(['BulkUpdateRecord', SYNC_TABLE, update.map(w => w.row.id), { [SCHEMA_COL]: update.map(w => w.value) }]);
  if (remove.length) actions.push(['BulkRemoveRecord', SYNC_TABLE, remove]);
  return { actions, changed };
}

// Montage d'avant la version 0.5 : le suivi des clés manque aux tables des exports. Rend l'action
// qui l'ajoute (le suivi part des clés présentes : rien n'est effacé dans les CIBLES), ou null.
export function addTrackRowsAction(rows) {
  const has = new Set(rows.filter(r => r[TYPE_COL] === KIND.track).map(r => `${r[EXPORT_COL]}|${r[TABLE_COL]}`));
  const add = rows.filter(r => r[TYPE_COL] === KIND.keys && !has.has(`${r[EXPORT_COL]}|${r[TABLE_COL]}`));
  if (!add.length) return null;
  const cols = [EXPORT_COL, TABLE_COL, SCHEMA_COL];
  return ['BulkAddRecord', SYNC_TABLE, add.map(() => null),
    { ...Object.fromEntries(cols.map(c => [c, add.map(r => r[c] ?? '')])), [TYPE_COL]: add.map(() => KIND.track), [RESEND_COL]: add.map(() => '') }];
}

// Tables, colonnes et filtres d'un export, lus dans ses lignes Synchro.
export function exportTables(rows, exportId) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId && r[TYPE_COL] !== KIND.swap);
  const tables = new Map();
  for (const r of mine) {
    if (r[TYPE_COL] !== KIND.filter && !tables.has(r[TABLE_COL])) tables.set(r[TABLE_COL], parseJson(r[SCHEMA_COL], []) || []);
  }
  const filterOf = table => rowFilter(parseJson((mine.find(r => r[TABLE_COL] === table && r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL], null));
  return [...tables].map(([table, columns]) => ({ table, columns, filter: filterOf(table) }));
}

// Exports en Échange : ceux qui ont une ligne 'echange'.
export const swapExports = rows => new Set(rows.filter(r => r[TYPE_COL] === KIND.swap).map(r => r[EXPORT_COL]));

// ---------------------------------------------------------------------------------------------
// Destinataires

// Condition du webhook d'un destinataire : Grist ne lui envoie que les lignes de son export.
const conditionOf = exportId => `rec.${EXPORT_COL} == "${exportId}" and rec.${TYPE_COL} in ("${KIND.keys}", "${KIND.lot}")`;
// L'identifiant entre dans une formule Python : rien d'autre que 16 chiffres hexadécimaux.
export function exportCondition(exportId) {
  if (!is(HEX16, exportId)) throw new Error('codeInvalid');
  return conditionOf(exportId);
}

// Export d'un webhook, lu dans sa condition ; '' si elle n'a pas exactement la forme attendue
// (webhook à ne pas laisser : il recevrait d'autres lignes que celles d'un export).
export function conditionExport(text) {
  const [before, after] = conditionOf('\u0000').split('\u0000');
  const s = String(text || '');
  if (!s.startsWith(before) || !s.endsWith(after)) return '';
  const id = s.slice(before.length, s.length - after.length);
  return HEX16.test(id) ? id : '';
}

// Nom du webhook d'un destinataire : lisible dans les réglages de Grist, avec l'export en fin.
export const hookName = (name, exportId) => `Synchro ${name} #${exportId}`;

// Destinataires d'un export : les webhooks sur Synchro dont la condition nomme cet export
// (`conditions` : texte de la condition par webhook).
export const hooksOf = (hooks, conditions, exportId) =>
  hooks.filter(h => h.fields.tableId === SYNC_TABLE && conditionExport(conditions.get(h.id)) === exportId);

// ---------------------------------------------------------------------------------------------
// Échange

// Côté CIBLE : ce que ce document renvoie à la SOURCE. Chaque destination (`entries` : tables de la
// note du journal) part avec les colonnes qui reçoivent une colonne de la SOURCE, chacune avec son
// nom là-bas (`as`). `columnsOf(table)` : ses colonnes envoyables.
export function exchangeTables(entries, columnsOf) {
  return entries.map((entry) => {
    const map = entry.map || {};
    const back = new Map([...new Set([...(entry.columns || []).map(c => c.id), ...Object.keys(map)])].map(id => [map[id] || id, id]));
    const columns = (columnsOf(entry.dest) || []).filter(c => !c.blocked && back.has(c.id)).map(c => ({ ...c, as: back.get(c.id) }));
    return { table: entry.dest, columns, filter: null };
  }).filter(tb => tb.columns.length);
}

// Côté SOURCE (journal de retour) : colonnes reçues de l'autre document gardées, et leur
// correspondance (colonne de l'autre document -> d'ici), lue dans leur nom ici (`as`) ; un choix
// noté dans `map` l'emporte. L'autre document n'écrit que les colonnes que l'export d'ici envoie
// pour cette table (`allowed`) : ni une colonne gardée pour soi, ni une colonne nouvelle.
export function exchangeColumns(sent, allowed, map = {}) {
  const target = c => map[c.id] || c.as || c.id;
  const kept = sent.filter(c => allowed.has(target(c)));
  return { sent: kept, map: Object.fromEntries(kept.map(c => [c.id, target(c)])) };
}

// ---------------------------------------------------------------------------------------------
// Lien public : règles d'accès qui ne laissent aux lecteurs (dont le lien public) que les lignes
// 'complet' et 'empreinte' des exports `exportIds` dans la table Synchro, sans la colonne
// Synchro_Export : un lecteur lirait sinon sa description, la note de la SOURCE (noms des exports,
// invitations en attente ; vérifié). Le filtre sur cette colonne marche encore (vérifié). Les
// règles du widget portent ce mémo ; elles passent avant les règles existantes. Sans export,
// `keepDeny` garde le refus général : à utiliser tant que le document reste partagé publiquement.
export const PUBLIC_MEMO = 'Synchro : lecture limitée aux exports publics';
const LEGACY_MEMO = 'Synchro : lecture limitée aux vues d’export';
const VIEWER_ONLY = 'user.Access == VIEWER';

export const isPublicRule = r => r.memo === PUBLIC_MEMO || r.memo === LEGACY_MEMO;

// Règles voulues : [{ tableId, colIds, aclFormula, permissionsText }], dans l'ordre.
export function publicAclRules(exportIds, { keepDeny = false } = {}) {
  const ids = exportIds.filter(id => HEX16.test(id)).sort();
  if (!ids.length && !keepDeny) return [];
  return [
    ...(ids.length ? [
      { tableId: SYNC_TABLE, colIds: EXPORT_COL, aclFormula: VIEWER_ONLY, permissionsText: '-R' },
      { tableId: SYNC_TABLE, colIds: '*', permissionsText: '+R',
        aclFormula: `${VIEWER_ONLY} and rec.${EXPORT_COL} in [${ids.map(id => `"${id}"`).join(', ')}] and rec.${TYPE_COL} in ["${KIND.full}", "${KIND.mark}"]` },
    ] : []),
    { tableId: '*', colIds: '*', aclFormula: VIEWER_ONLY, permissionsText: '-R' },
  ];
}

// Une règle, telle que la compare syncPublicRules.
export const ruleText = ({ tableId, colIds, aclFormula, permissionsText }) => `${tableId}|${colIds}|${aclFormula}|${permissionsText}`;

// Actions qui remplacent les règles du widget par les règles voulues. `resources`, `rules` : lignes
// de _grist_ACLResources et _grist_ACLRules.
export function publicAclActions(resources, rules, exportIds, options = {}) {
  const actions = [['BulkRemoveRecord', '_grist_ACLRules', rules.filter(isPublicRule).map(r => r.id)]].filter(a => a[2].length);
  let pos = Math.min(0, ...rules.map(r => r.rulePos || 0));
  let newRef = 0;
  const resourceFor = (tableId, colIds) => {
    const found = resources.find(r => r.tableId === tableId && r.colIds === colIds);
    if (found) return found.id;
    actions.push(['AddRecord', '_grist_ACLResources', --newRef, { tableId, colIds }]);
    return newRef;
  };
  for (const { tableId, colIds, aclFormula, permissionsText } of publicAclRules(exportIds, options)) {
    actions.push(['AddRecord', '_grist_ACLRules', null, { resource: resourceFor(tableId, colIds), aclFormula, permissionsText, rulePos: --pos, memo: PUBLIC_MEMO }]);
  }
  return actions;
}
