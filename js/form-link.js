// Lien du formulaire de réception d'un journal (CIBLE, ou retour d'un Échange côté SOURCE) : où le
// trouver, comment le copier, et le test qui vérifie qu'il écrit bien dans ce journal.
import { AUTHOR_COL, KEY_COL, randomHex } from './logic/common.js';
import { maskKey } from './logic/codes.js';
import { fetchRows, gristFetch, selectRows, withLock } from './grist.js';
import { formPages } from './pages.js';
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

// Le lien écrit-il dans ce journal-ci ? Une ligne marquée d'un nombre tiré au hasard part par la
// clé, comme le fera le webhook (ce qui valide d'un coup la clé, la publication, le nom de la table
// et `?flat=1`), et doit arriver dans `journal`. Le lien d'un autre formulaire ou d'un autre
// document est refusé : la réponse enverrait les données ailleurs. Le nettoyage du journal efface
// la ligne ; le verrou de la recopie l'en empêche avant la vérification. Écriture anonyme en JSON :
// l'en-tête Content-Type suffit à Grist.
export function testUrl(url, journal) {
  const probe = randomHex(8);
  return withLock('gristsync-consolidation', async () => {
    let response;
    try {
      response = await gristFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ [KEY_COL]: '', [AUTHOR_COL]: probe }]) });
    } catch (e) {
      throw new Error(t('error.linkTest', { detail: e.message }));
    }
    const text = await response.text();
    if (!response.ok) throw new Error(t('error.linkTest', { detail: maskKey(`HTTP ${response.status} ${text.slice(0, 120)}`) }));
    const rows = (await selectRows(journal, [AUTHOR_COL])) || await fetchRows(journal);
    if (!rows.some(r => r[AUTHOR_COL] === probe)) throw new Error('linkElsewhere');
  });
}
