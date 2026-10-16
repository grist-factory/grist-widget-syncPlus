// CIBLE : recopie des versions d'un journal dans la table de destination (`planConsolidation`), et
// correspondance des colonnes entre les deux.
import {
  APPLIED_COL, AUTHOR_COL, BEFORE_COL, DATA_COL, DELETE_COL, EXPORT_COL, KEY_COL, LIST_COL, LOT_COL, ORDER_COL, RECALC_COL, RECEIVED_COL, RESEND_COL, SCHEMA_COL,
  STATE_COL, TABLE_COL, TYPE_COL, BUCKETS, bucketOf, chunk, freeTableId, groupBy, isBlank, isTrue,
} from './common.js';
import { compareOrder, completeLists, lastMark, latestByKey, pendingLists } from './journal.js';

// Colonnes recopiées, en couples [colonne du journal, colonne de la destination] : colonnes
// envoyées présentes des deux côtés (sous le nom choisi dans `map`, sinon le même), hors colonnes
// techniques de la synchro et formules de la destination. La destination ne garde que `id_sync`.
const TECHNICAL = new Set(['id', 'manualSort', KEY_COL, ORDER_COL, RECALC_COL, DELETE_COL, LIST_COL, APPLIED_COL, AUTHOR_COL, RECEIVED_COL, STATE_COL,
  BEFORE_COL, DATA_COL, SCHEMA_COL, EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, LOT_COL]);
export function copyColumns(journalCols, destCols, map = {}) {
  const writable = new Set(destCols.filter(c => !c.isFormula).map(c => c.colId));
  return journalCols.map(c => c.colId).filter(id => !TECHNICAL.has(id) && !id.startsWith('gristHelper_'))
    .map(id => [id, map[id] || id]).filter(([, to]) => writable.has(to) && to !== KEY_COL);
}

// Destination renommée dans la CIBLE : la table et ses colonnes sont suivies par leur numéro dans
// Grist, noté à chaque passage (`refs`, voir destRefs). Rend l'entrée avec les noms actuels : la
// destination, la correspondance des colonnes (`map`) et la colonne de rattachement (`match`).
export function followRenames(entry, schema) {
  const { table: tableRef, cols = {} } = entry.refs || {};
  const dest = (tableRef && schema.tableIdOf(tableRef)) || entry.dest;
  const current = new Map((schema.columns(dest) || []).map(c => [c.id, c.colId]));
  const renamed = new Map(Object.entries(cols).filter(([colId, ref]) => current.has(ref) && current.get(ref) !== colId)
    .map(([colId, ref]) => [colId, current.get(ref)]));
  if (dest === entry.dest && !renamed.size) return entry;
  const map = { ...entry.map };
  for (const id of new Set([...(entry.columns || []).map(c => c.id), ...Object.keys(map)])) {
    const to = map[id] || id;
    if (renamed.has(to)) map[id] = renamed.get(to);
  }
  const next = { ...entry, dest, map };
  if (entry.match) next.match = renamed.get(entry.match) || entry.match;
  return next;
}

// Numéros Grist de la destination et de ses colonnes, notés pour suivre un renommage.
export function destRefs(schema, dest) {
  const table = schema.table(dest);
  return table ? { table: table.id, cols: Object.fromEntries(schema.columns(dest).map(c => [c.colId, c.id])) } : undefined;
}

// Colonnes envoyées arrivées après l'invitation (ni dans `columns`, ni dans `map` d'une table
// reçue) : chacune prend son nom dans la destination, ou un nom libre (`Note_2`) si une colonne de
// la destination (`destColIds`) le porte déjà, pour ne jamais écraser une colonne à elle. Rend la
// correspondance complétée, ou null s'il n'y a rien de nouveau.
export function newColumnsMap({ columns = [], map = {} }, sent, destColIds) {
  const known = new Set([...columns.map(c => c.id), ...Object.keys(map)]);
  const fresh = sent.filter(c => !known.has(c.id));
  if (!fresh.length) return null;
  const taken = [...destColIds, ...Object.values(map)];
  const next = { ...map };
  for (const { id } of fresh) {
    next[id] = freeTableId(id, taken);
    taken.push(next[id]);
  }
  return next;
}

// Valeur reçue et valeur de la destination égales ? Vide vaut vide ; une liste de choix lue dans
// Grist commence par la marque 'L'.
function sameValue(sent, have) {
  const norm = x => (isBlank(x) ? null : Array.isArray(x) && x[0] === 'L' ? x.slice(1) : x);
  return JSON.stringify(norm(sent)) === JSON.stringify(norm(have));
}

// Numéro de ligne de chaque clé de la destination, tel que Grist l'affiche dans une vue sans tri
// (ordre de `manualSort`, puis du numéro interne) : l'`id` d'une ligne diffère d'un document à
// l'autre, son rang se retrouve dans la table.
export function rowNumbers(destRows) {
  const rank = r => (typeof r.manualSort === 'number' ? r.manualSort : r.id);
  const sorted = [...destRows].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  const numbers = new Map();
  sorted.forEach((r, i) => { if (!isBlank(r[KEY_COL]) && !numbers.has(r[KEY_COL])) numbers.set(r[KEY_COL], i + 1); });
  return numbers;
}

// Valeurs qu'une version va remplacer dans une ligne de la destination, notées pour l'historique
// ({ colonne du journal: valeur d'ici }), s'il y en a.
function noteReplaced(plan, copyCols, version, destRow) {
  const cells = copyCols.filter(([from, to]) => !sameValue(version.row[from], destRow[to]));
  if (cells.length) plan.before.set(version.id, { v: Object.fromEntries(cells.map(([from, to]) => [from, destRow[to] ?? null])) });
}

// Valeurs retouchées à la main dans la destination : cellules d'une ligne reçue qui diffèrent de
// la dernière version reçue, lues après la recopie. Rend [{ id, key, n, row, cells: [[colonne du
// journal, colonne d'ici, valeur d'ici, valeur de la SOURCE]] }] par numéro de ligne (`id` : la
// ligne d'ici, `row` : la version reçue). Échange : rien (une retouche y part vers l'autre
// document, ce n'est pas un écart).
export function manualEdits({ journalRows, destRows, copyCols, exchange = false }) {
  if (exchange) return [];
  const latest = latestByKey(journalRows);
  const numbers = rowNumbers(destRows);
  const edits = [];
  for (const row of destRows) {
    const version = latest.get(row[KEY_COL]);
    if (!version || isTrue(version.row[DELETE_COL])) continue;
    const cells = copyCols.filter(([from, to]) => !sameValue(version.row[from], row[to]))
      .map(([from, to]) => [from, to, row[to] ?? null, version.row[from] ?? null]);
    if (cells.length) edits.push({ id: row.id, key: row[KEY_COL], n: numbers.get(row[KEY_COL]) || null, row: version.row, cells });
  }
  return edits.sort((a, b) => (a.n || 0) - (b.n || 0));
}

// « Corriger » : remet dans les cellules retouchées (voir manualEdits) la valeur de la SOURCE, une
// écriture par groupe de lignes retouchées sur les mêmes colonnes.
export function restoreActions(edits, destTable) {
  const groups = groupBy(edits, e => JSON.stringify(e.cells.map(([, to]) => to)));
  return [...groups.values()].flatMap(list => chunk(list).map(part => ['BulkUpdateRecord', destTable, part.map(e => e.id),
    Object.fromEntries(part[0].cells.map(([, to], i) => [to, part.map(e => e.cells[i][3])]))]));
}

// ---------------------------------------------------------------------------------------------
// Recopie

// Lignes de la destination par clé, et celles sans clé par valeur de la colonne de rattachement.
function indexDest(destRows, matchCol) {
  const keyed = destRows.filter(r => !isBlank(r[KEY_COL]));
  const unkeyed = matchCol ? destRows.filter(r => isBlank(r[KEY_COL]) && !isBlank(r[matchCol])) : [];
  return { byKey: groupBy(keyed, r => r[KEY_COL]), unkeyed: groupBy(unkeyed, r => r[matchCol]) };
}

// Clés parties de la SOURCE d'après les listes pas encore traitées : absentes de la liste la plus
// récente qui couvre leur seau (seau qui a perdu une clé, ou liste complète arrivée en entier), ou
// d'une liste « ids:… » ; sauf si une version plus récente que la liste est arrivée (clé recréée,
// annulation) : « plus récente » se lit à l'heure de la SOURCE, ou à l'ordre d'arrivée pour une
// liste « ids:… », qui n'a pas d'heure. Seule la plus récente compte : une clé sortie d'un filtre
// puis revenue figure dans la dernière liste, pas dans celle d'avant, et les deux peuvent attendre
// le même passage, dans un ordre quelconque (file de Grist).
// Rend les clés (`gone`) et, pour l'historique, [version, date d'arrivée de la liste] de celles que
// la destination a (`listGone`) ; note dans `marks` les listes traitées.
function droppedKeys(pending, latest, destByKey, marks) {
  const gone = new Set();
  const listGone = [];
  const known = [...new Set([...destByKey.keys(), ...latest.keys()])];
  const drop = (key, t, listRow) => {
    const version = latest.get(key);
    if (gone.has(key) || (version && (t === null ? version.id > listRow.id : compareOrder(version.order, t) > 0))) return;
    gone.add(key);
    if (version && destByKey.has(key)) listGone.push([version.id, listRow[RECEIVED_COL] ?? null]);
  };
  const newest = new Map(); // seau -> { t, keys, row } : la liste la plus récente qui le couvre
  const cover = (bucket, t, keys, row) => {
    const was = newest.get(bucket);
    if (!was || compareOrder(t, was.t) >= 0) newest.set(bucket, { t, keys, row });
  };
  const mark = lastMark(pending);
  for (const { row, list } of pending) {
    if (list.buckets) for (const [bucket, keys] of list.buckets.keys) cover(bucket, list.buckets.t, keys, row);
    // Un morceau de liste complète attend les autres ; celui d'un renvoi remplacé par un autre
    // (interrompu, repris sous une autre marque) ne servira plus.
    if (!list.part || list.part.mark !== mark) marks.set(row.id, '');
  }
  const byBucket = groupBy(known, bucketOf);
  for (const { rows, keys, t } of completeLists(pending)) {
    for (let bucket = 0; bucket < BUCKETS; bucket++) cover(bucket, t, keys, rows[rows.length - 1]);
    rows.forEach(row => marks.set(row.id, ''));
  }
  for (const [bucket, { t, keys, row }] of newest) (byBucket.get(bucket) || []).filter(key => !keys.has(key)).forEach(key => drop(key, t, row));
  const full = pending.filter(l => l.list.full).pop();
  if (full) {
    const present = new Set(full.list.full);
    known.filter(key => !present.has(key)).forEach(key => drop(key, null, full.row));
  }
  return { gone, listGone };
}

const newest = rows => rows.map(r => r[ORDER_COL]).reduce((a, b) => (compareOrder(a, b) >= 0 ? a : b), null);

// Sans effet : la destination a déjà ces valeurs, ou la SOURCE n'a rien changé depuis la version
// déjà recopiée (un renvoi, l'arrivée d'un autre destinataire, une colonne non envoyée modifiée).
// Une retouche faite à la main dans la destination reste donc en place.
function withoutEffect({ applied, copyCols }, version, here) {
  const before = applied.get(version.row[KEY_COL]);
  if (before && copyCols.every(([from]) => sameValue(version.row[from], before.row[from]))) return true;
  return here.every(row => copyCols.every(([from, to]) => sameValue(version.row[from], row[to])));
}

// Effet de la dernière version d'une clé pas encore recopiée : 'suppression', 'modif' (dont le
// rattachement d'une ligne sans clé), 'ajout', ou '' (sans effet). Les lignes à écrire sont notées
// dans `plan`.
function versionState(ctx, plan, key, version) {
  const here = ctx.dest.byKey.get(key);
  // Échange : la version reçue n'a d'effet que si elle est plus récente que la ligne d'ici.
  if (ctx.exchange && here && compareOrder(version.order, newest(here)) <= 0) return '';
  if (isTrue(version.row[DELETE_COL])) plan.gone.add(key);
  if (plan.gone.has(key)) return here ? 'suppression' : '';
  const candidates = !here && ctx.matchFrom ? ctx.dest.unkeyed.get(version.row[ctx.matchFrom]) : null;
  if (candidates && candidates.length) {
    const row = candidates.shift();
    plan.attached.push([row, version]);
    noteReplaced(plan, ctx.copyCols, version, row);
    return 'modif';
  }
  if (here && withoutEffect(ctx, version, here)) return '';
  plan.upserts.push(version);
  if (here) noteReplaced(plan, ctx.copyCols, version, here[0]);
  return here ? 'modif' : 'ajout';
}

// Le plan en actions Grist : ajouts et modifications par clé, rattachements, suppressions, puis
// marques dans le journal et, pour l'historique, ce qui a été remplacé.
function consolidationActions({ destTable, journalTable, copyCols, exchange }, { upserts, attached, removeIds, marks, listGone, before }) {
  const values = (versions) => {
    const out = Object.fromEntries(copyCols.map(([from, to]) => [to, versions.map(v => v.row[from] ?? null)]));
    return exchange ? { ...out, [ORDER_COL]: versions.map(v => v.order ?? null) } : out;
  };
  return [
    ...chunk(upserts).map(part => ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(v => v.row[KEY_COL]) }, values(part), { on_many: 'all' }]),
    ...chunk(attached).map(part => ['BulkUpdateRecord', destTable, part.map(([row]) => row.id),
      { [KEY_COL]: part.map(([, v]) => v.row[KEY_COL]), ...values(part.map(([, v]) => v)) }]),
    ...chunk(removeIds).map(part => ['BulkRemoveRecord', destTable, part]),
    ...chunk([...marks]).map(part => ['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [APPLIED_COL]: part.map(() => true), [STATE_COL]: part.map(([, state]) => state) }]),
    ...chunk(listGone).map(part => ['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [STATE_COL]: part.map(() => 'suppression'), [RECEIVED_COL]: part.map(([, at]) => at) }]),
    ...chunk([...before]).map(part => ['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [BEFORE_COL]: part.map(([, was]) => JSON.stringify(was)) }]),
  ];
}

// Actions qui amènent la destination à l'état de la SOURCE, en un seul lot, pour une table
// (lignes du journal de cette table seulement) :
//  - la dernière version de chaque clé, si elle n'a pas encore été recopiée ; une clé inconnue
//    de la destination peut y reprendre une ligne existante sans clé de même valeur dans la
//    colonne `matchCol` (rattachement d'un référentiel déjà rempli) ;
//  - la suppression des lignes cochées `Supprime` et des clés parties de la SOURCE (droppedKeys) ;
//  - le marquage des versions et des listes traitées (`Sync_Applique`) et de leur effet
//    (`Sync_Etat`), pour l'historique ; une suppression venue d'une liste est notée sur la
//    dernière version de la clé, à la date d'arrivée de la liste ;
//  - ce que la recopie remplace (`Sync_Avant`) : les valeurs d'ici d'une ligne modifiée, le
//    numéro d'une ligne supprimée.
// Une retouche manuelle survit donc jusqu'à la prochaine modification côté SOURCE, et rejouer le
// plan après application ne change rien (idempotent).
// Échange (`exchange`) : la destination est aussi envoyée à l'autre document. La version la plus
// récente gagne : une version reçue n'a d'effet que si elle est plus récente que la ligne d'ici
// (MajLe), et elle y écrit MajLe à son heure. Les listes des clés sont sans effet : une clé absente
// de la liste de l'autre document peut n'y être pas encore arrivée ; seule `Supprime` efface.
export function planConsolidation({ journalRows, destRows, copyCols, destTable, journalTable, matchCol = '', exchange = false }) {
  const dest = indexDest(destRows, matchCol);
  const latest = latestByKey(journalRows);
  const marks = new Map(); // ligne du journal -> effet ('' pour une liste ou une version sans effet)
  const pending = pendingLists(journalRows);
  const { gone, listGone } = exchange ? { gone: new Set(), listGone: [] } : droppedKeys(pending, latest, dest.byKey, marks);
  if (exchange) pending.forEach(({ row }) => marks.set(row.id, ''));
  const ctx = {
    dest, copyCols, exchange,
    matchFrom: (copyCols.find(([, to]) => to === matchCol) || [])[0],
    applied: latestByKey(journalRows.filter(r => isTrue(r[APPLIED_COL]) && !isTrue(r[DELETE_COL]))),
  };
  const plan = { gone, marks, upserts: [], attached: [], before: new Map(), stats: { added: 0, updated: 0, removed: 0 } };
  for (const [key, version] of latest) {
    if (isTrue(version.row[APPLIED_COL])) continue;
    const state = versionState(ctx, plan, key, version);
    marks.set(version.id, state);
    if (state === 'ajout') plan.stats.added++;
    if (state === 'modif') plan.stats.updated++;
  }
  const removed = [...gone].filter(key => dest.byKey.has(key));
  plan.stats.removed = removed.length;
  const removeIds = removed.flatMap(key => dest.byKey.get(key).map(r => r.id));
  if (removed.length) {
    const numbers = rowNumbers(destRows);
    for (const key of removed) if (latest.has(key)) plan.before.set(latest.get(key).id, { n: numbers.get(key) });
  }
  return { actions: consolidationActions({ destTable, journalTable, copyCols, exchange }, { ...plan, removeIds, listGone }), stats: plan.stats };
}
