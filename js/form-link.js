// Lien du formulaire de réception d'un journal (CIBLE, ou retour d'un Échange côté SOURCE) : où le
// trouver et comment le copier. Le test qui vérifie qu'il écrit bien dans ce journal est dans le
// moteur (engine/form-link.js).
import { formPages } from './engine/pages.js';
import { el } from './ui.js';
import { t } from './i18n.js';

// Où est le formulaire d'un journal.
export async function formWhere(journal) {
  const page = (await formPages()).get(journal);
  return page ? t('recv.link.where.page', { page: page.name }) : t('recv.link.where');
}

// Les deux images qui montrent comment copier le lien.
export const linkFigures = () => [['recv.link.step1', 'img/aide-partager.png'], ['recv.link.step2', 'img/aide-copier.png']]
  .map(([key, src]) => el('figure', { class: 'help-figure' }, el('figcaption', {}, t(key)), el('img', { src, alt: '' })));
