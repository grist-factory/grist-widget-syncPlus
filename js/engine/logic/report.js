// CIBLE : ce qu'un passage de recopie garde pour l'onglet (voir target/loop.js), en fonctions pures :
// arrivées suspectes, fin d'envoi, tables proposées, pièces jointes attendues, et la carte d'une
// table (historique, retouches, changements à valider, écarts d'un refus).
import { KEY_COL } from './common.js';
import { recentChanges, sentColumns } from './journal.js';
import { filesState, short } from './files.js';

// Retouches, changements à valider et écarts d'un refus : les SHOWN premiers sont gardés pour la
// carte, qui les montre (avec le compte du reste).
export const SHOWN = 10;
// Pièces jointes : fichiers attendus notés par table (pour compléter les cellules à leur arrivée,
// voir fillActions), et fichiers trop gros nommés sur la carte, au plus.
const WAITING_KEPT = 1000;
const BIG_KEPT = 20;

// Arrivées suspectes notées dans le journal : leur nombre cumulé, l'heure (`at`, secondes) de la
// dernière, et celle du dernier flot anormal.
export function nextSuspect(was = {}, rejected, flood, at) {
  const now = Math.floor(at);
  return { n: (was.n || 0) + rejected, at: now, ...(flood ? { flood: now } : was.flood ? { flood: was.flood } : {}) };
}

// Fin de l'envoi annoncée par la SOURCE (heure), gardée tant que rien d'autre n'arrive ; `now` en
// secondes, pour un avis sans heure.
export const endedAt = (note, plan, now) => (plan.ended === undefined ? note.ended : plan.ended && (plan.ended.at || Math.floor(now))) || undefined;

// Tables que la SOURCE a ajoutées à l'export, pas encore rangées ni refusées (`pending`), et
// celles qu'on peut déjà proposer (leurs colonnes sont connues).
export function offersOf(groups, note) {
  const known = new Set(note.tables.map(tb => tb.table));
  const pending = [...groups.keys()].filter(table => !known.has(table) && !note.refused.includes(table));
  const offers = pending.map((table) => {
    const tableRows = groups.get(table);
    return { table, columns: sentColumns(tableRows, []), n: new Set(tableRows.map(r => r[KEY_COL]).filter(Boolean)).size };
  }).filter(o => o.columns.length);
  return { pending, offers };
}

// Pièces jointes d'une table : pour la note, les fichiers attendus (`waiting`, empreintes abrégées) ;
// pour la carte, leur nombre, les fichiers trop gros et les versions d'un Échange qui les attendent avant
// d'être recopiées (`held`, voir waitingVersions). Un lien public n'attend aucun fichier.
export function filesSummary(tableRows, fileCols, present, isPublic, held = []) {
  if (!fileCols.length) return { waiting: undefined, card: undefined };
  const files = filesState(tableRows, fileCols.map(([from]) => from), present);
  return {
    waiting: files.waiting.length && !isPublic ? files.waiting.map(short).slice(0, WAITING_KEPT) : undefined,
    card: { waiting: isPublic ? 0 : files.waiting.length, big: files.big.slice(0, BIG_KEPT), public: isPublic, held: held.length },
  };
}

// Forme d'un export de retour (tables et colonnes), pour savoir s'il suit la note de l'Échange.
export const exportShape = tables => JSON.stringify(tables.map(tb => [tb.table, tb.columns.map(c => `${c.id}>${c.as || ''}`)]).sort());

// Changements à valider et écarts d'un refus, nommés pour la carte : les SHOWN premiers, et
// toutes les versions à valider (`pendingIds`, pour « Tout accepter »).
const named = (items, labelCol) => items.slice(0, SHOWN).map(({ id, n, state: change, row, cells, gone }) => ({
  id, n, state: change, label: labelCol ? String(row[labelCol] ?? '') : '', cells, ...(gone ? { gone } : {}),
}));
const reviewResult = (pending = [], gaps = [], labelCol = '') => ({
  pending: named(pending, labelCol), pendingIds: pending.map(p => p.id), pendingCount: pending.length, gaps: named(gaps, labelCol), gapCount: gaps.length,
});

// Retouches gardées pour la carte : les premières lignes, nommées, les colonnes effacées et les
// comptes.
export const driftResult = (drift, labelCol, droppedCols) => ({
  drift: drift.slice(0, SHOWN).map(({ n, row, cells, gone }) => ({ n, label: labelCol ? String(row[labelCol] ?? '') : '', cells, ...(gone ? { gone } : {}) })),
  droppedCols,
  driftCount: drift.reduce((sum, d) => sum + (d.gone ? 1 : d.cells.length), 0) + droppedCols.length,
  driftGone: drift.filter(d => d.gone).length,
});

// Ce que la carte montre d'une table : compteurs, colonne qui nomme les lignes, historique depuis
// la visite précédente (`lastVisit`, secondes ; dont les colonnes ajoutées par la SOURCE, `added`),
// valeurs retouchées à la main (`drift`). Table verrouillée que la personne ne peut pas recopier
// (`locked`) : rien de plus.
export function tableResult({ entry, stats, copyCols, types, links, relinkable, formulas, structure, numbers, drift, dropped, pending, gaps, files, error, locked }, groups, lastVisit) {
  if (error) return { table: entry.table, error };
  if (locked) return { table: entry.table, stats, dest: entry.dest, locked: true };
  const labelCol = copyCols.some(([from]) => from === entry.label) ? entry.label : (copyCols[0] || [])[0];
  const recent = recentChanges(groups.get(entry.table) || [], labelCol, lastVisit, Infinity, { copyCols, numbers });
  const added = (entry.addedCols || []).filter(a => a.at > (lastVisit || 0));
  return {
    table: entry.table, stats, dest: entry.dest, copyCols, labelCol, labelCols: copyCols.map(([c]) => c), types, links, formulas, structure: structure || null, recent, added, files,
    relinkable: (relinkable || []).map(s => ({ from: s.from, to: s.to, list: s.list, target: s.target })),
    ...driftResult(drift, labelCol, dropped), ...reviewResult(pending, gaps, labelCol),
  };
}

// Ce que la carte d'une table montre en plus des compteurs.
export const cardShape = (result = {}) => JSON.stringify([
  result.drift || [], result.driftCount || 0, result.pendingIds || [], result.gapCount || 0, result.files || null, result.structure || null, result.relinkable || [],
  (result.links || []).map(s => [s.to, s.target, Boolean(s.list)]),
]);
export const wrote = stats => Boolean(stats && stats.added + stats.updated + stats.removed);
