// SOURCE : colonnes ajoutées après coup aux tables d'un export (voir logic/new-columns.js). La référence (`known`) se pose à
// l'enregistrement de l'export ; un export d'avant ce suivi la reçoit à la première ouverture d'un propriétaire, sans rien dire (ce qui
// n'est pas envoyé alors est un choix). Envoyer ces colonnes enregistre l'export avec elles, comme « Modifier », et renvoie la table ;
// les ignorer les range parmi les colonnes connues. Un export peut les envoyer seul (`autoCols`) : jamais par défaut, jamais en Échange.
import { exportFlags, knownColumns, newColumns, widenedSelection } from '../logic/new-columns.js';
import { setExport } from '../logic/notes.js';
import { readSchema, withLock } from '../port.js';
import { finishEdit, saveChosenExport } from './export.js';
import { readSourceNote, updateSourceNote } from './synchro.js';

const LOCK = 'gristsync-new-columns';
const tracked = exp => !exp.retour && !exp.echange;

// Pose la référence des exports qui n'en ont pas encore (ou dont une table n'y figure pas) ; rend vrai si la note a changé.
export async function baselineNewColumns(exports) {
  const missing = exp => exp.tables.filter(tb => !Array.isArray((exp.known || {})[tb.table]));
  // Rien à poser dans le cas courant : le schéma (une lecture de plus toutes les 10 secondes) n'est lu que s'il y a une référence à poser.
  if (!exports.some(exp => tracked(exp) && missing(exp).length)) return false;
  const schema = await readSchema();
  const due = exports.filter(exp => tracked(exp) && missing(exp).some(tb => schema.has(tb.table)));
  if (!due.length) return false;
  await updateSourceNote(note => due.reduce((next, exp) => setExport(next, exp.id, { known: { ...(exp.known || {}), ...knownColumns(schema, exp.tables.filter(tb => !Array.isArray((exp.known || {})[tb.table]))) } }), note));
  return true;
}

// Les colonnes nouvelles de l'export `exp` : [{ table, columns: [{ id, type }] }], lues avec la note et le schéma d'à l'instant.
export async function pendingColumns(exp) {
  if (!tracked(exp)) return [];
  const schema = await readSchema();
  const entry = readSourceNote(schema).exports.find(e => e.id === exp.id) || {};
  return newColumns(schema, exp.tables, entry.known);
}

// Les envoyer : l'export est enregistré avec ces colonnes en plus (ses autres choix inchangés), sa table renvoyée (voir finishEdit).
// Rend le nombre de lignes renvoyées, null si le renvoi attend son tour, ou `false` s'il n'y avait rien de nouveau.
export async function sendNewColumns(exp, progress) {
  return withLock(LOCK, async () => {
    const additions = (await pendingColumns(exp)).map(({ table, columns }) => ({ table, columns: columns.map(c => c.id) }));
    if (!additions.length) return false;
    const saved = await saveChosenExport({
      exp, name: exp.name, selection: widenedSelection(exp.tables, additions), ...exportFlags(exp.tables), autoCols: Boolean(exp.autoCols),
    });
    return finishEdit(exp, { name: exp.name, changed: saved.changed }, progress);
  });
}

// Les ignorer : elles sont connues, l'export ne les envoie pas et n'en parle plus.
export async function dismissNewColumns(exp) {
  const schema = await readSchema();
  await updateSourceNote(note => setExport(note, exp.id, { known: knownColumns(schema, exp.tables) }));
}

// Exports qui les envoient seuls (`autoCols`) : rend vrai si l'un d'eux en a envoyé. Une table que le renvoi met en attente repart au
// passage suivant.
export async function autoSendNewColumns(exports) {
  let sent = false;
  // `fresh` (calculé par l'écran avec le schéma qu'il vient de lire) évite de relire le schéma d'un export qui n'a rien de nouveau.
  for (const exp of exports.filter(e => tracked(e) && e.autoCols && (e.fresh === undefined || e.fresh.length))) sent = (await sendNewColumns(exp)) !== false || sent;
  return sent;
}
