// CIBLE : le journal d'un export. Le webhook y dépose des lignes de Synchro (« brutes ») ; le widget
// les déplie en une ligne par version ou par liste des clés, puis les recopie (consolidation.js) et
// nettoie le journal.
// Le lien du formulaire permet d'écrire n'importe quoi dans le journal. Chaque réception a sa clé
// (un formulaire par page) : seul l'expéditeur de l'export l'a, et il décide déjà de ce qu'il
// envoie. Une ligne brute qui ne peut pas venir du webhook de cet export est tout de même effacée
// sans effet et comptée, et rien de ce qui est lu ne peut servir de nom propre aux objets JavaScript.
import {
  APPLIED_COL, BEFORE_COL, BUCKETS, DATA_COL, DELETE_COL, EXPORT_COL, KEY_COL, KIND, LIST_COL, LIST_PREFIX, LOT_COL, ORDER_COL, RECEIVED_COL, RESEND_COL,
  SCHEMA_COL, STATE_COL, TABLE_COL, TYPE_COL, chunk, groupBy, isBlank, isSafeId, isTrue, parseJson,
} from './common.js';
import { exportSchema, validColumns } from './codes.js';

const MAX_LINES = 100000; // lignes par lot, au plus (un envoi fait au plus 1 Mo, un instantané public 2 Mo)
const MAX_BIG = 1000; // clés de lignes trop grosses retenues par table
const MAX_TABLES = 200; // tables suivies dans la note d'un journal

// Ligne telle que déposée par le webhook (ou le lien public) : une liste des clés ou un lot.
export const isRaw = row => !isBlank(row[TYPE_COL]);

// Note d'un journal (description de sa colonne Synchro_Ids) : { id, export, name, secret, from,
// mode, base, retour, tables: [{ table, dest, columns, map, match, label, refs }], refused, missing,
// big, tooBig, suspect }. Le journal de retour d'un Échange (`retour`, côté du document qui a
// invité) attend la réponse (`from` encore vide) avant de recopier quoi que ce soit.
export const awaitingPartner = note => note.mode === 'echange' && Boolean(note.retour) && !(note.from || {}).docId;

// ---------------------------------------------------------------------------------------------
// Lecture des listes et des lots

// Liste reçue (Synchro_Ids d'une ligne 'cles') : { buckets: { t, keys: Map(seau -> Set(clés)) } }
// pour les seaux qui ont perdu une clé, { part: { mark, n, t, keys, last } } pour un morceau de
// liste complète, les deux à la fois, ou { full: [clés] } pour une liste complète d'un seul tenant
// (« ids:… » : montage 0.4, lien public). null si elle est vide ou illisible.
export function parseList(text) {
  const s = String(text || '');
  if (s.startsWith(LIST_PREFIX)) return { full: s.slice(LIST_PREFIX.length).split(' ').filter(Boolean) };
  const list = parseJson(s);
  if (!list || typeof list !== 'object') return null;
  const out = {};
  const buckets = listBuckets(list);
  if (buckets) out.buckets = buckets;
  const p = list.liste;
  if (p && typeof p === 'object' && typeof p.marque === 'string' && p.marque && Number.isInteger(p.n) && p.n > 0 && typeof p.t === 'number') {
    out.part = { mark: p.marque, n: p.n, t: p.t, keys: keyStrings(p.cles), last: p.fin === true };
  }
  return out.buckets || out.part ? out : null;
}

const isKey = k => (typeof k === 'string' || typeof k === 'number') && !isBlank(k);
const keyStrings = a => (Array.isArray(a) ? a.filter(isKey).map(String) : []);

function listBuckets(list) {
  const seaux = list.seaux && typeof list.seaux === 'object' ? Object.entries(list.seaux).filter(([b]) => /^\d+$/.test(b) && Number(b) < BUCKETS) : [];
  return seaux.length && typeof list.t === 'number' ? { t: list.t, keys: new Map(seaux.map(([b, keys]) => [Number(b), new Set(keyStrings(keys))])) } : null;
}

// Lot reçu : { lines: [{ key, order, deleted, data }], total, big, tooBig } ; null s'il est
// illisible. `tooBig` : instantané public trop gros, laissé vide. Une ligne sans clé, sans bloc de
// colonnes, ou dont l'heure n'est ni vide ni un nombre, est écartée.
const validLine = l => Array.isArray(l) && isKey(l[0]) && (l[1] === null || l[1] === undefined || typeof l[1] === 'number')
  && l[3] !== null && typeof l[3] === 'object' && !Array.isArray(l[3]);
export function parseLot(text) {
  const lot = parseJson(text);
  if (!lot || !Array.isArray(lot.lignes) || lot.lignes.length > MAX_LINES) return null;
  const lines = lot.lignes.filter(validLine).map(([key, order, deleted, data]) => ({ key: String(key), order: order ?? null, deleted: isTrue(deleted), data }));
  const big = keyStrings(lot.tropGros).slice(0, MAX_BIG);
  return { lines, total: Number(lot.total) || lines.length, big, ...(lot.trop === true ? { tooBig: true } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Dépliage

// Ce que dit une ligne brute : { table, list, text }, { table, lot } ou { end } (la SOURCE a coupé
// cet envoi, voir endNotice), ou null si elle ne peut pas venir de la SOURCE de cet export
// (`exportId`) : autre export, type inconnu, table au nom invalide, liste, lot ou colonnes illisibles.
function readRaw(row, exportId) {
  const table = row[TABLE_COL];
  const cols = isBlank(row[SCHEMA_COL]) ? [] : parseJson(row[SCHEMA_COL]);
  const columnsOk = Array.isArray(cols) && (!cols.length || validColumns(cols));
  if (exportId && row[EXPORT_COL] !== exportId) return null;
  if (row[TYPE_COL] === KIND.end && exportId) return { end: true };
  if (!isSafeId(table) || !columnsOk) return null;
  if (row[TYPE_COL] === KIND.keys) {
    const text = String(row[LIST_COL] || '');
    return !text || parseList(text) ? { table, text } : null;
  }
  const lot = row[TYPE_COL] === KIND.lot ? parseLot(row[LOT_COL]) : null;
  return lot ? { table, lot } : null;
}

// Lignes à ajouter au journal pour une ligne brute lue.
function unpackedRows(row, { table, text, lot }) {
  const base = { [TABLE_COL]: table, [RECEIVED_COL]: row[RECEIVED_COL] ?? null };
  if (!lot) return text || row[SCHEMA_COL] ? [{ ...base, [LIST_COL]: text, [SCHEMA_COL]: row[SCHEMA_COL] || '' }] : [];
  return lot.lines.map((l, i) => ({
    ...base, [KEY_COL]: l.key, [ORDER_COL]: l.order, [DELETE_COL]: l.deleted, [DATA_COL]: JSON.stringify(l.data),
    ...(i === 0 ? { [SCHEMA_COL]: row[SCHEMA_COL] || '' } : {}),
  }));
}

// Dépliage, dans l'ordre d'arrivée : chaque lot devient une ligne par version (clé, date,
// suppression, bloc des colonnes, table d'origine), chaque liste des clés une ligne de liste (qui
// porte aussi la description des colonnes) ; les lignes reçues sont effacées dans le même lot. Les
// nouvelles lignes gardent l'ordre d'arrivée et la date d'arrivée. Rend aussi, par table, les
// lignes qu'un lot coupé n'a pas portées depuis le dernier renvoi (`missing`), les clés des lignes
// trop grosses pour un envoi et celles arrivées (`big`, `arrived`), les tables reçues par un renvoi
// (`resent`), dont le compte précédent ne vaut plus, et le nombre de lignes rejetées (`rejected`).
// `ended` : { at } (heure d'arrivée) si la dernière nouvelle de la SOURCE est la fin de cet envoi,
// null si des données sont arrivées après, absent si ce passage n'en dit rien. Au plus `max` lignes
// reçues par passage, les plus anciennes : les suivantes attendent le passage d'après (`left`).
export function planUnpack(journalRows, journalTable, { exportId = null, max = Infinity } = {}) {
  const all = journalRows.filter(isRaw).sort((a, b) => a.id - b.id);
  const raw = all.slice(0, max);
  const added = [];
  const gaps = { missing: new Map(), big: new Map(), arrived: new Map(), resent: new Set() };
  let rejected = 0;
  let ended;
  for (const row of raw) {
    const read = readRaw(row, exportId);
    if (!read) {
      rejected++;
      continue;
    }
    ended = read.end ? { at: typeof row[RECEIVED_COL] === 'number' ? row[RECEIVED_COL] : null } : null;
    if (read.end) continue;
    added.push(...unpackedRows(row, read));
    if (read.lot) noteGaps(gaps, read.table, read.lot, !isBlank(row[RESEND_COL]));
  }
  const cols = [...new Set(added.flatMap(Object.keys))];
  const empty = c => (c === DELETE_COL ? false : c === ORDER_COL || c === RECEIVED_COL ? null : '');
  const actions = chunk(added).map(part => ['BulkAddRecord', journalTable, part.map(() => null),
    Object.fromEntries(cols.map(c => [c, part.map(r => r[c] ?? empty(c))]))]);
  for (const part of chunk(raw.map(r => r.id))) actions.push(['BulkRemoveRecord', journalTable, part]);
  const plain = map => Object.fromEntries(map);
  return {
    actions, missing: plain(gaps.missing), big: plain(gaps.big), arrived: plain(gaps.arrived), resent: [...gaps.resent], rejected, left: all.length - raw.length,
    ...(ended === undefined ? {} : { ended }),
  };
}

// Un renvoi remet le compte de sa table à zéro (la SOURCE recoupe elle-même un lot de renvoi trop
// gros) ; un lot coupé ajoute ce qui manque.
function noteGaps(gaps, table, lot, resent) {
  const add = (map, items) => map.set(table, [...(map.get(table) || []), ...items]);
  if (lot.big.length) add(gaps.big, lot.big);
  add(gaps.arrived, lot.lines.map(l => l.key));
  if (resent) {
    gaps.resent.add(table);
    gaps.missing.set(table, 0);
  } else if (lot.total > lot.lines.length) gaps.missing.set(table, (gaps.missing.get(table) || 0) + lot.total - lot.lines.length);
}

// Ce qui manque encore dans la CIBLE, mis à jour d'après un dépliage : le nombre de lignes pas
// encore arrivées par table (`missing`) et les clés des lignes trop grosses pour un envoi de Grist
// (`big`). Un renvoi remet sa table à zéro ; une ligne arrivée sort de `big`. Une table refusée
// (`refused`) n'est pas suivie, et la note en suit au plus MAX_TABLES.
export function nextGaps({ missing = {}, big = {}, refused = [] }, unpack) {
  const nextMissing = new Map(Object.entries(missing));
  const nextBig = new Map(Object.entries(big));
  for (const table of unpack.resent) {
    nextMissing.delete(table);
    nextBig.delete(table);
  }
  for (const [table, n] of Object.entries(unpack.missing)) if (n > 0) nextMissing.set(table, (nextMissing.get(table) || 0) + n);
  for (const table of new Set([...Object.keys(unpack.big), ...Object.keys(unpack.arrived)])) {
    const gone = new Set(unpack.arrived[table] || []);
    const keys = [...new Set([...(nextBig.get(table) || []), ...(unpack.big[table] || [])])].filter(k => !gone.has(k)).slice(0, MAX_BIG);
    if (keys.length) nextBig.set(table, keys);
    else nextBig.delete(table);
  }
  const kept = map => Object.fromEntries([...map].filter(([table]) => !refused.includes(table)).slice(-MAX_TABLES));
  return { missing: kept(nextMissing), big: kept(nextBig) };
}

// ---------------------------------------------------------------------------------------------
// Lignes dépliées

// Versions : (valeur de MajLe, numéro de ligne du journal). Vide = plus ancien ; à égalité
// d'horodatage, la dernière ligne arrivée gagne.
export function compareOrder(a, b) {
  if (isBlank(a) || isBlank(b)) return (isBlank(a) ? 0 : 1) - (isBlank(b) ? 0 : 1);
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function compareVersion(a, b) {
  return compareOrder(a.order, b.order) || Math.sign((a.id || 0) - (b.id || 0));
}

// Dernière version de chaque clé. Les lignes sans clé (listes, test du lien) sont ignorées.
export function latestByKey(journalRows) {
  const latest = new Map();
  for (const row of journalRows) {
    const key = row[KEY_COL];
    if (isBlank(key)) continue;
    const version = { order: row[ORDER_COL], id: row.id, row };
    const current = latest.get(key);
    if (!current || compareVersion(version, current) > 0) latest.set(key, version);
  }
  return latest;
}

// Lignes dépliées du journal, par table d'origine.
export const rowsByTable = journalRows => groupBy(journalRows.filter(r => !isRaw(r) && !isBlank(r[TABLE_COL])), r => r[TABLE_COL]);

// Lignes avec leurs colonnes envoyées dépliées (bloc JSON). Une liste devient une ChoiceList au
// format de Grist ; seules les clés qui peuvent être des colonnes sont gardées.
export function expandRows(journalRows) {
  return journalRows.map((row) => {
    const payload = isBlank(row[DATA_COL]) ? null : parseJson(row[DATA_COL]);
    if (!payload || typeof payload !== 'object') return row;
    const values = Object.fromEntries(Object.entries(payload).filter(([k]) => isSafeId(k))
      .map(([k, v]) => [k, Array.isArray(v) ? ['L', ...v] : v]));
    return { ...values, ...row };
  });
}

// Dernière ligne qui vérifie `test`, par numéro de ligne.
const lastWhere = (rows, test) => rows.reduce((latest, row) => (test(row) && (!latest || row.id > latest.id) ? row : latest), null);

// Dernière ligne qui porte la description des colonnes (listes, et première version de chaque lot).
const latestSchemaRow = rows => lastWhere(rows, r => !isBlank(r[SCHEMA_COL]));

// Colonnes envoyées, lues dans la dernière description reçue, sinon `fallback` (celles de l'invitation).
export function sentColumns(rows, fallback = []) {
  const cols = parseJson((latestSchemaRow(rows) || {})[SCHEMA_COL]);
  return validColumns(cols) ? exportSchema(cols) : fallback;
}

// Dernière liste complète d'un seul tenant reçue (« ids:… », voir parseList).
const latestList = rows => lastWhere(rows, r => String(r[LIST_COL] || '').startsWith(LIST_PREFIX));

// Listes du journal pas encore traitées, dans l'ordre d'arrivée, avec leur contenu lu.
export const pendingLists = rows => rows.filter(r => isBlank(r[KEY_COL]) && !isTrue(r[APPLIED_COL]))
  .map(row => ({ row, list: parseList(row[LIST_COL]) })).filter(l => l.list).sort((a, b) => a.row.id - b.row.id);

// Marque du dernier renvoi dont un morceau de liste est arrivé.
export const lastMark = pending => (pending.filter(l => l.list.part).pop() || { list: { part: {} } }).list.part.mark;

// Morceaux de liste complète arrivés en entier (du premier au dernier), par renvoi : { rows,
// keys, t } avec l'heure du premier morceau.
export function completeLists(pending) {
  const done = [];
  for (const parts of groupBy(pending.filter(p => p.list.part), p => p.list.part.mark).values()) {
    const last = parts.find(p => p.list.part.last);
    const have = new Set(parts.map(p => p.list.part.n));
    if (!last || Array.from({ length: last.list.part.n }, (_, i) => i + 1).some(n => !have.has(n))) continue;
    done.push({ rows: parts.map(p => p.row), keys: new Set(parts.flatMap(p => p.list.part.keys)), t: Math.min(...parts.map(p => p.list.part.t)) });
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// Nettoyage et historique

// Nettoyage du journal, dans le même lot. Restent, par table : la dernière version de chaque clé,
// la dernière liste « ids:… » et la dernière description des colonnes (avec leur marque
// `Sync_Applique`) ; les seaux pas encore traités et les morceaux du dernier renvoi pas encore
// arrivé en entier ; toutes les lignes des tables `keep` (proposées par la SOURCE, pas encore
// rangées) ; les lignes reçues pas encore dépliées ; et la ligne la plus récente, pour que Grist ne
// réutilise pas son numéro. Le reste (versions remplacées, tables `drop` refusées, test du lien)
// disparaît.
export function planPurge(journalRows, journalTable, { keep = [], drop = [] } = {}) {
  const kept = new Set(journalRows.filter(isRaw).map(r => r.id));
  for (const [table, rows] of rowsByTable(journalRows)) {
    if (drop.includes(table)) continue;
    if (keep.includes(table)) {
      rows.forEach(r => kept.add(r.id));
      continue;
    }
    for (const v of latestByKey(rows).values()) kept.add(v.id);
    for (const row of [latestList(rows), latestSchemaRow(rows)]) if (row) kept.add(row.id);
    const pending = pendingLists(rows);
    const mark = lastMark(pending);
    for (const { row, list } of pending) if (list.buckets || (list.part && list.part.mark === mark)) kept.add(row.id);
  }
  kept.add(journalRows.reduce((max, r) => Math.max(max, r.id), 0));
  const ids = journalRows.filter(r => !kept.has(r.id)).map(r => r.id);
  return chunk(ids).map(part => ['BulkRemoveRecord', journalTable, part]);
}

// Historique : dernière version de chaque clé recopiée avec un effet connu, arrivée après `since`
// (secondes), la plus récente d'abord, au plus `max`. `labelCol` nomme la ligne ; `n` est son
// numéro dans la destination (`numbers`, voir rowNumbers), celui qu'elle avait pour une ligne
// supprimée ; `detail` montre avant et après sur les colonnes recopiées (`copyCols`).
export const STATES = ['ajout', 'modif', 'suppression'];

// Tables à relire parmi celles que Grist dit changées (`changed` ; null : on ne sait pas) : les
// journaux et destinations suivis (`watched`), et le schéma (une table ou une colonne ajoutée,
// effacée). Null : tout relire.
const SCHEMA_TABLES = ['_grist_Tables', '_grist_Tables_column'];
export const touchedTables = (changed, watched) => (changed === null ? null
  : [...changed].filter(table => watched.has(table) || SCHEMA_TABLES.includes(table)));
export function recentChanges(journalRows, labelCol, since, max, { copyCols = [], numbers = new Map() } = {}) {
  return [...latestByKey(journalRows).values()]
    .map(v => ({ at: v.row[RECEIVED_COL] ?? v.order, state: v.row[STATE_COL], row: v.row }))
    .filter(c => STATES.includes(c.state) && typeof c.at === 'number' && c.at > since)
    .sort((a, b) => b.at - a.at).slice(0, max)
    .map((c) => {
      const was = parseJson(c.row[BEFORE_COL]) || {};
      const gone = c.state === 'suppression';
      const n = gone ? (Number.isInteger(was.n) && was.n > 0 ? was.n : null) : numbers.get(c.row[KEY_COL]) || null;
      return { at: c.at, key: c.row[KEY_COL], label: labelCol ? String(c.row[labelCol] ?? '') : '', state: c.state, n, detail: changeDetail(c.state, c.row, copyCols, was) };
    });
}

// Avant et après d'un changement, sur des colonnes [colonne du journal, colonne d'ici] : un ajout
// montre toutes les colonnes après, une suppression toutes avant (dernière version reçue), une
// modification celles qu'elle a remplacées (`Sync_Avant`). null s'il n'y a rien à montrer.
function changeDetail(state, row, copyCols, was) {
  const values = cols => cols.map(([from]) => row[from] ?? null);
  if (state !== 'modif') return copyCols.length ? { cols: copyCols, before: state === 'ajout' ? null : values(copyCols), after: state === 'ajout' ? values(copyCols) : null } : null;
  const v = was.v && typeof was.v === 'object' && !Array.isArray(was.v) ? was.v : {};
  const cols = copyCols.filter(([from]) => Object.hasOwn(v, from));
  return cols.length ? { cols, before: cols.map(([from]) => v[from]), after: values(cols) } : null;
}

// ---------------------------------------------------------------------------------------------
// Lien public, côté CIBLE : lignes à ajouter au journal pour qu'il reflète les instantanés lus
// (`records` : lignes 'complet' de la table Synchro, lues par l'API REST), comme l'aurait fait un
// webhook. Par table, une version n'est ajoutée que si elle diffère de la
// dernière reçue ; une liste des clés, que si l'ensemble des clés ou les colonnes ont changé. Un
// instantané trop gros (vide) ne change rien : sa table est rendue dans `tooBig`.
export function planPull({ records, journalRows, journalTable }) {
  const byTable = rowsByTable(journalRows);
  const versions = [];
  const lists = [];
  const tooBig = [];
  for (const { fields } of records) {
    const table = fields[TABLE_COL];
    const lot = fields[TYPE_COL] === KIND.full && isSafeId(table) ? parseLot(fields[LOT_COL]) : null;
    if (lot && lot.tooBig) tooBig.push(table);
    if (!lot || lot.tooBig) continue;
    const rows = byTable.get(table) || [];
    versions.push(...changedVersions(table, lot, latestByKey(rows)));
    const list = pulledList(table, lot, rows, fields[SCHEMA_COL] || '');
    if (list) lists.push(list);
  }
  const cols = [TABLE_COL, KEY_COL, ORDER_COL, DELETE_COL, DATA_COL];
  const actions = chunk(versions).map(part => ['BulkAddRecord', journalTable, part.map(() => null),
    Object.fromEntries(cols.map(col => [col, part.map(v => v[col])]))]);
  for (const l of lists) actions.push(['AddRecord', journalTable, null, l]);
  return { actions, tooBig: tooBig.sort() };
}

function changedVersions(table, lot, latest) {
  return lot.lines.filter((l) => {
    const known = latest.get(l.key);
    return !(known && known.order === l.order && known.row[DATA_COL] === JSON.stringify(l.data) && isTrue(known.row[DELETE_COL]) === l.deleted);
  }).map(l => ({ [TABLE_COL]: table, [KEY_COL]: l.key, [ORDER_COL]: l.order, [DELETE_COL]: l.deleted, [DATA_COL]: JSON.stringify(l.data) }));
}

// Liste des clés d'un instantané, si l'ensemble des clés ou les colonnes ont changé ; sinon null.
function pulledList(table, lot, rows, schema) {
  const sortedKeys = keys => `${LIST_PREFIX}${keys.filter(Boolean).sort().join(' ')}`;
  const ids = sortedKeys(lot.lines.map(l => l.key));
  const list = latestList(rows);
  const same = list && sortedKeys(String(list[LIST_COL]).slice(LIST_PREFIX.length).split(' ')) === ids && (latestSchemaRow(rows) || {})[SCHEMA_COL] === schema;
  return same ? null : { [TABLE_COL]: table, [LIST_COL]: ids, [SCHEMA_COL]: schema };
}
