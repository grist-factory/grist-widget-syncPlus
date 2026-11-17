// Écran du canal entre onglets (voir tab-link.js) : le bloc « envoyer à l'autre onglet » que la SOURCE montre
// avec son invitation et la CIBLE avec sa réponse, et l'avis qui annonce à la CIBLE une invitation arrivée de
// l'autre onglet. Rien ne se fait sans un geste de la personne : le bouton envoie, « Recevoir » ouvre l'assistant
// habituel, qui juge le code comme s'il avait été collé.
import { tabLink } from './tab-link.js';
import { el, icon, notice, smallButton } from './ui.js';
import { docIdentity, isReadOnly } from './grist.js';
import { t } from './i18n.js';

const SILENT_MS = 3000; // sans nouvelle de l'autre onglet au bout de ce temps, le texte dit à quoi tient son silence

// Bloc « envoyer à un document ouvert dans ce navigateur » : un bouton, son aide, et ce qui s'est passé.
// `texts` : { button, help, sent, done, silent } ; `start(alive, ack)` lance l'envoi (tabLink) et rend de quoi
// l'arrêter ; `ack` est à appeler quand l'autre onglet l'a reçu. `auto` : l'envoi part dès que le bloc est à
// l'écran (la personne est déjà venue par le canal). Rend null si le navigateur n'a pas de canal.
export function tabSendBlock({ texts, start, auto = false }) {
  if (!tabLink().supported()) return null;
  const status = el('p', { class: 'muted small', role: 'status' });
  const block = el('div', { class: 'tab-link' });
  let stop = null;
  const go = () => {
    if (stop) stop();
    let acked = false;
    status.replaceChildren(texts.sent);
    stop = start(() => block.isConnected, () => { acked = true; status.replaceChildren(texts.done); });
    setTimeout(() => { if (!acked && block.isConnected) status.replaceChildren(texts.silent); }, SILENT_MS);
  };
  block.append(el('div', { class: 'handoff' }, el('button', { class: 'btn', type: 'button', onclick: go }, icon('send'), texts.button),
    auto ? null : el('span', { class: 'muted small' }, texts.help)), status); // envoyé d'office : le statut suffit
  if (auto) setTimeout(go, 0); // le temps que l'assistant affiche le bloc : un bloc hors de l'écran ne reçoit rien
  return block;
}

// CIBLE : l'avis d'une invitation proposée par un autre onglet. `host` : l'élément où il s'affiche ; `open(code)` :
// ouvre l'assistant de réception sur ce code (rend faux s'il n'a pas pu). L'avis ne vient que d'une invitation d'un autre document que celui-ci
// (jamais de soi-même) et qu'un document qui peut recevoir (pas en lecture seule) ; celle qu'on a ignorée ne revient
// pas pendant ce chargement.
export function startOfferNotice(host, open) {
  const link = tabLink();
  if (!link.supported()) return;
  const ignored = new Set();
  const clear = () => host.replaceChildren();
  const show = (offer) => {
    // `open` rend faux quand rien ne s'ouvre (un assistant l'est déjà) : l'avis reste alors à l'écran.
    const use = async () => { if ((await open(offer.code)) !== false) clear(); };
    const ignore = () => { ignored.add(offer.id); clear(); };
    host.replaceChildren(notice({
      tone: 'info', title: t('tab.in.title'), 'data-offer': offer.id,
      lines: [t('tab.in.line', { name: offer.name || '—' }), offer.docName ? t('tab.in.doc', { doc: offer.docName }) : null, t('tab.in.check')],
      actions: [smallButton(t('tab.in.use'), 'plus', use, { kind: 'btn-primary' }), smallButton(t('tab.in.ignore'), 'ignore', ignore)],
    }));
  };
  link.watchOffers((offer) => {
    if (isReadOnly() || ignored.has(offer.id)) return false;
    docIdentity().then(({ docId }) => {
      if (offer.docId && offer.docId === docId) return; // l'invitation vient de ce document : un autre onglet du même document
      show(offer);
      link.acknowledge(offer.id);
    }).catch(() => {});
    return false; // « vue » n'est dit qu'une fois l'avis affiché (acknowledge)
  });
}
