// CIBLE : la ligne « Données de <personne> · <document> », sur la carte d'une réception et dans l'assistant (la
// fiche d'une invitation). Le document est un lien, dans un nouvel onglet, quand l'invitation a dit son équipe ;
// son texte est le nom que dit la SOURCE (qui ne peut pas le lire elle-même : elle l'a saisi), vérifié chez Grist
// en Échange (`verified`), ce que l'infobulle précise. Sans nom, « Ouvrir le document source ». Une réception
// d'avant cette version n'a pas l'équipe : le nom reste du texte. L'adresse est refaite d'après `origin`, l'instance
// de CE document (voir docUrl), jamais d'après un code.
import { docUrl } from '../engine/logic/codes.js';
import { docLink, el } from '../ui.js';
import { t } from '../i18n.js';

export function sourceLine(from, { verified = false, origin = '' } = {}) {
  const { email, docName, docId, team } = from || {};
  const url = docUrl(origin, team, docId, docName);
  const provenance = docName ? t(verified ? 'common.docChecked' : 'common.docDeclared') : '';
  const doc = docName || url ? docLink(docName || t('recv.doc.open'), url, provenance) : null;
  if (!email && !doc) return null;
  const title = [docId ? t('recv.docId', { doc: docId }) : '', url ? '' : provenance].filter(Boolean).join(' — ');
  return el('p', { class: 'small', title: title || null }, email ? t('recv.from', { from: email }) : null, email && doc ? ' · ' : null, doc);
}
