// CIBLE : le journal d'un export. Le webhook y dépose des lignes de Synchro (« brutes ») ; le widget
// les déplie en une ligne par version ou par liste des clés, puis les recopie (consolidation.js) et
// nettoie le journal.
// Le lien du formulaire permet d'écrire n'importe quoi dans le journal. Chaque réception a sa clé
// (un formulaire par page) : seul l'expéditeur de l'export l'a, et il décide déjà de ce qu'il
// envoie. Une ligne brute qui ne peut pas venir du webhook de cet export est tout de même effacée
// sans effet et comptée, et rien de ce qui est lu ne peut servir de nom propre aux objets JavaScript.
import {
  APPLIED_COL, BEFORE_COL, BUCKETS, DATA_COL, DELETE_COL, EXPORT_COL, KEY_COL, KIND, LIST_COL, LIST_PREFIX, LOT_COL, ORDER_COL, RECEIVED_COL, RESEND_COL,
  SCHEMA_COL, STATE_COL, TABLE_COL, TYPE_COL, chunk, groupBy, isBlank, isSafeId, isTrue, isUserTable, parseJson,
} from './common.js';
import { exportSchema, validColumns } from './codes.js';

const MAX_LINES = 100000; // lignes par lot, au plus (un envoi fait au plus 1 Mo, un instantané public 2 Mo)
const MAX_BIG = 1000; // clés de lignes trop grosses retenues par table
const MAX_REST = 1e9; // lignes annoncées à venir, au plus (un nombre absurde n'est pas montré tel quel)
const MAX_TABLES = 200; // tables suivies dans la note d'un journal

// Ligne telle que déposée par le webhook (ou le lien public) : une liste des clés ou un lot.
export const isRaw = row => !isBlank(row[TYPE_COL]);

// Note d'un journal : voir readNote dans target/journals.js. Le journal de retour d'un Échange
// (`retour`, côté du document qui a invité) attend la réponse (`from` encore vide) avant de
// recopier quoi que ce soit.
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

// Lot reçu : { lines: [{ key, order, deleted, data }], total, big, rest?, tally?, tooBig? } ; null s'il est
// illisible. `tooBig` : instantané public trop gros, laissé vide. `rest` : combien de lignes de la
// table la SOURCE annonce encore à venir après ce lot de renvoi (`restant`), absent si elle ne
// l'annonce pas (SOURCE d'avant la 0.12.4, lot ordinaire). `tally` : { n, t } le nombre de clés que la
// SOURCE annonce avoir pour la table, et l'heure de leur dernier changement (voir tally.js), absent si
// l'annonce manque ou est illisible. Une ligne sans clé, sans bloc de colonnes, ou dont
// l'heure n'est ni vide ni un nombre, est écartée.
const validLine = l => Array.isArray(l) && isKey(l[0]) && (l[1] === null || l[1] === undefined || typeof l[1] === 'number')
  && l[3] !== null && typeof l[3] === 'object' && !Array.isArray(l[3]);
export function parseLot(text) {
  const lot = parseJson(text);
  if (!lot || !Array.isArray(lot.lignes) || lot.lignes.length > MAX_LINES) return null;
  const lines = lot.lignes.filter(validLine).map(([key, order, deleted, data]) => ({ key: String(key), order: order ?? null, deleted: isTrue(deleted), data }));
  const big = keyStrings(lot.tropGros).slice(0, MAX_BIG);
  const rest = Number.isInteger(lot.restant) && lot.restant >= 0 ? Math.min(lot.restant, MAX_REST) : null;
  const announced = lot.bilan;
  const tally = announced && Number.isInteger(announced.n) && announced.n >= 0 && Number.isFinite(announced.t) ? { n: announced.n, t: announced.t } : null;
  return { lines, total: Number(lot.total) || lines.length, big, ...(rest === null ? {} : { rest }), ...(tally ? { tally } : {}), ...(lot.trop === true ? { tooBig: true } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Dépliage

// Une version ou une liste datée de plus de FUTURE_S secondes après l'heure d'ici ne peut pas venir
// de la SOURCE (même instance, même horloge) : elle l'emporterait sur toutes les vraies versions.
const FUTURE_S = 600;
const listTime = list => Math.max(list.buckets ? list.buckets.t : 0, list.part ? list.part.t : 0);

// Ce que dit une ligne brute : { table, list, text }, { table, lot } ou { end } (la SOURCE a coupé
// cet envoi, voir endNotice), ou null si elle ne peut pas venir de la SOURCE de cet export
// (`exportId`) : autre export, type inconnu, table au nom invalide, liste, lot ou colonnes
// illisibles, liste datée du futur (après `limit`).
function readRaw(row, exportId, limit) {
  const table = row[TABLE_COL];
  if (exportId && row[EXPORT_COL] !== exportId) return null;
  if (row[TYPE_COL] === KIND.end && exportId) return { end: true };
  if (!isSafeId(table) || !readableColumns(row[SCHEMA_COL])) return null;
  if (row[TYPE_COL] === KIND.keys) return readKeys(table, row[LIST_COL], limit);
  const lot = row[TYPE_COL] === KIND.lot ? parseLot(row[LOT_COL]) : null;
  return lot ? { table, lot } : null;
}

// Colonnes annoncées par une ligne brute : aucune, ou une liste valide (voir validColumns).
function readableColumns(value) {
  if (isBlank(value)) return true;
  const cols = parseJson(value);
  return Array.isArray(cols) && (!cols.length || validColumns(cols));
}

// Liste des clés d'une ligne brute : vide, ou lisible et pas datée du futur (après `limit`).
function readKeys(table, value, limit) {
  const text = String(value || '');
  const list = text ? parseList(text) : null;
  return !text || (list && !(listTime(list) > limit)) ? { table, text } : null;
}

// Lignes à ajouter au journal pour une ligne brute lue (`lines` : celles du lot gardées). Un lot
// sans ligne dont la description des colonnes a changé (`known` : la dernière connue) la garde
// seule : une liste de choix ou un format changé à la SOURCE part ainsi, sans renvoi des lignes.
function unpackedRows(row, { table, text }, lines, known) {
  const base = { [TABLE_COL]: table, [RECEIVED_COL]: row[RECEIVED_COL] ?? null };
  if (!lines) return text || row[SCHEMA_COL] ? [{ ...base, [LIST_COL]: text, [SCHEMA_COL]: row[SCHEMA_COL] || '' }] : [];
  if (!lines.length) return !isBlank(row[SCHEMA_COL]) && row[SCHEMA_COL] !== known ? [{ ...base, [LIST_COL]: '', [SCHEMA_COL]: row[SCHEMA_COL] }] : [];
  return lines.map((l, i) => ({
    ...base, [KEY_COL]: l.key, [ORDER_COL]: l.order, [DELETE_COL]: l.deleted, [DATA_COL]: JSON.stringify(l.data),
    ...(i === 0 ? { [SCHEMA_COL]: row[SCHEMA_COL] || '' } : {}),
  }));
}

// Tables à relire parmi celles que Grist dit changées (`changed` ; null : on ne sait pas) : les
// journaux et destinations suivis (`watched`), et le schéma (une table ou une colonne ajoutée,
// effacée). Null : tout relire.
const SCHEMA_TABLES = ['_grist_Tables', '_grist_Tables_column'];
export const touchedTables = (changed, watched) => (changed === null ? null
  : [...changed].filter(table => watched.has(table) || SCHEMA_TABLES.includes(table)));

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
// Les morceaux de fichiers de l'export restent pour la réception des fichiers (voir files.js).
// Rejetées aussi (comptées dans `rejected`) : les lignes de `bad` (mal signées, voir trust.js) et
// les versions datées du futur (`now` : heure d'ici, en secondes). Les colonnes décrites par une
// ligne de `bare` (liste vide, non signée) ne sont pas lues.
export function planUnpack(journalRows, journalTable, { exportId = null, max = Infinity, now = Infinity, bad = new Set(), bare = new Set() } = {}) {
  const all = journalRows.filter(r => isRaw(r) && !(exportId && r[TYPE_COL] === KIND.part && r[EXPORT_COL] === exportId)).sort((a, b) => a.id - b.id);
  const raw = all.slice(0, max);
  const added = [];
  const gaps = { missing: new Map(), big: new Map(), arrived: new Map(), resent: new Set(), tally: new Map() };
  let rejected = 0;
  let ended;
  const limit = now + FUTURE_S;
  const schemas = new Map(journalRows.filter(r => !isRaw(r) && !isBlank(r[SCHEMA_COL])).sort((a, b) => a.id - b.id).map(r => [r[TABLE_COL], r[SCHEMA_COL]]));
  for (const got of raw) {
    const row = bare.has(got.id) ? { ...got, [SCHEMA_COL]: '' } : got;
    const read = bad.has(row.id) ? null : readRaw(row, exportId, limit);
    if (!read) {
      rejected++;
      continue;
    }
    ended = read.end ? { at: typeof row[RECEIVED_COL] === 'number' ? row[RECEIVED_COL] : null } : null;
    if (read.end) continue;
    const lines = read.lot ? read.lot.lines.filter(l => !(l.order > limit)) : null;
    rejected += read.lot ? read.lot.lines.length - lines.length : 0;
    const rows = unpackedRows(row, read, lines, schemas.get(read.table));
    for (const r of rows) if (!isBlank(r[SCHEMA_COL])) schemas.set(read.table, r[SCHEMA_COL]);
    added.push(...rows);
    if (read.lot) noteGaps(gaps, read.table, read.lot, !isBlank(row[RESEND_COL]));
  }
  const removed = raw.map(r => r.id);
  const plain = map => Object.fromEntries(map);
  return {
    added, removed, actions: unpackActions(journalTable, added, removed),
    missing: plain(gaps.missing), big: plain(gaps.big), arrived: plain(gaps.arrived), resent: [...gaps.resent], tally: plain(gaps.tally), rejected, left: all.length - raw.length,
    ...(ended === undefined ? {} : { ended }),
  };
}

// Lignes dépliées (`added`, scellées ou non, voir trust.js) ajoutées et lignes reçues (`removed`)
// effacées, dans le même lot.
export function unpackActions(journalTable, added, removed) {
  const cols = [...new Set(added.flatMap(Object.keys))];
  const empty = c => (c === DELETE_COL ? false : c === ORDER_COL || c === RECEIVED_COL ? null : '');
  const actions = chunk(added).map(part => ['BulkAddRecord', journalTable, part.map(() => null),
    Object.fromEntries(cols.map(c => [c, part.map(r => r[c] ?? empty(c))]))]);
  for (const part of chunk(removed)) actions.push(['BulkRemoveRecord', journalTable, part]);
  return actions;
}

// Un renvoi remet le compte de sa table à ce que la SOURCE annonce encore à venir (`rest`, 0 quand
// elle ne dit rien : elle recoupe elle-même un lot de renvoi trop gros) ; un lot coupé ajoute ce qui
// manque. Une page SOURCE fermée en plein renvoi laisse ainsi le compte des lignes à venir.
function noteGaps(gaps, table, lot, resent) {
  const add = (map, items) => map.set(table, [...(map.get(table) || []), ...items]);
  if (lot.big.length) add(gaps.big, lot.big);
  add(gaps.arrived, lot.lines.map(l => l.key));
  const was = gaps.tally.get(table);
  if (lot.tally && (!was || lot.tally.t >= was.t)) gaps.tally.set(table, lot.tally);
  if (resent) {
    gaps.resent.add(table);
    gaps.missing.set(table, lot.rest ?? 0);
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

// Valeurs de la dernière version reçue de chaque clé, hors suppressions.
export const currentRows = journalRows => [...latestByKey(journalRows).values()].filter(v => !isTrue(v.row[DELETE_COL])).map(v => v.row);

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
// La SOURCE a-t-elle déjà décrit les colonnes de cette table ? Sans cela, `sentColumns` rend celles de l'invitation.
export const hasSchema = rows => Boolean(latestSchemaRow(rows) && validColumns(parseJson(latestSchemaRow(rows)[SCHEMA_COL])));

// Destinations choisies pour des tables reçues (`plans` : [{ table, dest }]) : la première qui ne va
// pas, avec sa raison, ou null. Une destination ne reçoit qu'une table (`received` : voir
// receivedDests), et n'est pas une table du widget.
export function destProblem(plans, received) {
  const seen = new Set();
  for (const { dest } of plans) {
    if (!isUserTable(dest)) return { code: 'destReserved', vars: { dest } };
    if (seen.has(dest)) return { code: 'destTwice', vars: { dest } };
    seen.add(dest);
    const feed = received.find(r => r.dest === dest);
    if (feed) return { code: 'destTaken', vars: { dest, table: feed.table } };
  }
  return null;
}

// Colonnes que la destination reçoit : les colonnes de données (sans la clé, MajLe ni Supprime).
export const destColumns = columns => columns.filter(c => ![KEY_COL, ORDER_COL, DELETE_COL].includes(c.id));

// Colonnes envoyées, lues dans la dernière description reçue, sinon `fallback` (celles de
// l'invitation).
export function sentColumns(rows, fallback = []) {
  const cols = parseJson((latestSchemaRow(rows) || {})[SCHEMA_COL]);
  return validColumns(cols) ? exportSchema(cols, true) : fallback;
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

// États d'une version recopiée montrés dans l'historique (voir recentChanges).
export const STATES = ['ajout', 'modif', 'suppression'];
export const REFUSED = 'refus';
const SHOWN = [...STATES, REFUSED];
// Heure lisible par Date (secondes) : une valeur au-delà ferait échouer l'affichage.
const MAX_TIME_S = 8.64e12;
const validTime = at => Number.isFinite(at) && Math.abs(at) < MAX_TIME_S;

// Historique : dernière version de chaque clé recopiée avec un effet connu, arrivée après `since`
// (secondes), la plus récente d'abord, au plus `max`. `labelCol` nomme la ligne ; `n` est son
// numéro dans la destination (`numbers`, voir rowNumbers), celui qu'elle avait pour une ligne
// supprimée ; `detail` montre avant et après sur les colonnes recopiées (`copyCols`). Échange, chez
// le document qui l'administre : un changement refusé (REFUSED) y figure aussi.
export function recentChanges(journalRows, labelCol, since, max, { copyCols = [], numbers = new Map() } = {}) {
  return [...latestByKey(journalRows).values()]
    .map(v => ({ at: v.row[RECEIVED_COL] ?? v.order, state: v.row[STATE_COL], row: v.row }))
    .filter(c => SHOWN.includes(c.state) && validTime(c.at) && c.at > since)
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
// modification celles qu'elle a remplacées (`Sync_Avant`). Un refus montre ce qui est gardé ici et
// ce qui était proposé, selon le changement refusé (`k`). null s'il n'y a rien à montrer.
function changeDetail(state, row, copyCols, was) {
  const values = cols => cols.map(([from]) => row[from] ?? null);
  if (state === REFUSED) return was.k === 'suppression' ? null : changeDetail(was.k === 'ajout' ? 'ajout' : 'modif', row, copyCols, was);
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
