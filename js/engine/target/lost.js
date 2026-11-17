// CIBLE : réceptions dont le journal a été supprimé (voir logic/lost.js). Le widget note, dans le
// partage du formulaire de chaque réception, de quoi la reconnaître ; si le journal disparaît, le partage
// reste et dit ce qui a été perdu.
import { apply, fetchRows, readSchema } from '../port.js';
import { formPages } from '../pages.js';
import { lostReceptions, receptionMark } from '../logic/lost.js';

// Pose la marque sur le partage du formulaire de chaque réception qui n'en a pas (ou plus à jour : une
// table rangée plus tard change la liste des destinations). `receptions` : [{ journal, note }], voir
// receivedJournals. Réceptions sans formulaire (lien public, retour d'un Échange) et formulaires qui
// partagent une page avec d'autres (montage d'avant la 0.5) sont laissés. Rend vrai si quelque chose
// a changé. Un propriétaire (le partage est dans les données du document).
export async function markReceptions(receptions) {
  const [forms, pages, shares] = await Promise.all([formPages(), fetchRows('_grist_Pages'), fetchRows('_grist_Shares')]);
  const actions = [];
  for (const { journal, note } of receptions) {
    const form = forms.get(journal);
    if (note.mode === 'public' || note.retour || !form || form.shared) continue;
    const page = pages.find(p => p.viewRef === form.viewRef);
    const share = page && page.shareRef ? shares.find(s => s.id === page.shareRef) : null;
    const mark = receptionMark(journal, note);
    if (share && share.description !== mark) actions.push(['UpdateRecord', '_grist_Shares', share.id, { description: mark }]);
  }
  if (actions.length) await apply(actions);
  return actions.length > 0;
}

// Réceptions supprimées que le document dit encore (voir lostReceptions). Une personne qui ne lit pas
// `_grist_Shares` n'en voit aucune.
export async function readLost() {
  try {
    return lostReceptions(await readSchema(), await fetchRows('_grist_Shares'));
  } catch (e) {
    return [];
  }
}

// Retire l'avis d'une réception supprimée : ses partages, et avec eux l'ancienne clé d'écriture, qui ne
// servait plus à rien (le partage reste dans Grist quand la page de son formulaire disparaît).
export async function dismissLost(lost) {
  await apply(lost.shares.map(id => ['RemoveRecord', '_grist_Shares', id]));
}
