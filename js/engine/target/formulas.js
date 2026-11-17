// CIBLE : les formules de colonne que la SOURCE envoie avec ses colonnes (voir logic/column-formulas.js). Ce fichier fait
// l'écriture : une colonne que le widget a créée devient une colonne de formule (`ModifyColumn`). Rien n'est posé par un passage
// ordinaire : seulement sur le clic d'un propriétaire (« Reprendre depuis la SOURCE », case « Formules », après lecture de
// chaque formule), jamais en Échange (les colonnes y vont dans les deux sens, par nom).
import { apply, readSchema } from '../port.js';
import { planFormulas } from '../logic/column-formulas.js';

// Lit les formules envoyées pour la table reçue `entry` et, avec `replace`, pose celles qui n'ont pas d'objection. Rend les lignes
// à montrer à la personne (`items`, voir planFormulas) ; `ctx.schema` est relu après une écriture. Une colonne devenue formule n'est
// plus recopiée (la destination refuse d'y écrire une valeur : `copyColumns` ne garde que les colonnes de données).
export async function formulaColumns(ctx, entry, columns, { replace = false } = {}) {
  if (ctx.exchange) return [];
  const tables = new Map([...ctx.dests].map(([table, tb]) => [table, tb.dest]));
  const plan = planFormulas(ctx.schema, entry, columns, { tables, replace });
  if (plan.actions.length) {
    await apply(plan.actions);
    ctx.schema = await readSchema();
  }
  return plan.items;
}
