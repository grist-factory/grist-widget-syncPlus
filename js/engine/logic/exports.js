// SOURCE : un export (des tables, leurs colonnes, un filtre de lignes facultatif) et ses lignes
// dans Synchro ; ses destinataires (un webhook filtré sur l'export) ; ce qu'un Échange renvoie. Les
// règles d'accès du lien public sont dans acl.js.
import { AUTHOR_COL, DELETE_COL, EXPORT_COL, HEX16, KEY_COL, KIND, ORDER_COL, RECALC_COL, RESEND_COL, SCHEMA_COL, SENT_TYPE, SYNC_TABLE, TABLE_COL, TYPE_COL, is, parseJson } from './common.js';
import { rowFilter } from './filters.js';
import { columnOptions, ruleStyle, ruleStyles } from './options.js';
import { currencyOf } from './docformat.js';
import { parseRule, ruleRefs } from './rules.js';
import { cleanNote, noteSent, tableNoteOf, withTableNote } from './descriptions.js';
import { isPos, layoutSent, modelSection, withLayout } from './layout.js';
import { formulasOffered, sourceDefault, sourceFormula, withFormulas } from './column-formulas.js';

// Dernier envoi à un destinataire coupé (révoqué, export supprimé, Échange arrêté) : une ligne
// « fin » de son export, envoyée directement à l'adresse de son webhook. Sans elle, la CIBLE, qui ne
// lit pas la SOURCE, ne saurait jamais que plus rien n'arrivera.
export const endNotice = exportId => [{ [EXPORT_COL]: exportId, [TYPE_COL]: KIND.end }];

// Colonnes de données et de formules d'une table SOURCE : hors colonnes de la synchro et colonnes internes de Grist.
const INTERNAL = new Set(['manualSort', KEY_COL, ORDER_COL, RECALC_COL, DELETE_COL]);
const dataColumns = cols => cols.filter(c => !INTERNAL.has(c.colId) && !c.colId.startsWith('gristHelper_'));

// Type sous lequel une colonne part, ou null si elle ne part pas. Une Référence part en texte, un rang
// (PositionNumber) en nombre, un identifiant de ligne (Id) en entier. Un Blob ne part pas (décision d'Antoine,
// 12 novembre) : Grist n'écrit des octets dans une colonne Blob par aucune de ses API (seule une formule Python en
// fabrique), la CIBLE ne pourrait pas les recevoir fidèlement. Tout type que `SENT_TYPE` ne connaît pas est dans le même cas :
// avant, une telle colonne cochée rendait l'invitation illisible chez la CIBLE (`codeInvalid`).
const LIFTED = { PositionNumber: 'Numeric', Id: 'Int' };
export function sentType(type) {
  const sent = /^Ref(List)?:/.test(type) ? 'Text' : (Object.hasOwn(LIFTED, type) ? LIFTED[type] : type);
  return is(SENT_TYPE, sent) ? sent : null;
}

// Colonnes d'une table SOURCE qui ne partent pas faute d'un type que la CIBLE sait recevoir : [{ id, label, type }].
export const unsentColumns = cols => dataColumns(cols).filter(c => !sentType(c.type)).map(c => ({ id: c.colId, label: c.label || c.colId, type: c.type }));

// Colonnes qu'une table SOURCE peut envoyer : toutes ses colonnes de données et formules, hors
// colonnes de la synchro et colonnes internes de Grist. Une Référence part comme le texte qu'elle
// affiche (et, avec `link`, la clé de la ligne visée, voir links.js) ; une colonne Pièces jointes,
// comme la liste de ses fichiers (voir files.js). `opts` : liste de choix et format de la colonne
// (voir options.js), s'il y en a. Avec `extras` (l'export envoie « la mise en forme des colonnes »), `opts`
// porte aussi le style de l'en-tête, la monnaie résolue d'après `doc` (langue et monnaie du document, voir
// docformat.js) et les règles de mise en forme conditionnelle ; chaque colonne est alors marquée `fmt`. Avec `notes`
// (l'export envoie les descriptions des colonnes, voir descriptions.js), chaque colonne porte la sienne dans `desc`.
export function exportableColumns(cols, { extras = false, doc = null, notes = false } = {}) {
  return dataColumns(cols).filter(c => sentType(c.type)).map((c) => {
    const type = sentType(c.type);
    const opts = sourceOptions(c, type, cols, { extras, doc });
    return { id: c.colId, label: c.label || c.colId, type, source: c.type, visible: c.visible || '', ...(opts ? { opts } : {}), ...(extras ? { fmt: true } : {}), ...(notes ? { desc: cleanNote(c.description) } : {}) };
  });
}

// Options à envoyer pour la colonne `c` du schéma (`cols` : toutes les colonnes de sa table, les colonnes
// cachées des règles comprises), pour le type envoyé `type`.
export function sourceOptions(c, type, cols, { extras, doc }) {
  const base = columnOptions(type, c.widgetOptions, { extras });
  if (!extras) return base;
  const opts = { ...(base || {}) };
  const rules = sourceRules(c, cols);
  if (rules.length) opts.rules = rules;
  // Une colonne en monnaie sans monnaie propre prend celle du document : on la dit, la CIBLE n'a pas la même.
  if (opts.numMode === 'currency' && !opts.currency && doc && currencyOf(doc)) opts.currency = currencyOf(doc);
  return Object.keys(opts).length ? columnOptions(type, opts, { extras: true }) : null;
}

// Types dont une règle ne peut pas lire la valeur chez la CIBLE : elle n'y reçoit qu'un texte.
const CONVERTED = /^(Ref(List)?:|Attachments$)/;

// Règles de mise en forme conditionnelle d'une colonne (au niveau de la colonne : celles d'une seule vue
// ne sont pas envoyées), au format envoyé [{ when, <style> }]. Une règle qui lit une Référence ou une
// colonne de pièces jointes, une autre table ou une fonction n'est pas lue (voir rules.js).
function sourceRules(c, cols) {
  const refs = Array.isArray(c.rules) ? c.rules.slice(1) : [];
  const styles = ruleStyles(c.widgetOptions);
  const byRow = new Map(cols.map(x => [x.id, x]));
  const byName = new Map(cols.map(x => [x.colId, x]));
  return refs.map((ref, i) => {
    const tree = parseRule((byRow.get(ref) || {}).formula);
    const plain = tree && ruleRefs(tree).every(id => byName.has(id) && !CONVERTED.test(byName.get(id).type));
    return plain ? { when: byRow.get(ref).formula, ...ruleStyle(styles[i]) } : null;
  }).filter(Boolean);
}

// Ce que les tables `tables` ont à envoyer pour chaque élément des colonnes (voir descriptions.js) : colonnes qui ont une
// mise en forme (`style`) ou une description (`notes`), tables qui ont une description (`tableNote`) ou une page
// dont on peut envoyer la mise en page (`layout`, voir layout.js). `sections` : lignes de `_grist_Views_section`. Sert à
// dire à la personne ce que chaque case envoie vraiment.
export function elementCounts(schema, tables, sections) {
  const columns = (extras) => tables.flatMap(table => exportableColumns(schema.columns(table) || [], { extras, notes: !extras }));
  return {
    style: columns(true).filter(c => c.opts).length,
    notes: columns(false).filter(c => c.desc).length,
    tableNote: tables.filter(table => tableNoteOf(schema.table(table), sections)).length,
    layout: tables.filter(table => modelSection(schema.table(table), sections)).length,
    formulas: tables.reduce((sum, table) => sum + (schema.columns(table) || []).filter(c => sourceFormula(c) || sourceDefault(c)).length, 0),
  };
}

// Règles de la colonne qui lisent une colonne absente de l'export : laissées (la CIBLE ne l'a pas).
export function pruneRules(columns) {
  const ids = new Set(columns.map(c => c.id));
  return columns.map(({ opts, ...c }) => {
    if (!opts || !opts.rules) return opts ? { ...c, opts } : c;
    const { rules, ...rest } = opts;
    const kept = rules.filter(r => ruleRefs(parseRule(r.when)).every(id => ids.has(id)));
    const next = kept.length ? { ...rest, rules: kept } : rest;
    return Object.keys(next).length ? { ...c, opts: next } : c;
  });
}

// La langue et la monnaie du document, portées par la première colonne d'un export qui envoie sa mise en
// forme (la description des colonnes est signée : rien à ajouter au lot). Ancien : un `doc` déjà là est remplacé.
export const withDoc = (columns, doc) => columns.map(({ doc: old, ...c }, i) => (i === 0 && doc && c.fmt ? { ...c, doc } : c));

// Tables que lisent les formules de Synchro pour les tables d'un export (`tables`, voir
// exportTables) : les siennes, et celles d'où vient le texte affiché de ses colonnes Référence.
export const readTables = tables => [...new Set(tables.flatMap(({ table, columns }) => [table,
  ...columns.map(c => (/^Ref(?:List)?:(\w+)$/.exec(c.source || '') || [])[1]).filter(Boolean)]))];

// Colonne Pièces jointes (envoyée ou reçue).
export const isFileColumn = c => c.type === 'Attachments';

// Ce que la SOURCE a changé depuis l'enregistrement de l'export : tables introuvables (renommées
// ou effacées : leurs lignes ne partent plus) et colonnes renommées, effacées ou d'un autre type
// (elles partiraient vides ou fausses). « Modifier » remet l'export d'accord avec les tables.
export function exportDrift(schema, tables) {
  const lost = tables.filter(tb => !schema.has(tb.table)).map(tb => tb.table);
  const present = tables.filter(tb => schema.has(tb.table));
  const changed = present.flatMap(({ table, columns }) => {
    const current = new Map(exportableColumns(schema.columns(table)).map(c => [c.id, c]));
    return columns.filter((c) => {
      const cur = current.get(c.id);
      return !cur || cur.source !== (c.source || c.type) || (cur.visible || '') !== (c.visible || '');
    }).map(c => `${table}.${c.id}`);
  });
  return { lost, changed };
}

// Le détail de `changed` (voir exportDrift), une ligne par colonne : `gone` (n'existe plus : supprimée ou renommée), `retyped` (autre type :
// `was`, `now`), `shown` (la colonne qu'elle affiche a changé). Une colonne disparue qui a un seul pendant, du même type, parmi les
// colonnes envoyables non envoyées, porte `to` (elle a sans doute été renommée) : jamais une certitude, la personne décide.
export const driftDetails = (schema, tables) => tables.filter(tb => schema.has(tb.table)).flatMap(driftOf(schema));

const typeOf = c => c.source || c.type;
const driftOf = schema => ({ table, columns }) => {
  const current = new Map(exportableColumns(schema.columns(table)).map(c => [c.id, c]));
  const sent = new Set(columns.map(c => c.id));
  const unsent = [...current.values()].filter(c => !sent.has(c.id));
  const gone = columns.filter(c => !current.has(c.id));
  return columns.flatMap((c) => {
    const cur = current.get(c.id);
    if (!cur) {
      const twins = unsent.filter(u => typeOf(u) === typeOf(c));
      const alike = gone.filter(g => typeOf(g) === typeOf(c));
      return [{ table, id: c.id, kind: 'gone', ...(twins.length === 1 && alike.length === 1 ? { to: twins[0].id } : {}) }];
    }
    if (cur.source !== typeOf(c)) return [{ table, id: c.id, kind: 'retyped', was: typeOf(c), now: cur.source }];
    return (cur.visible || '') !== (c.visible || '') ? [{ table, id: c.id, kind: 'shown' }] : [];
  });
};

// ---------------------------------------------------------------------------------------------
// Lignes Synchro d'un export

const SYNC_FIELDS = [EXPORT_COL, TABLE_COL, TYPE_COL, SCHEMA_COL, RESEND_COL];

// Valeur de Synchro_Colonnes voulue pour chaque type de ligne d'une table : ses colonnes, ou son
// filtre (ligne 'filtre', seulement s'il y en a un).
// Ce qui s'ajoute à une colonne quand l'export envoie format et descriptions (`withOpts`) ; l'ordre des clés est celui du texte.
const textExtras = ({ opts, fmt, doc, desc, tdesc, pos, fx, fd }) => ({
  ...(opts ? { opts } : {}), ...(fmt ? { fmt: true } : {}), ...(doc ? { doc } : {}),
  ...(typeof desc === 'string' ? { desc } : {}), ...(typeof tdesc === 'string' ? { tdesc } : {}),
  ...(isPos(pos) ? { pos } : {}),
  ...(typeof fx === 'string' ? { fx } : {}),
  ...(typeof fd === 'string' && fd ? { fd } : {}),
});
const columnText = (column, withOpts) => {
  const { id, type, label, source, visible, as, link, list } = column;
  const head = { id, type, label, source, visible, ...(as ? { as } : {}), ...(link ? { link } : {}), ...(link && list === true ? { list: true } : {}) };
  return withOpts ? { ...head, ...textExtras(column) } : head;
};
const schemaText = (columns, withOpts = true) => JSON.stringify(columns.map(column => columnText(column, withOpts)));
// Avec un filtre de lignes, la liste des choix d'une colonne ne part pas : elle montrerait des
// valeurs de lignes que le filtre retient pas. Le format part ; la CIBLE complète sa liste des
// valeurs qu'elle reçoit (voir receivedChoices).
const filteredColumns = ({ columns, filter }) => (rowFilter(filter) ? columns.map(({ opts, ...c }) => {
  const { choices, choiceOptions, ...format } = opts || {};
  return Object.keys(format).length ? { ...c, opts: format } : c;
}) : columns);
function wantedValues({ columns, filter }, kinds) {
  const schema = schemaText(filteredColumns({ columns, filter }));
  const kept = rowFilter(filter);
  return new Map([...kinds.map(kind => [kind, schema]), ...(kept ? [[KIND.filter, JSON.stringify(kept)]] : [])]);
}

// Table nouvelle, aux colonnes changées ou au filtre changé : ses lignes sont à renvoyer. Une liste
// de choix ou un format changé ne renvoie rien : la description des colonnes suffit.
const withoutOpts = text => schemaText(parseJson(text, []) || [], false);
function tableChanged(here, values) {
  const filterWas = (here.find(r => r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL] || '';
  return !here.length || here.some(r => r[TYPE_COL] !== KIND.filter && withoutOpts(r[SCHEMA_COL]) !== withoutOpts(values.get(KIND.keys)))
    || filterWas !== (values.get(KIND.filter) || '');
}

// Lignes Synchro d'un export : par table, sa liste des clés, son lot, son suivi des clés, son
// filtre s'il en a un, la liste de ses fichiers si elle envoie des pièces jointes, et son
// instantané complet avec son empreinte s'il est partagé par lien public ; un export en Échange
// (`swap`) a en plus sa ligne 'echange' (sans table) ; sa ligne 'signature' reste telle quelle (voir
// signingKey). `rows` : lignes Synchro existantes. Rend les actions qui amènent l'export à `tables`
// ([{ table, columns, filter }], colonnes de `exportableColumns`) et `changed`, les tables dont les
// lignes sont à renvoyer.
export function exportRowsActions(rows, exportId, tables, { isPublic = false, swap = false } = {}) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId);
  const kinds = [KIND.keys, KIND.lot, KIND.track, ...(isPublic ? [KIND.full, KIND.mark] : [])];
  const wanted = [];
  const changed = [];
  for (const tb of tables) {
    const values = wantedValues(tb, tb.columns.some(isFileColumn) ? [...kinds, KIND.files] : kinds);
    const here = mine.filter(r => r[TABLE_COL] === tb.table);
    if (tableChanged(here, values)) changed.push(tb.table);
    for (const [kind, value] of values) wanted.push({ table: tb.table, kind, value, row: here.find(r => r[TYPE_COL] === kind) });
  }
  if (swap) wanted.push({ table: '', kind: KIND.swap, value: '', row: mine.find(r => r[TYPE_COL] === KIND.swap) });
  const keys = new Set(wanted.map(w => `${w.table}|${w.kind}`));
  const add = wanted.filter(w => !w.row)
    .map(w => ({ [EXPORT_COL]: exportId, [TABLE_COL]: w.table, [TYPE_COL]: w.kind, [SCHEMA_COL]: w.value, [RESEND_COL]: '' }));
  const update = wanted.filter(w => w.row && w.kind !== KIND.swap && w.row[SCHEMA_COL] !== w.value);
  const remove = mine.filter(r => r[TYPE_COL] !== KIND.sign && !keys.has(`${r[TABLE_COL]}|${r[TYPE_COL]}`)).map(r => r.id);
  const actions = [];
  if (add.length) actions.push(['BulkAddRecord', SYNC_TABLE, add.map(() => null), Object.fromEntries(SYNC_FIELDS.map(c => [c, add.map(r => r[c])]))]);
  if (update.length) actions.push(['BulkUpdateRecord', SYNC_TABLE, update.map(w => w.row.id), { [SCHEMA_COL]: update.map(w => w.value) }]);
  if (remove.length) actions.push(['BulkRemoveRecord', SYNC_TABLE, remove]);
  return { actions, changed };
}

// Tables, colonnes et filtres d'un export, lus dans ses lignes Synchro.
export function exportTables(rows, exportId) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId && r[TYPE_COL] !== KIND.swap && r[TYPE_COL] !== KIND.sign);
  const tables = new Map();
  for (const r of mine) {
    if (r[TYPE_COL] !== KIND.filter && !tables.has(r[TABLE_COL])) tables.set(r[TABLE_COL], parseJson(r[SCHEMA_COL], []) || []);
  }
  const filterOf = table => rowFilter(parseJson((mine.find(r => r[TABLE_COL] === table && r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL], null));
  return [...tables].map(([table, columns]) => ({ table, columns, filter: filterOf(table) }));
}

// Listes de choix, formats et descriptions changés dans les tables d'un export depuis son enregistrement : la
// description des colonnes de ses lignes Synchro est réécrite, sans renvoi de lignes (la CIBLE la
// lit à la prochaine ligne reçue). Les options se lisent pour le type envoyé (voir options.js). `sections` :
// lignes de `_grist_Views_section` (la description d'une table s'y trouve), lues seulement si un export envoie
// celle de sa table ou la mise en page de ses colonnes ; sans elles, la description de table envoyée reste telle quelle.
// `fields` : lignes de `_grist_Views_section_field` (la mise en page, voir layout.js), lues seulement si un export l'envoie.
const SCHEMA_KINDS = [KIND.keys, KIND.lot, KIND.track, KIND.full, KIND.mark, KIND.files];
export function optionsActions(rows, schema, doc = null, sections = null, fields = null) {
  const ids = [];
  const values = [];
  for (const exportId of new Set(rows.map(r => r[EXPORT_COL]))) {
    for (const { table, columns, filter } of exportTables(rows, exportId).filter(tb => schema.has(tb.table))) {
      const live = schema.columns(table);
      const here = new Map(live.map(c => [c.colId, c]));
      const extras = columns.some(c => c.fmt);
      const fresh = columns.map(({ opts, desc, ...c }) => {
        const next = here.has(c.id) ? sourceOptions(here.get(c.id), c.type, live, { extras, doc }) : opts;
        const note = typeof desc === 'string' ? { desc: here.has(c.id) ? cleanNote(here.get(c.id).description) : desc } : {};
        return { ...c, ...(next ? { opts: next } : {}), ...note };
      });
      const sent = noteSent(columns);
      const styled = extras ? withDoc(pruneRules(fresh), doc) : fresh;
      const described = sent.table && sections ? withTableNote(styled, tableNoteOf(schema.table(table), sections)) : styled;
      const formulas = formulasOffered(columns) ? withFormulas(described, live) : described;
      const laidOut = layoutSent(columns) && sections && fields ? withLayout(formulas, live, schema.table(table), sections, fields) : formulas;
      const value = schemaText(filteredColumns({ columns: laidOut, filter }));
      for (const r of rows.filter(x => x[EXPORT_COL] === exportId && x[TABLE_COL] === table && SCHEMA_KINDS.includes(x[TYPE_COL]) && x[SCHEMA_COL] !== value)) {
        ids.push(r.id);
        values.push(value);
      }
    }
  }
  return ids.length ? [['BulkUpdateRecord', SYNC_TABLE, ids, { [SCHEMA_COL]: values }]] : [];
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

// Un envoi qui attend la réponse du destinataire depuis plus de ce délai (ms) : Grist n'a pas de délai à lui
// (il abandonne au bout de cinq minutes, puis retente), et la file du document attend pendant ce temps.
export const SLOW_MS = 180000;
const waitingTooLong = (u, now) => u.status === 'sending' && u.updatedTime > 0 && now - u.updatedTime > SLOW_MS;

// État d'un destinataire, lu dans l'état d'envoi que Grist donne à son webhook (`usage`) :
// [état, ton de la pastille]. `postponed` : un envoi échoué vingt fois est repoussé en fin de file, il échoue
// toujours ; `sending` depuis trop longtemps : le destinataire ne répond pas.
export function hookStatus(h, now = Date.now()) {
  if (!h.fields.enabled) return ['paused', 'off'];
  const u = h.usage || {};
  const failing = ['retrying', 'error', 'postponed', 'invalid'].includes(u.status) || u.lastHttpStatus >= 400 || waitingTooLong(u, now);
  return failing ? ['error', 'err'] : ['active', 'ok'];
}

// Statut HTTP de l'échec en cours, 0 si le serveur n'a pas répondu (connexion refusée, coupée). `lastHttpStatus`
// garde le dernier statut vu, celui d'un envoi réussi avant la panne comprise (200 après une connexion coupée) :
// c'est le dernier lot qui dit ce qui vient d'arriver.
export function failureStatus(h) {
  const u = h.usage || {};
  const batch = u.lastEventBatch;
  if (batch && batch.status !== 'success') return batch.httpStatus || 0;
  return u.lastHttpStatus || 0;
}

// Message d'erreur de l'échec en cours (celui du dernier lot, sinon le dernier message du webhook).
function failureMessage(h) {
  const u = h.usage || {};
  const batch = u.lastEventBatch;
  return String((batch && batch.status !== 'success' && batch.errorMessage) || u.lastErrorMessage || '');
}

// Envoi en cours chez ce destinataire (des envois attendent, ou un envoi part ou est retenté) : l'état de la
// carte peut changer sans que personne ne touche à rien (échec, envoi qui n'obtient pas de réponse), elle se relit.
export const hookBusy = h => Boolean(h.fields.enabled) && (((h.usage || {}).numWaiting || 0) > 0 || ['sending', 'retrying', 'postponed'].includes((h.usage || {}).status));

// Destinataire dont l'envoi échoue : Grist n'a qu'une file d'envoi par document et la rejoue dans l'ordre, un
// envoi qui échoue est retenté jusqu'à un quart d'heure avant de passer son tour, donc les autres destinataires
// du document (de tous ses exports) attendent derrière lui. Null si aucun n'échoue.
export const queueBlocker = hooks => hooks.find(h => hookStatus(h)[0] === 'error') || null;

// Lot refusé pour sa taille. L'état d'un webhook est remis à zéro quand la file est vidée, mais un
// envoi en vol peut encore y écrire son échec : seul compte l'envoi que Grist retente.
export function tooLarge(h) {
  const u = h.usage || {};
  return ['retrying', 'postponed'].includes(u.status) && (u.lastEventBatch || {}).httpStatus === 413;
}

// Erreur d'envoi d'un destinataire : clé du texte qui la dit simplement, avec ce qu'il faut faire. Quota (429),
// erreur du serveur (5xx), serveur injoignable ou muet : Grist retente seul, le texte le dit et dit ce que
// coûte l'attente aux autres destinataires du document.
export function hookErrorKey(h, now = Date.now()) {
  const u = h.usage || {};
  const status = failureStatus(h);
  if (status === 413) return 'send.error.size';
  if (/Invalid column/i.test(u.lastErrorMessage || '')) return 'send.error.column';
  if (status === 404 && /Table not found/i.test(failureMessage(h))) return 'send.error.journal';
  if ([401, 403, 404].includes(status)) return 'send.error.link';
  if (status === 429 || /too many requests|rate.?limit/i.test(u.lastErrorMessage || '')) return 'send.error.rate';
  if (status >= 500) return 'send.error.server';
  if (waitingTooLong(u, now)) return 'send.error.slow';
  return !status && u.lastErrorMessage ? 'send.error.network' : 'send.error.other';
}

// Lien de réception mort (clé de formulaire inconnue, réception arrêtée) : l'envoi échoue et échouera toujours.
export const DEAD_KEYS = ['send.error.link', 'send.error.journal'];

// Pourquoi le widget met ce destinataire en pause d'office : 'link' (lien ou journal mort), 'slow' (un envoi attend
// une réponse qui ne vient pas : Grist n'a pas de délai, vu au test de charge, 20 minutes sans reprise et la file
// du document bloquée), '' sinon. Les erreurs qui passent d'elles-mêmes (quota, panne passagère) n'en sont pas.
export function autoPauseKind(h, now = Date.now()) {
  if (!h.fields.enabled || hookStatus(h, now)[0] !== 'error') return '';
  const key = hookErrorKey(h, now);
  if (DEAD_KEYS.includes(key)) return 'link';
  return key === 'send.error.slow' ? 'slow' : '';
}

// Erreurs que vider la file ne règle pas (l'envoi suivant échouerait de la même façon) : ce qui aide, c'est la
// pause, qui libère les autres destinataires, ou d'attendre.
export const NO_UNBLOCK = ['send.error.link', 'send.error.journal', 'send.error.rate', 'send.error.server', 'send.error.network', 'send.error.slow'];

// État d'un export pour sa carte : [clé de la pastille, ton]. `exp` : { recipients, invitations,
// public, echange, retour }.
export function exportStatus(exp) {
  if (exp.recipients.some(h => hookStatus(h)[0] === 'error')) return ['error', 'err'];
  if (exp.recipients.length && exp.echange && !exp.retour) return ['participants', 'ok'];
  if (exp.recipients.length || exp.public) return ['people', 'ok'];
  return exp.invitations.length ? ['invited', 'pending'] : ['alone', 'off'];
}

// Mémo d'un webhook : la fiche du destinataire, « e-mail · document · équipe/nom du document »
// (voir memoMatches). Le nom, lu chez Grist à l'approbation, perd ses « · » ; le mémo d'un webhook
// d'avant la 0.10.1 s'arrête à l'équipe.
const memoText = text => String(text || '').replace(/\s*·\s*/g, ' - ').trim();
export const hookMemo = ({ email, docId, team, docName }) => {
  const name = memoText(docName);
  return [email, docId, name ? `${team || ''}/${name}` : team].filter(Boolean).join(' · ');
};

// Fiche d'un destinataire à l'écran : son mémo, l'équipe suivie du nom du document. `docName` : le
// nom vu chez Grist au dernier contrôle (voir checkHooks), qui l'emporte sur celui du mémo (document
// renommé) et complète un mémo qui n'en a pas.
export function hookLabel(memo, docName = '') {
  const parts = String(memo || '').split(' · ').filter(Boolean);
  let at = parts.findIndex(p => p.includes('/'));
  if (at < 0 && parts.length === 3) at = 2;
  const place = at < 0 ? '' : parts[at];
  const team = place.split('/')[0];
  const name = memoText(docName) || place.slice(team.length + 1);
  const shown = [team, name].filter(Boolean).join('/');
  if (at < 0) return [...parts, shown].filter(Boolean).join(' · ');
  return parts.map((p, i) => (i === at ? shown : p)).filter(Boolean).join(' · ');
}

// Document d'un destinataire d'après son mémo : { email, docId, team, name } (chaînes vides si absents), pour refaire
// l'adresse du document (voir docUrl). Même lecture que hookLabel : le mémo d'avant la 0.10.1 s'arrête à l'équipe
// (troisième morceau sans « / »), et l'e-mail peut manquer.
export function memoDoc(memo) {
  const parts = String(memo || '').split(' · ').filter(Boolean);
  const email = parts.find(p => p.includes('@')) || '';
  const rest = parts.filter(p => p !== email);
  const placeOnly = rest.length === 1 && rest[0].includes('/');
  const place = (placeOnly ? rest[0] : rest[1]) || '';
  const team = place.split('/')[0];
  return { email, docId: placeOnly ? '' : rest[0] || '', team, name: place.slice(team.length + 1) };
}

// Journal de retour d'un participant (webhook `hook`) : noté à l'approbation (`hook`) ; pour un
// Échange branché avant, retrouvé par le document de la fiche, cité dans le mémo du webhook.
export const ownJournal = hook => ({ note }) => note.hook === hook.id
  || (!note.hook && Boolean((note.from || {}).docId) && (hook.fields.memo || '').split(' · ').includes(note.from.docId));

// E-mail de la personne qui a créé l'export (colonne Sync_Par de ses lignes Synchro).
export const exportEmail = (rows, exportId) => (rows.find(r => r[EXPORT_COL] === exportId) || {})[AUTHOR_COL] || '';

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
    // Les colonnes Pièces jointes reviennent aussi : leurs fichiers repartent par la ligne `fichiers` de
    // cet export (voir files.js), vers le journal de retour de la SOURCE, qui n'écrit que les colonnes
    // que son export envoie.
    const columns = (columnsOf(entry.dest) || []).filter(c => back.has(c.id)).map(c => ({ ...c, as: back.get(c.id) }));
    return { table: entry.dest, columns, filter: null };
  }).filter(tb => tb.columns.length);
}

// Export de retour d'un Échange, côté CIBLE : les destinations de la note du journal, avec leurs
// colonnes actuelles.
export const returnExportTables = (note, schema) => exchangeTables(note.tables, dest => exportableColumns(schema.columns(dest) || []));

// Côté SOURCE (journal de retour) : colonnes reçues de l'autre document gardées, et leur
// correspondance (colonne de l'autre document -> d'ici), lue dans leur nom ici (`as`) ; un choix
// noté dans `map` l'emporte. L'autre document n'écrit que les colonnes que l'export d'ici envoie
// pour cette table (`allowed`) : ni une colonne gardée pour soi, ni une colonne nouvelle.
export function exchangeColumns(sent, allowed, map = {}) {
  const target = c => map[c.id] || c.as || c.id;
  const kept = sent.filter(c => allowed.has(target(c)));
  return { sent: kept, map: Object.fromEntries(kept.map(c => [c.id, target(c)])) };
}
