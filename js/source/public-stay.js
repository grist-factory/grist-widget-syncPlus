// Le lien public de Grist, vu de l'onglet Envoyer : relu tout seul, et resté ouvert après qu'on a coupé celui d'un export.
//
// Deux faits, vérifiés dans l'écran de la 0.29.0 :
// 1. Le widget ne lisait le droit du lien public (`publicAccess`) qu'à un affichage complet de l'onglet (ouverture, clic) : la
//    pastille « Lien public à activer » restait affichée après qu'on avait activé l'accès public dans Partager, jusqu'au
//    prochain clic. Le rythme du repos (`tickFlows`) ne relisait que les webhooks, et un export public n'a pas de webhook : sans
//    autre destinataire, rien ne tournait. Ici : quand l'écran dépend de ce droit, il est relu à chaque coup d'œil, et l'onglet
//    se redessine quand il change.
// 2. « Couper le lien public » retire l'export public du widget, pas le partage public de Grist (Partager, Gérer les
//    utilisateurs, « Accès public ») : le document reste lisible par lien, le widget gardant sa règle qui cache le reste aux
//    lecteurs. Le widget le note (`publicCoupe`, dans la note SOURCE) et, tant que Grist dit le document public, l'onglet montre
//    un avis orange, que la personne ferme en confirmant qu'elle veut le laisser public. La note est effacée quand Grist dit le
//    lien fermé (ou à la confirmation) : un document rouvert plus tard au public pour une autre raison n'est pas signalé.
//
// Logique pure, sans écran. `access` : ce que dit `publicAccess` ('viewers', 'editors', '' si le document n'est pas public, null
// si Grist ne répond pas : rien ne change).

const KEY = 'publicCoupe';

// Le partage public de Grist est ouvert (en lecture ou en édition).
export const isOpen = access => typeof access === 'string' && access !== '';

// La note SOURCE dit que le widget a coupé un lien public (et que la personne n'a pas confirmé le laisser ouvert).
export const staysPublic = note => Boolean(note) && note[KEY] === true;

// Notes rendues, jamais modifiées ; la même note quand rien ne change (rien n'est alors écrit, voir updateSourceNote).
export const markStay = note => (staysPublic(note) ? note : { ...note, [KEY]: true });
export function clearStay(note) {
  if (!note || !(KEY in note)) return note;
  const { [KEY]: gone, ...rest } = note;
  return rest;
}

const hasPublicExport = exports => (exports || []).some(e => e.public);

// L'avis orange : le widget a coupé un lien public, plus aucun export n'est public, et Grist dit le document encore public.
export const lingering = ({ note, exports, access }) => staysPublic(note) && isOpen(access) && !hasPublicExport(exports);

// Grist dit le lien fermé pour de bon : la note du lien coupé n'a plus de raison d'être.
export const forgettable = ({ note, access }) => staysPublic(note) && access === '';

// Ce que l'écran affiche dépend-il du droit du lien public : pastille d'un export public, avis du lien resté ouvert (ou sa note,
// à effacer quand le lien se ferme), bannière « réglé sur Éditeur » ? Alors il le relit à chaque coup d'œil.
export const watchesAccess = ({ note, exports, access }) => hasPublicExport(exports) || staysPublic(note) || access === 'editors';

// Le droit lu n'est pas celui que l'écran montre (null : Grist n'a pas répondu, rien ne change).
export const accessMoved = (shown, read) => read !== null && read !== undefined && read !== shown;

// La personne est sur le point de changer ce droit dans Grist : un export public attend qu'on l'active, ou l'avis du lien resté
// ouvert attend qu'on le ferme ou qu'on le confirme. L'écran relit alors plus vite (même rythme qu'un envoi qui bouge).
export const waitsForAccess = ({ note, exports, access }) =>
  (hasPublicExport(exports) && !isOpen(access)) || lingering({ note, exports, access });
