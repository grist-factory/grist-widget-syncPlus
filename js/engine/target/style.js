// CIBLE : la mise en forme que la SOURCE envoie avec ses colonnes (voir options.js, rules.js, docformat.js).
// Ce fichier fait les écritures : les règles de mise en forme conditionnelle, et la langue du document.
import { apply, fetchRows, readSchema } from '../port.js';
import { docFormatOf, formatAction } from '../logic/docformat.js';
import { finishRules, madeHelpers, planRules, startRules } from '../logic/received.js';

// Règles de mise en forme conditionnelle des colonnes reçues (voir planRules). Chaque règle passe en deux
// temps (Grist ne dit le nom de sa colonne cachée qu'après l'avoir créée) ; si le second échoue, les
// colonnes cachées déjà créées sont retirées, sinon le passage suivant en poserait d'autres. Rend l'entrée
// de la note à jour (`styled` : colonnes dont le sort est décidé) ; `ctx.schema` est relu après une écriture.
// Jamais en Échange (les colonnes y vont dans les deux sens, et la SOURCE n'y envoie pas sa mise en forme).
export async function styleColumns(ctx, entry, columns, { replace = false } = {}) {
  if (ctx.exchange) return entry;
  const plan = planRules(ctx.schema, entry, columns, { replace });
  if (plan.todo.length) {
    const first = startRules(entry.dest, plan.todo);
    const { retValues } = await apply(first.actions);
    try {
      await apply(finishRules(entry.dest, plan.todo, first.owners, retValues));
    } catch (e) {
      const helpers = madeHelpers(first.owners, retValues);
      await apply(helpers.map(helper => ['RemoveColumn', entry.dest, helper])).catch(() => {});
      throw e;
    }
    ctx.schema = await readSchema();
  }
  const decided = [...plan.todo.map(item => item.id), ...plan.settled];
  return decided.length ? { ...entry, styled: [...new Set([...(entry.styled || []), ...decided])] } : entry;
}

// Langue et monnaie du document d'ici, lues dans `_grist_DocInfo`.
export const readDocFormat = async () => docFormatOf(await fetchRows('_grist_DocInfo'));

// Met la langue et la monnaie du document d'ici d'accord avec celles de la SOURCE (`wanted`, voir
// formatGap). Réservé aux propriétaires par l'écran ; Grist range l'action dans l'historique (Ctrl+Z).
export async function alignDocFormat(wanted) {
  const action = formatAction(await fetchRows('_grist_DocInfo'), wanted);
  if (action) await apply([action]);
  return Boolean(action);
}
