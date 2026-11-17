// Carte d'une réception : « Ajouter le widget à la page de la table reçue ». Un seul widget ouvert suffit pour recopier toutes
// les réceptions du document (la recopie parcourt tous les journaux), mais il ne tourne que page ouverte : une table créée par
// le widget a sa propre page, sans lui. Ce bouton pose une section du widget sur la page de la table reçue, là où la personne
// reste. L'accès complet de la nouvelle section reste à accepter dans le panneau de droite (voir addWidgetToPage).
import { addWidgetToPage, widgetSpots } from '../engine/pages.js';
import { servedAt } from '../config.js';
import { el, openModal, pickField } from '../ui.js';
import { t } from '../i18n.js';

let spots = new Map(); // table -> { view, there }, relu à chaque ouverture de l'onglet (pas à chaque redessin périodique)

const receivingTables = group => [...new Set(group.note.tables.map(tb => tb.dest))];

// Relit où est le widget pour les tables que reçoivent ces réceptions. Une lecture refusée (droits) : aucun bouton.
export async function readWidgetSpots(groups) {
  const dests = [...new Set(groups.filter(g => !g.waiting && !g.note.retour).flatMap(receivingTables))];
  spots = dests.length ? await widgetSpots(dests, servedAt()).catch(() => new Map()) : new Map();
}

// Les tables de cette réception où le widget peut être posé : aucune s'il est déjà sur la page de l'une d'elles ou si la
// réception n'a pas de table ici (attente du lien, retour d'un Échange), et jamais une table sans page.
export function widgetCandidates(group) {
  if (group.waiting || group.note.retour) return [];
  const dests = receivingTables(group).filter(dest => spots.has(dest));
  return dests.some(dest => spots.get(dest).there) ? [] : dests.filter(dest => spots.get(dest).view);
}

// Texte du bouton : la table s'il n'y en a qu'une.
export const widgetLabel = candidates => (candidates.length === 1 ? t('recv.widget.add', { table: candidates[0] }) : t('recv.widget.addSome'));

// Fenêtre d'explication (ce qui est ajouté, l'accès à accepter ensuite) ; avec plusieurs tables, la personne choisit celle
// dont la page recevra le widget. Rend la table choisie, ou null si elle renonce.
function chooseTable(candidates) {
  return new Promise((resolve) => {
    let answered = false;
    const field = candidates.length > 1 ? pickField({ items: candidates.map(dest => ({ value: dest, label: dest })), value: candidates[0], label: t('recv.widget.pick') }) : null;
    const table = field ? t('recv.widget.chosen') : candidates[0];
    const answer = (value, modal) => { answered = true; resolve(value); modal.close(); };
    openModal({
      title: t('recv.widget.title'), width: 480,
      body: el('div', {}, el('p', {}, t('recv.widget.body', { table })), field ? el('div', { class: 'form' }, el('label', {}, t('recv.widget.pick')), field) : null,
        el('p', { class: 'small muted' }, t('recv.widget.access'))),
      onClose: () => { if (!answered) resolve(null); },
      buttons: [
        { label: t('common.cancel'), onClick: modal => answer(null, modal) },
        { label: t('recv.widget.ok'), kind: 'btn-primary', onClick: modal => answer(field ? field.value() : candidates[0], modal) },
      ],
    });
  });
}

// Le geste : explication, choix de la table, section ajoutée. Rend `{ dest, added }` (`added` faux : il y était déjà), ou null
// si la personne renonce.
export async function addWidgetFor(group) {
  const dest = await chooseTable(widgetCandidates(group));
  if (!dest) return null;
  const { added } = await addWidgetToPage(dest, servedAt());
  return { dest, added };
}
