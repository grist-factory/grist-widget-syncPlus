// Ce que l'écran montre d'un destinataire (la fiche du moteur, `hookLabel`, reste dans l'infobulle et
// l'historique) : « e-mail · équipe/nom du document », sans l'identifiant du document, qui ne dit rien à la
// personne. Sans nom connu, l'identifiant reste. Affichage seul : rien dans le moteur.
import { hookLabel, memoDoc } from '../engine/logic/exports.js';
import { docUrl } from '../engine/logic/codes.js';

export function hookShown(memo, docName = '') {
  const parts = hookLabel(memo, docName).split(' · ').filter(Boolean);
  return (parts.length === 3 ? [parts[0], parts[2]] : parts).join(' · ');
}

// La même fiche en morceaux, pour faire du document un lien : `who` (l'e-mail), `place` (équipe/nom du document,
// l'identifiant s'il n'y a ni l'un ni l'autre) et `url` (l'adresse du document dans Grist, refaite d'après `origin`,
// l'instance de CE document ; '' sans `origin` ou si le mémo ne donne pas de quoi la faire). `docName` : le nom
// vu chez Grist au dernier contrôle, qui l'emporte sur celui du mémo.
export function hookDoc(memo, docName = '', origin = '') {
  const doc = memoDoc(memo);
  const name = String(docName || '').trim() || doc.name;
  const place = [doc.team, name].filter(Boolean).join('/') || doc.docId;
  return { who: doc.email, place, url: docUrl(origin, doc.team, doc.docId, name) };
}
