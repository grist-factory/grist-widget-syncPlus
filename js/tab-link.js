// Canal entre deux onglets du même navigateur (BroadcastChannel) : quand une même personne a les deux documents
// ouverts, l'invitation et la réponse passent d'un widget à l'autre sans copier-coller. Ce n'est qu'un transport de
// texte, côté écran (jamais dans le moteur) : ce qui arrive est un code d'invitation ou de réponse comme un code
// collé, et le moteur le juge de la même façon (document de la clé chez Grist, code de contrôle, péremption,
// sécurité renforcée). Le canal ne prouve ni l'expéditeur ni le document : il n'en dit rien.
//
// Qui l'entend : les pages de la même origine que le widget, dans le même navigateur et le même profil, ce que
// mesure la section 47 des « faits vérifiés » de GFS (autre profil, autre navigateur, autre poste : rien). Un
// GitHub Pages est une origine commune à tous les dépôts du compte : le canal n'est donc pas privé à deux
// documents, et chaque message se limite à ce que l'autre document attend (voir SECURITY.md).
//
// Messages (`app` = 'gristsync', `k` = le genre) :
//   offer { code }        la SOURCE propose son invitation                   (réponse : seen)
//   want                  la CIBLE demande si une invitation attend          (réponse : offer)
//   seen { id }           la CIBLE a montré l'invitation `id`
//   reply { code }        la CIBLE rend sa réponse                           (réponse : got)
//   wantReply { id }      la SOURCE attend la réponse à l'invitation `id`    (réponse : reply)
//   got { id }            la SOURCE a reçu la réponse à `id`
// Chaque côté reste à l'écoute tant que son écran est affiché (`alive`) : un onglet ouvert après coup demande
// (`want`, `wantReply`) ce qui a été dit avant lui.
import { cleanLabel } from './engine/logic/codes.js';
import { HEX16 } from './engine/logic/common.js';

const CHANNEL = 'gristsync-link';
const APP = 'gristsync';
const PREFIX = 'GRISTSYNC2.';
const MAX_CODE = 400000; // un code porte les colonnes de toutes les tables : bien plus que le texte d'une invitation courante
const KINDS = ['offer', 'want', 'seen', 'reply', 'wantReply', 'got'];

export const supported = () => typeof BroadcastChannel === 'function';

const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');

// Ce qu'un code dit sans le juger : l'objet du code, pour montrer d'où il vient et l'aiguiller. Jamais pour décider
// (décodeCode et le moteur contrôlent), d'où un code d'une version plus récente passé tel quel.
function peek(code) {
  const raw = code.replace(/\s+/g, '');
  if (!raw.startsWith(PREFIX)) return null;
  try {
    const binary = atob(raw.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0))));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch (e) {
    return null;
  }
}

// Message reçu, contrôlé : { k } seul pour `want`, { k, id } pour seen, wantReply et got, et pour offer et reply le
// code avec l'identifiant de l'invitation qu'il porte (et, pour une invitation, de quoi la nommer à l'écran).
// Rend null pour tout ce qui n'est pas exactement un de ces messages.
const ID_KINDS = ['seen', 'wantReply', 'got'];
const CODE_KINDS = { offer: 'invitation', reply: 'reponse' }; // genre de message -> genre de code qu'il porte

// De quoi nommer une invitation à l'écran. Montré par textContent, comme tout ce qu'un code dit : sans caractère de
// contrôle ni de sens d'écriture.
function offerLabels(payload) {
  const from = payload.from && typeof payload.from === 'object' ? payload.from : {};
  return { name: cleanLabel(payload.name), docName: cleanLabel(from.docName), docId: text(from.docId) };
}

function parseCoded(data) {
  if (typeof data.code !== 'string' || data.code.length > MAX_CODE) return null;
  const payload = peek(data.code);
  if (!payload || payload.kind !== CODE_KINDS[data.k] || !HEX16.test(payload.id)) return null;
  return { k: data.k, id: payload.id, code: data.code.trim(), ...(data.k === 'offer' ? offerLabels(payload) : {}) };
}

export function parseMessage(data) {
  if (!data || typeof data !== 'object' || data.app !== APP || !KINDS.includes(data.k)) return null;
  if (data.k === 'want') return { k: 'want' };
  if (ID_KINDS.includes(data.k)) return HEX16.test(data.id) ? { k: data.k, id: data.id } : null;
  return parseCoded(data);
}

// Le canal lui-même : ouvert à la première demande, `post` pour parler, `listen` pour entendre tant que `alive()`
// (un écran qui n'est plus affiché ne répond plus). `name` ne change que pour les essais, qui font parler deux
// « onglets » dans un seul processus.
function openLink(name) {
  let channel = null;
  const handlers = new Set();
  const open = () => {
    if (!channel && supported()) {
      channel = new BroadcastChannel(name);
      channel.onmessage = (event) => {
        const message = parseMessage(event.data);
        if (message) for (const handle of [...handlers]) handle(message);
      };
    }
    return channel;
  };
  return {
    open,
    post(message) {
      const live = open();
      if (!live) return false;
      try { live.postMessage({ app: APP, ...message }); return true; } catch (e) { return false; }
    },
    listen(handler, alive) {
      open();
      const handle = (message) => {
        if (!alive()) handlers.delete(handle);
        else handler(message);
      };
      handlers.add(handle);
      return () => handlers.delete(handle);
    },
    close() { handlers.clear(); if (channel) channel.close(); channel = null; },
  };
}

// SOURCE : proposer l'invitation `code` et attendre la réponse.
function sourceSide({ post, listen }) {
  return {
    // Proposer l'invitation `code`. Elle est redite à qui la demande (`want`) tant que `alive()`.
    // `onSeen` : une CIBLE l'a montrée. Rend de quoi arrêter, ou null si le code n'est pas une invitation.
    offerInvitation(code, { alive = () => true, onSeen = () => {} } = {}) {
      const mine = parseMessage({ app: APP, k: 'offer', code });
      if (!mine || !supported()) return null;
      const stop = listen((m) => {
        if (m.k === 'want') post({ k: 'offer', code });
        else if (m.k === 'seen' && m.id === mine.id) onSeen();
      }, alive);
      post({ k: 'offer', code });
      return stop;
    },

    // Attendre la réponse à l'invitation `id` ; `onReply(code)` à chacune qui arrive (la CIBLE peut la
    // redire : l'écran doit s'en accommoder). Demande aussi celle qui est peut-être déjà prête.
    awaitReply(id, onReply, { alive = () => true } = {}) {
      if (!supported() || !HEX16.test(id)) return null;
      const stop = listen((m) => {
        if (m.k === 'reply' && m.id === id) {
          onReply(m.code);
          post({ k: 'got', id });
        }
      }, alive);
      post({ k: 'wantReply', id });
      return stop;
    },
  };
}

// CIBLE : voir les invitations proposées et rendre la réponse.
function targetSide({ post, listen }) {
  return {
    // Être prévenue des invitations proposées. `onOffer(offre)` rend vrai quand elle est montrée sur-le-champ
    // à la personne (la SOURCE l'apprend par `seen`) ; un écran qui ne l'affiche qu'après un contrôle appelle
    // `acknowledge(id)` à ce moment-là. Demande aussi celles qui attendent déjà.
    watchOffers(onOffer, { alive = () => true } = {}) {
      if (!supported()) return null;
      const stop = listen((m) => {
        if (m.k === 'offer' && onOffer(m)) post({ k: 'seen', id: m.id });
      }, alive);
      post({ k: 'want' });
      return stop;
    },
    acknowledge: id => HEX16.test(id) && post({ k: 'seen', id }),

    // Rendre la réponse `code` à la SOURCE, et la redire à qui l'attend (`wantReply`) tant que `alive()`.
    // `onGot` : la SOURCE l'a reçue.
    sendReply(code, { alive = () => true, onGot = () => {} } = {}) {
      const mine = parseMessage({ app: APP, k: 'reply', code });
      if (!mine || !supported()) return null;
      const stop = listen((m) => {
        if (m.k === 'wantReply' && m.id === mine.id) post({ k: 'reply', code });
        else if (m.k === 'got' && m.id === mine.id) onGot();
      }, alive);
      post({ k: 'reply', code });
      return stop;
    },
  };
}

// Un canal à l'écoute.
export function createLink(name = CHANNEL) {
  const link = openLink(name);
  return { supported, close: link.close, ...sourceSide(link), ...targetSide(link) };
}

// Le canal de ce widget, ouvert à la première demande (rien n'est ouvert à l'import).
let shared = null;
export const tabLink = () => {
  shared ||= createLink();
  return shared;
};
