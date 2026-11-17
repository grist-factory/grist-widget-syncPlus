// CIBLE : l'ordre et les colonnes cachées que la SOURCE envoie avec ses colonnes (voir logic/layout.js). Ce fichier fait les
// écritures : champs de la section de la page de la table (`_grist_Views_section_field`). Jamais en Échange (les colonnes y vont
// dans les deux sens, par nom).
import { apply, fetchRows } from '../port.js';
import { isPos, layoutSent, planLayout } from '../logic/layout.js';

// Pose la mise en page reçue sur les colonnes que le widget a créées (une fois chacune, `laid`). `replace` : toutes les colonnes
// reçues la reprennent (« Reprendre depuis la SOURCE »). Rend l'entrée de la note à jour (`laid` : colonnes décidées). Rien n'est
// lu dans le document tant que la SOURCE n'envoie pas de mise en page ou qu'il n'y a rien à décider.
export async function layoutColumns(ctx, entry, columns, { replace = false } = {}) {
  if (ctx.exchange || !layoutSent(columns)) return entry;
  const own = new Set(entry.own || []);
  const todo = columns.filter(c => isPos(c.pos) && own.has(c.id) && (replace || !(entry.laid || []).includes(c.id)));
  if (!todo.length) return entry;
  const [sections, fields] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Views_section_field')]);
  const plan = planLayout(ctx.schema, entry, columns, { sections, fields, replace });
  if (plan.actions.length) await apply(plan.actions);
  const laid = [...new Set([...(entry.laid || []), ...plan.laid])];
  return laid.length === (entry.laid || []).length ? entry : { ...entry, laid };
}
