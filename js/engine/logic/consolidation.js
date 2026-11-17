// CIBLE : recopie des versions d'un journal dans la table de destination (`planConsolidation`), et
// correspondance des colonnes entre les deux.
import {
  APPLIED_COL, ARCHIVE_COL, AUTHOR_COL, BEFORE_COL, DATA_COL, DELETE_COL, EXPORT_COL, KEY_COL, LIST_COL, LOT_COL, ORDER_COL, RECALC_COL, RECEIVED_COL, RESEND_COL, SCHEMA_COL,
  STATE_COL, TABLE_COL, TYPE_COL, BUCKETS, bucketOf, chunk, freeTableId, groupBy, isBlank, isTrue, parseJson,
} from './common.js';
import { REFUSED, STATES, compareOrder, completeLists, destColumns, lastMark, latestByKey, pendingLists, sentColumns } from './journal.js';
import { exchangeColumns } from './exports.js';
import { noteSent, sentElements } from './descriptions.js';

// Échange, chez le document qui l'administre : ce qu'il fait de chaque type de changement reçu d'un
// participant (`regles` de l'export : accepter, refuser, ou garder à valider sur la carte), et d'un
// refus (`refus`) : le participant reprend la ligne d'ici (« corriger », par défaut), ou garde sa
// version et l'écart est signalé ici (« signaler »). Rend null quand tout est accepté : la
// recopie est alors celle de toujours.
export const RULES = ['accepter', 'refuser', 'valider'];
export const REFUSALS = ['corriger', 'signaler'];
export function exchangeRules(exp) {
  const { regles = {}, refus } = exp || {};
  const rule = state => (RULES.includes(regles[state]) ? regles[state] : RULES[0]);
  const rules = Object.fromEntries(STATES.map(state => [state, rule(state)]));
  if (STATES.every(state => rules[state] === RULES[0])) return null;
  return { ...rules, refus: REFUSALS.includes(refus) ? refus : REFUSALS[0] };
}

// Colonnes recopiées, en couples [colonne du journal, colonne de la destination] : colonnes
// envoyées présentes des deux côtés (sous le nom choisi dans `map`, sinon le même), hors colonnes
// techniques de la synchro et formules de la destination. La destination ne garde que `id_sync`.
const TECHNICAL = new Set(['id', 'manualSort', KEY_COL, ORDER_COL, RECALC_COL, DELETE_COL, LIST_COL, APPLIED_COL, AUTHOR_COL, RECEIVED_COL, STATE_COL,
  BEFORE_COL, DATA_COL, SCHEMA_COL, EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, LOT_COL]);
export function copyColumns(journalColIds, destCols, map = {}) {
  const writable = new Set(destCols.filter(c => !c.isFormula).map(c => c.colId));
  return journalColIds.filter(id => !TECHNICAL.has(id) && !id.startsWith('gristHelper_'))
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

// Colonnes reçues effacées à la main dans la destination (noms d'ici) : leur numéro Grist, noté
// au passage précédent (`refs`), n'existe plus, ou elles étaient déjà notées (`dropped`). Elles ne
// sont pas recréées vides à chaque passage, mais signalées ; une colonne de ce nom revenue, ou que
// la SOURCE n'envoie plus, sort de la liste. La clé `id_sync` n'en fait jamais partie.
export function droppedColumns(entry, sent, destColIds) {
  const have = new Set(destColIds);
  const noted = new Set([...Object.keys((entry.refs || {}).cols || {}), ...(entry.dropped || [])]);
  return destColumns(sent)
    .map(c => [c.id, (entry.map || {})[c.id] || c.id]).filter(([, to]) => !have.has(to) && noted.has(to));
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

// Colonnes de données connues d'une table reçue : celles de l'invitation et celles déjà rangées dans `map`.
const knownColumns = ({ columns = [], map = {} }) => new Set([...columns.map(c => c.id), ...Object.keys(map)]);

// Colonnes envoyées arrivées après l'invitation, avec le nom que la destination leur donnerait (`to`, voir
// newColumnsMap). Une entrée qui ne connaissait encore aucune colonne (ancien montage) n'en a pas : tout y paraîtrait nouveau.
export function freshColumns(entry, sent, destColIds) {
  const known = knownColumns(entry);
  const fresh = known.size ? destColumns(sent).filter(c => !known.has(c.id)) : [];
  const names = fresh.length ? newColumnsMap(entry, fresh, destColIds) : {};
  return fresh.map(c => ({ id: c.id, to: names[c.id], label: c.label || c.id, type: c.type }));
}

// Colonnes que la SOURCE a ajoutées à l'export, gardées pour l'historique (nom d'ici, heure ; les
// ADDED_KEPT dernières) : celles que newColumnsMap vient de ranger (`map`). Une entrée qui ne
// connaissait encore aucune colonne (ancien montage) n'en note pas : tout y paraîtrait nouveau.
const ADDED_KEPT = 10;
export function addedColumns({ columns = [], map = {}, addedCols = [] }, next, at) {
  const known = new Set([...columns.map(c => c.id), ...Object.keys(map)]);
  const fresh = Object.keys(next).filter(id => !known.has(id));
  if (!known.size || !fresh.length) return addedCols.length ? addedCols : undefined;
  return [...addedCols, ...fresh.map(id => ({ col: next[id], at }))].slice(-ADDED_KEPT);
}

// Valeur reçue et valeur de la destination égales ? Vide vaut vide ; une liste de choix lue dans
// Grist commence par la marque 'L'.
// Un nombre reçu et le même nombre écrit en texte sont égaux : une Référence qui n'affiche que le
// numéro de ligne (ou une colonne numérique) part en nombre, et la colonne Texte d'ici le garde en texte.
export function sameValue(sent, have) {
  const norm = x => (isBlank(x) ? null : Array.isArray(x) && x[0] === 'L' ? x.slice(1) : x);
  const [a, b] = [norm(sent), norm(have)];
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
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

// Effet noté sur la dernière version d'une clé partie de la SOURCE alors que la destination ne
// l'avait plus (ou pas encore) : ni l'historique ni les retouches ne la montrent.
const LEFT = 'partie';
const SETTLED_GONE = new Set(['suppression', LEFT]);

// Retouches faites à la main dans la destination, lues après la recopie : cellules d'une ligne
// reçue qui diffèrent de la dernière version reçue, et lignes reçues effacées ici alors qu'elles
// sont toujours dans la SOURCE (`gone`). `except` : clés parties de la SOURCE à ce passage. Rend
// [{ id, key, n, row, cells: [[colonne du journal, colonne d'ici, valeur d'ici, valeur de la
// SOURCE]] }] par numéro de ligne (`id` : la ligne d'ici, `row` : la version reçue). Échange : rien
// (une retouche y part vers l'autre document, ce n'est pas un écart). Une ligne gardée en archive
// (sa dernière version la supprime) n'en a pas.
export function manualEdits({ journalRows, destRows, copyCols, exchange = false, except = new Set() }) {
  if (exchange) return [];
  const latest = latestByKey(journalRows);
  const numbers = rowNumbers(destRows);
  const edits = [];
  for (const row of destRows) {
    const version = latest.get(row[KEY_COL]);
    if (!version || isTrue(version.row[DELETE_COL]) || version.row[STATE_COL] === 'suppression') continue;
    const cells = copyCols.filter(([from, to]) => !sameValue(version.row[from], row[to]))
      .map(([from, to]) => [from, to, row[to] ?? null, version.row[from] ?? null]);
    if (cells.length) edits.push({ id: row.id, key: row[KEY_COL], n: numbers.get(row[KEY_COL]) || null, row: version.row, cells });
  }
  for (const [key, version] of latest) {
    if (numbers.has(key) || except.has(key) || isTrue(version.row[DELETE_COL]) || SETTLED_GONE.has(version.row[STATE_COL])) continue;
    edits.push({ id: null, key, n: null, row: version.row, cells: [], gone: true });
  }
  return edits.sort((a, b) => Number(Boolean(a.gone)) - Number(Boolean(b.gone)) || (a.n || 0) - (b.n || 0));
}

// « Corriger » : remet dans les cellules retouchées (voir manualEdits) la valeur de la SOURCE, une
// écriture par groupe de lignes retouchées sur les mêmes colonnes, et fait revenir les lignes
// effacées ici avec toutes leurs valeurs (`copyCols`).
export function restoreActions(edits, destTable, copyCols) {
  const changed = edits.filter(e => !e.gone);
  const back = edits.filter(e => e.gone);
  const groups = groupBy(changed, e => JSON.stringify(e.cells.map(([, to]) => to)));
  return [
    ...[...groups.values()].flatMap(list => chunk(list).map(part => ['BulkUpdateRecord', destTable, part.map(e => e.id),
      Object.fromEntries(part[0].cells.map(([, to], i) => [to, part.map(e => e.cells[i][3])]))])),
    ...chunk(back).map(part => ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(e => e.key) },
      Object.fromEntries(copyCols.map(([from, to]) => [to, part.map(e => e.row[from] ?? null)])), { on_many: 'all' }]),
  ];
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
// la destination a (`listGone`) ; les versions déjà recopiées des autres (`leftGone`, effacées ici
// avant de partir de la SOURCE) ; note dans `marks` les listes traitées.
function droppedKeys(pending, latest, destByKey, marks) {
  const gone = new Set();
  const listGone = [];
  const leftGone = [];
  const known = [...new Set([...destByKey.keys(), ...latest.keys()])];
  const drop = (key, t, listRow) => {
    const version = latest.get(key);
    if (gone.has(key) || (version && (t === null ? version.id > listRow.id : compareOrder(version.order, t) > 0))) return;
    gone.add(key);
    if (version && destByKey.has(key)) listGone.push([version.id, listRow[RECEIVED_COL] ?? null]);
    else if (version && isTrue(version.row[APPLIED_COL]) && !SETTLED_GONE.has(version.row[STATE_COL])) leftGone.push(version.id);
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
  return { gone, listGone, leftGone };
}

const newest = rows => rows.map(r => r[ORDER_COL]).reduce((a, b) => (compareOrder(a, b) >= 0 ? a : b), null);

// Sans effet : la destination a déjà ces valeurs, ou la SOURCE n'a rien changé depuis la version
// déjà recopiée (un renvoi, l'arrivée d'un autre destinataire, une colonne non envoyée modifiée).
// Une retouche faite à la main dans la destination reste donc en place. Échange : seule la
// destination fait foi (une version plus ancienne que la ligne d'ici a déjà été écartée), et la
// case Supprime compte aussi quand la destination l'a (`deleteCol`) : une ligne cochée ici revient
// quand une version plus récente ne l'est pas (refus d'une suppression, voir fixActions).
const deleteDiffers = (ctx, version, row) => ctx.exchange && ctx.deleteCol && isTrue(version.row[DELETE_COL]) !== isTrue(row[DELETE_COL]);
function withoutEffect(ctx, version, here) {
  const before = ctx.exchange ? null : ctx.applied.get(version.row[KEY_COL]);
  if (before && ctx.copyCols.every(([from]) => sameValue(version.row[from], before.row[from]))) return true;
  return here.every(row => ctx.copyCols.every(([from, to]) => sameValue(version.row[from], row[to])) && !deleteDiffers(ctx, version, row));
}

// Effet qu'aurait la dernière version d'une clé pas encore recopiée : 'suppression', 'modif' (dont
// le rattachement d'une ligne sans clé), 'ajout', LEFT (clé qui n'est plus ici) ou '' (sans effet).
// Rien n'est encore noté (voir writeEffect).
function versionEffect(ctx, key, version, gone) {
  const here = ctx.dest.byKey.get(key);
  // Échange : la version reçue n'a d'effet que si elle est plus récente que la ligne d'ici.
  if (ctx.exchange && here && compareOrder(version.order, newest(here)) <= 0) return '';
  if (isTrue(version.row[DELETE_COL]) || gone.has(key)) return deletionEffect(ctx, version, here);
  if (ctx.archived.has(key)) return 'modif'; // ligne gardée en archive, revenue à la SOURCE
  // Sans clé ici : un ajout, ou le rattachement d'une ligne sans clé (colonne commune).
  if (!here) return ctx.matchFrom && ctx.dest.unkeyed.get(version.row[ctx.matchFrom])?.length ? 'modif' : 'ajout';
  return withoutEffect(ctx, version, here) ? '' : 'modif';
}

// Effet d'une version qui supprime (case Supprime, ou clé absente de la dernière liste). Échange à
// plusieurs : une ligne cochée Supprime par un participant reste ici, cochée, pour repartir vers
// les autres ; elle est effacée chez eux.
function deletionEffect(ctx, version, here) {
  if (!here) return LEFT;
  return ctx.hub && withoutEffect(ctx, version, here) ? '' : 'suppression';
}

// Note dans `plan` les lignes à écrire pour l'effet `state`, et rend l'effet écrit : une ligne sans
// clé déjà prise par une version précédente fait d'un rattachement un ajout.
function writeEffect(ctx, plan, key, version, state) {
  const here = ctx.dest.byKey.get(key);
  if (isTrue(version.row[DELETE_COL]) && !ctx.hub && (state === 'suppression' || state === LEFT)) plan.gone.add(key);
  if (!state || state === LEFT || plan.gone.has(key)) return state;
  const candidates = !here && ctx.matchFrom ? ctx.dest.unkeyed.get(version.row[ctx.matchFrom]) : null;
  if (candidates && candidates.length) {
    const row = candidates.shift();
    plan.attached.push([row, version]);
    noteReplaced(plan, ctx.copyCols, version, row);
    return 'modif';
  }
  plan.upserts.push(version);
  if (here) noteReplaced(plan, ctx.copyCols, version, here[0]);
  return state === 'suppression' || here ? state : 'ajout';
}

// Changement d'un participant refusé : il reste dans le journal, noté REFUSED, avec ce qu'il
// aurait remplacé ici et son type (`k`, pour l'historique). « Corriger » : la ligne d'ici repart
// (voir fixActions).
function refuseEffect(ctx, plan, key, version, state) {
  const here = ctx.dest.byKey.get(key);
  if (here) noteReplaced(plan, ctx.copyCols, version, here[0]);
  plan.before.set(version.id, { ...(plan.before.get(version.id) || {}), k: state });
  if (ctx.rules.refus === 'corriger') plan.fixes.push({ key, version, here });
}

// Changement d'un participant à valider : ce que la carte en montre (`cells` : [colonne du journal,
// colonne d'ici, valeur d'ici, valeur proposée], les colonnes qui changent ; toutes pour un ajout
// ou une suppression). La version reste dans le journal, non recopiée, jusqu'à la décision.
function reviewItem(ctx, key, version, state) {
  const here = (ctx.dest.byKey.get(key) || [])[0] || null;
  const cells = ctx.copyCols.map(([from, to]) => [from, to, here ? here[to] ?? null : null, state === 'suppression' ? null : version.row[from] ?? null])
    .filter(([from, to]) => state !== 'modif' || !here || !sameValue(version.row[from], here[to]));
  if (state === 'modif' && here && deleteDiffers(ctx, version, here)) cells.push([DELETE_COL, DELETE_COL, isTrue(here[DELETE_COL]), isTrue(version.row[DELETE_COL])]);
  return { id: version.id, key, state, row: version.row, cells };
}

// Le plan en actions Grist : ajouts et modifications par clé, rattachements, suppressions, puis
// marques dans le journal et, pour l'historique, ce qui a été remplacé.
function consolidationActions({ destTable, journalTable, copyCols, exchange, deleteCol, archive, uncheck }, { upserts, attached, removeIds, marks, listGone, leftGone, before }) {
  const values = (versions) => {
    const out = Object.fromEntries(copyCols.map(([from, to]) => [to, versions.map(v => v.row[from] ?? null)]));
    if (exchange && deleteCol) out[DELETE_COL] = versions.map(v => isTrue(v.row[DELETE_COL]));
    if (uncheck && !Object.hasOwn(out, ARCHIVE_COL)) out[ARCHIVE_COL] = versions.map(() => false);
    return exchange ? { ...out, [ORDER_COL]: versions.map(v => v.order ?? null) } : out;
  };
  return [
    ...chunk(upserts).map(part => ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(v => v.row[KEY_COL]) }, values(part), { on_many: 'all' }]),
    ...chunk(attached).map(part => ['BulkUpdateRecord', destTable, part.map(([row]) => row.id),
      { [KEY_COL]: part.map(([, v]) => v.row[KEY_COL]), ...values(part.map(([, v]) => v)) }]),
    ...chunk(removeIds).map(part => (archive ? ['BulkUpdateRecord', destTable, part, { [ARCHIVE_COL]: part.map(() => true) }] : ['BulkRemoveRecord', destTable, part])),
    ...chunk([...marks]).map(part => ['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [APPLIED_COL]: part.map(() => true), [STATE_COL]: part.map(([, state]) => state) }]),
    ...chunk(listGone).map(part => ['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [STATE_COL]: part.map(() => 'suppression'), [RECEIVED_COL]: part.map(([, at]) => at) }]),
    ...chunk(leftGone).map(part => ['BulkUpdateRecord', journalTable, part, { [STATE_COL]: part.map(() => LEFT) }]),
    ...chunk([...before]).map(part => ['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [BEFORE_COL]: part.map(([, was]) => JSON.stringify(was)) }]),
  ];
}

// Refus « corriger » : la ligne d'ici repart vers les participants, datée juste après la version
// refusée (FIX_STEP), et l'emporte donc chez celui qui l'a envoyée. Un ajout refusé laisse ici une
// ligne cochée Supprime, qui efface la sienne (sans case Supprime ici, rien ne peut partir). Ces
// écritures ne touchent pas la ligne 'echange' : la ligne doit repartir (voir le lot dans
// formulas.js) ; le widget la demande aussi au lot (Synchro_Renvoi), qui l'envoie à coup sûr.
const FIX_STEP = 0.001;
function fixActions(destTable, fixes, copyCols, deleteCol, now) {
  const order = f => (typeof f.version.order === 'number' ? f.version.order : now) + FIX_STEP;
  const kept = fixes.filter(f => f.here).flatMap(f => f.here.map(row => [row.id, order(f)]));
  const added = deleteCol ? fixes.filter(f => !f.here) : [];
  return [
    ...chunk(kept).map(part => ['BulkUpdateRecord', destTable, part.map(([id]) => id), { [ORDER_COL]: part.map(([, at]) => at) }]),
    ...chunk(added).map(part => ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(f => f.key) }, {
      ...Object.fromEntries(copyCols.map(([from, to]) => [to, part.map(f => f.version.row[from] ?? null)])),
      [DELETE_COL]: part.map(() => true), [ORDER_COL]: part.map(order),
    }, { on_many: 'all' }]),
  ];
}

// Écarts laissés par un refus : dernière version d'une clé refusée que la ligne d'ici n'a pas
// remplacée depuis (aucune modification plus récente ici). Un refus corrigé n'en laisse pas (la
// ligne d'ici est datée après). Rend [{ key, n, state, row, cells }] par numéro de ligne, comme
// reviewItem (`state` : le changement refusé).
export function refusedGaps({ journalRows, destRows, copyCols }) {
  const dest = groupBy(destRows.filter(r => !isBlank(r[KEY_COL])), r => r[KEY_COL]);
  const numbers = rowNumbers(destRows);
  const gaps = [];
  for (const [key, version] of latestByKey(journalRows)) {
    const here = dest.get(key);
    if (version.row[STATE_COL] !== REFUSED || (here && compareOrder(newest(here), version.order) > 0)) continue;
    const row = (here || [])[0];
    const cells = copyCols.map(([from, to]) => [from, to, row ? row[to] ?? null : null, version.row[from] ?? null])
      .filter(([from, to]) => !row || !sameValue(version.row[from], row[to]));
    const { k } = parseJson(version.row[BEFORE_COL]) || {};
    gaps.push({ key, n: numbers.get(key) || null, state: STATES.includes(k) ? k : row ? 'modif' : 'ajout', row: version.row, cells });
  }
  return gaps.sort((a, b) => (a.n || Infinity) - (b.n || Infinity));
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
// Échange à plusieurs, côté du document qui administre (`hub`) : `Supprime` n'efface pas ici, elle
// est recopiée (la ligne cochée repart vers les autres participants, qui l'effacent).
// Règles du document qui administre un Échange (`rules`, voir exchangeRules) : un changement à
// valider reste dans le journal, sans marque (`pending`, voir reviewItem), jusqu'à une décision
// (`decisions` : version du journal -> accepter ou refuser) ; un changement refusé est marqué
// REFUSED et, à corriger, rend les écritures qui font repartir la ligne d'ici (`fix` : actions et
// clés, voir fixActions), à appliquer à part.
// `now` : heure du passage (secondes), pour dater un refus corrigé dont la version n'a pas d'heure.
// Échange, pièces jointes (`waiting` : voir waitingVersions) : une version qui cite un fichier pas encore
// arrivé n'est ni écrite ni marquée (`waiting` du résultat) ; elle l'est à son arrivée. Elle n'est
// montrée à valider qu'une fois ses fichiers là.
// Réception en archive (`archive`, jamais en Échange) : rien n'est effacé ici ; une ligne partie de
// la SOURCE reste, cochée ARCHIVE_COL, et n'est plus suivie par les listes ; une nouvelle version
// de sa clé la décoche. Décocher l'archive n'efface pas les lignes déjà archivées : elles restent
// cochées (`archived` se lit toujours), seules les suivantes sont effacées.
export function planConsolidation({
  journalRows, destRows, copyCols, destTable, journalTable, matchCol = '', exchange = false, hub = false, deleteCol = false, rules = null, decisions = new Map(),
  now = 0, archive = false, waiting = new Map(),
}) {
  const dest = indexDest(destRows, matchCol);
  const latest = latestByKey(journalRows);
  const marks = new Map(); // ligne du journal -> effet ('' pour une liste ou une version sans effet)
  const pending = pendingLists(journalRows);
  const archived = exchange ? new Set() : new Set(destRows.filter(r => isTrue(r[ARCHIVE_COL]) && !isBlank(r[KEY_COL])).map(r => r[KEY_COL]));
  const followed = archived.size ? new Map([...dest.byKey].filter(([key]) => !archived.has(key))) : dest.byKey;
  const { gone, listGone, leftGone } = exchange ? { gone: new Set(), listGone: [], leftGone: [] } : droppedKeys(pending, latest, followed, marks);
  if (exchange) pending.forEach(({ row }) => marks.set(row.id, ''));
  const ctx = { ...consolidationContext({ journalRows, copyCols, matchCol, exchange, hub, deleteCol, rules }, dest), archived, waiting: exchange ? waiting : new Map() };
  const plan = { gone, marks, upserts: [], attached: [], before: new Map(), fixes: [], pending: [], waiting: [], stats: { added: 0, updated: 0, removed: 0 } };
  planVersions(ctx, plan, latest, decisions);
  const { removed, numbers } = planRemovals({ plan, dest, destRows, archived });
  plan.stats.removed += removed.length;
  const removeIds = removed.flatMap(key => dest.byKey.get(key).map(r => r.id));
  for (const key of removed) if (latest.has(key)) plan.before.set(latest.get(key).id, { n: numbers.get(key) });
  return {
    actions: [
      ...consolidationActions({ destTable, journalTable, copyCols, exchange, deleteCol: ctx.deleteCol, archive: archive && !exchange, uncheck: archived.size > 0 || (archive && !exchange) }, { ...plan, removeIds, listGone, leftGone }),
    ],
    stats: plan.stats, gone, attached: plan.attached,
    pending: plan.pending.map(item => ({ ...item, n: numbers.get(item.key) || null })),
    waiting: plan.waiting.map(item => ({ ...item, n: numbers.get(item.key) || null })),
    fix: { actions: fixActions(destTable, plan.fixes, copyCols, ctx.deleteCol, now), keys: plan.fixes.map(f => f.key) },
  };
}

// Ce que la recopie d'une table sait d'elle (voir planConsolidation). Le document qui administre
// un Échange à plusieurs a toujours la case Supprime.
function consolidationContext({ journalRows, copyCols, matchCol, exchange, hub, deleteCol, rules }, dest) {
  return {
    dest, copyCols, exchange, hub: exchange && hub, deleteCol: exchange && (deleteCol || hub), rules: exchange ? rules : null,
    matchFrom: copyCols.find(([, to]) => to === matchCol)?.[0],
    applied: latestByKey(journalRows.filter(r => isTrue(r[APPLIED_COL]) && !isTrue(r[DELETE_COL]))),
  };
}

// Effet de la dernière version de chaque clé pas encore recopiée, noté dans `plan` : écrit,
// refusé, en attente de ses fichiers (Échange, voir waitingVersions) ou d'une décision (règles d'un
// Échange, `decisions` d'abord). Une version qui attend ses fichiers reste dans le journal, sans
// marque ; une suppression, une version sans effet et une version refusée n'en attendent aucun.
const STATS = { ajout: 'added', modif: 'updated' };
const WRITES = new Set(['ajout', 'modif']);
function planVersions(ctx, plan, latest, decisions) {
  for (const [key, version] of latest) {
    if (isTrue(version.row[APPLIED_COL])) continue;
    const state = versionEffect(ctx, key, version, plan.gone);
    const rule = ctx.rules && STATES.includes(state) ? decisions.get(version.id) || ctx.rules[state] : RULES[0];
    if (rule === 'refuser') {
      refuseEffect(ctx, plan, key, version, state);
      plan.marks.set(version.id, REFUSED);
    } else if (ctx.waiting.has(version.id) && WRITES.has(state)) {
      plan.waiting.push({ id: version.id, key, files: ctx.waiting.get(version.id) });
    } else if (rule === 'valider') {
      plan.pending.push(reviewItem(ctx, key, version, state));
    } else {
      const written = writeEffect(ctx, plan, key, version, state);
      plan.marks.set(version.id, written);
      // Les suppressions comptent à part (voir planRemovals), sauf celles que garde le document
      // qui administre un Échange à plusieurs.
      const stat = written === 'suppression' && ctx.hub ? 'removed' : STATS[written];
      if (stat) plan.stats[stat]++;
    }
  }
}

// Suppressions du passage : clés de `plan.gone` encore ici, sauf celles déjà gardées en archive ;
// `numbers` : numéros des lignes d'ici, s'il en faut. La CIBLE est passive : ce que la SOURCE
// supprime, elle le supprime, quel qu'en soit le nombre (la SOURCE répond de ses données ; seule
// l'archive garde les lignes, par choix de la CIBLE).
function planRemovals({ plan, dest, destRows, archived }) {
  const removed = [...plan.gone].filter(key => dest.byKey.has(key) && !archived.has(key));
  const numbers = removed.length || plan.pending.length || plan.waiting.length ? rowNumbers(destRows) : new Map();
  return { removed, numbers };
}

// Colonnes reçues pour une table, et la correspondance. Échange, côté du document qui a invité
// (`allowed` : colonnes que son export envoie pour cette destination) : l'autre document n'écrit
// que celles-là (voir exchangeColumns). Une colonne ajoutée à l'export après coup ne remplace
// jamais une colonne de la destination qui porte déjà son nom (elle prend un nom libre) ; elle
// est notée pour l'historique (`addedCols`, à l'heure `now`, en secondes).
// `hold` (la réception demande l'accord de la personne, voir structure.js) : les colonnes arrivées après coup ne sont
// ni rangées ni recopiées ; elles sont rendues dans `held`, `all` garde toutes les colonnes envoyées.
export function receivedColumns(entry, tableRows, schema, allowed, now, { hold = false } = {}) {
  let sent = sentColumns(tableRows, entry.columns || []);
  const doc = (sent.find(c => c.doc) || {}).doc; // langue et monnaie du document de la SOURCE, si elle les envoie
  const sends = sentElements(sent); // ce que l'export envoie en plus des données (voir descriptions.js)
  const { tableNote } = noteSent(sent);
  let next = entry;
  if (allowed) {
    const kept = exchangeColumns(sent, allowed, entry.map);
    sent = kept.sent;
    next = { ...entry, map: kept.map };
  }
  const all = sent;
  const destIds = schema.columns(next.dest).map(c => c.colId);
  const held = hold && !allowed ? freshColumns(next, sent, destIds) : [];
  if (held.length) sent = sent.filter(c => !held.some(h => h.id === c.id));
  const map = newColumnsMap(next, destColumns(sent), destIds);
  return { sent, all, held, doc, sends, tableNote, entry: map ? { ...next, map, addedCols: addedColumns(next, map, now) } : next };
}
