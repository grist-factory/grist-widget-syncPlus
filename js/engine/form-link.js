// Le test du lien d'un formulaire de réception (CIBLE, ou retour d'un Échange côté SOURCE) : il vérifie
// que le lien écrit bien dans ce journal. Où le trouver et comment le copier : js/form-link.js (écran).
import { AUTHOR_COL, KEY_COL, randomHex } from './logic/common.js';
import { fetchRows, postRows, selectRows, withLock } from './port.js';
import { failure } from './errors.js';

// Le lien écrit-il dans ce journal-ci ? Une ligne marquée d'un nombre tiré au hasard part par la
// clé, comme le fera le webhook (ce qui valide d'un coup la clé, la publication, le nom de la table
// et `?flat=1`), et doit arriver dans `journal`. Le lien d'un autre formulaire, d'un autre
// document ou d'une autre instance est refusé : la réponse enverrait les données ailleurs. Le
// nettoyage du journal efface la ligne ; le verrou de la recopie l'en empêche avant la vérification.
export function testUrl(url, journal) {
  const probe = randomHex(8);
  return withLock('gristsync-consolidation', async () => {
    try {
      await postRows(url, [{ [KEY_COL]: '', [AUTHOR_COL]: probe }]);
    } catch (e) {
      throw e.message === 'otherInstance' ? new Error('linkElsewhere') : failure('linkTest', { detail: e.message });
    }
    const rows = (await selectRows(journal, [AUTHOR_COL])) || await fetchRows(journal);
    if (!rows.some(r => r[AUTHOR_COL] === probe)) throw new Error('linkElsewhere');
  });
}
