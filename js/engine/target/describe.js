// CIBLE : les descriptions que la SOURCE envoie avec ses colonnes (voir logic/descriptions.js). Ce fichier fait les
// écritures : description de colonne (`_grist_Tables_column`) et de table (section de données brutes,
// `_grist_Views_section`). Jamais en Échange (les colonnes y vont dans les deux sens, par nom).
import { apply, fetchRows } from '../port.js';
import { planNotes } from '../logic/descriptions.js';

// Pose les descriptions reçues sur les colonnes que le widget a créées (une fois, et seulement si elles n'en ont pas),
// et sur la table si la sienne est vide. `replace` : les colonnes reçues prennent la description de la SOURCE,
// `replaceTable` : la table aussi (« Reprendre depuis la SOURCE »). Rend l'entrée de la note à jour (`described` :
// colonnes décidées ; `tabled` : la table l'est).
export async function describeColumns(ctx, entry, columns, { tableNote = null, replace = false, replaceTable = false } = {}) {
  if (ctx.exchange) return entry;
  const wantTable = typeof tableNote === 'string' && (replaceTable || (!entry.tabled && tableNote));
  const sections = wantTable ? await fetchRows('_grist_Views_section') : null;
  const plan = planNotes(ctx.schema, entry, columns, { replace, replaceTable, tableNote, sections });
  if (plan.actions.length) await apply(plan.actions);
  const described = [...new Set([...(entry.described || []), ...plan.described])];
  const next = { ...entry, ...(described.length ? { described } : {}), ...(plan.tabled ? { tabled: true } : {}) };
  return JSON.stringify(next) === JSON.stringify(entry) ? entry : next;
}
