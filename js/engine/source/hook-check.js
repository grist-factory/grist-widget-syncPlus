// SOURCE : le contrôle des webhooks « tenus à jour », sans écran. Chaque destinataire est revérifié chez
// Grist au plus une fois par heure : la clé de son webhook désigne-t-elle toujours le document de sa fiche
// (mémo) ? Un co-propriétaire peut changer l'adresse d'un webhook dans les réglages de Grist, même vers un
// autre site : une adresse qui n'est pas celle d'un formulaire de cette instance est signalée sans rien
// demander à personne. Le nom du document, lu au passage, complète la fiche affichée (voir hookLabel).
//
//   checkHooks(webhooks)      contrôle ceux qui sont dus ; rend vrai si un résultat ou une fiche a changé
//                             (l'écran se redessine alors)
//   hookCheck(id)             le dernier résultat d'un webhook : { other, bad, docName } (vide s'il n'est pas
//                             encore contrôlé) ; `other` = nom ou identifiant du document que désigne sa clé à
//                             la place de celui de la fiche, `bad` = adresse qui n'est pas celle d'un
//                             formulaire de cette instance
//   personLabel(webhook)      « e-mail · document · équipe/nom du document » de la fiche (hookLabel + nom vu)
//
// Les résultats sont gardés en mémoire pour la page (un seul contrôle par heure et par webhook, deux
// affichages de suite ne le font pas deux fois). Le port donne `docIdentity` et `shareInfo`.
import { parseWebhookUrl } from '../logic/codes.js';
import { pool } from '../logic/common.js';
import { hookLabel } from '../logic/exports.js';
import { memoMatches } from '../logic/trust.js';
import { docIdentity, shareInfo } from '../port.js';

const CHECK_MS = 3600000;
const CHECK_AT_ONCE = 6; // contrôles de lien simultanés au plus
const checked = new Map(); // webhook -> { at, url, other : document désigné à la place, ou '' ; bad ; docName }
const checking = new Set(); // webhooks dont le contrôle est en cours

export const hookCheck = id => checked.get(id) || {};
export const personLabel = h => hookLabel(h.fields.memo, hookCheck(h.id).docName) || '—';

export async function checkHooks(hooks) {
  const { origin } = await docIdentity();
  const due = hooks.filter((h) => {
    const was = checked.get(h.id);
    return !checking.has(h.id) && (!was || was.url !== h.fields.url || Date.now() - was.at > CHECK_MS);
  });
  if (!due.length) return false;
  for (const h of due) checking.add(h.id);
  let changed = false;
  const note = (h, result) => {
    const was = checked.get(h.id) || { other: '', bad: false };
    const label = personLabel(h);
    checked.set(h.id, { at: Date.now(), url: h.fields.url, ...result });
    changed ||= was.other !== result.other || was.bad !== result.bad || label !== personLabel(h);
  };
  await pool(due, CHECK_AT_ONCE, async (h) => {
    try {
      const target = parseWebhookUrl(h.fields.url);
      if (!target || !target.flat || target.origin !== origin) return note(h, { other: '', bad: true });
      const info = await shareInfo(h.fields.url).catch(() => undefined);
      if (info === undefined) return undefined; // Grist ne répond pas : au prochain affichage
      const other = info && !memoMatches(h.fields.memo, info.docId) ? info.name || info.docId : '';
      return note(h, { other, bad: false, docName: info && !other ? info.name : '' });
    } finally {
      checking.delete(h.id);
    }
  });
  return changed;
}
