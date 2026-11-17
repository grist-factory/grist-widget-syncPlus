// Dernier envoi ordinaire d'un export, tel que Grist le dit.
//
// Une ligne ajoutée ou modifiée dans la SOURCE part par le webhook de Grist, sans le widget : aucun code du widget ne tourne à ce
// moment, donc rien ne s'écrit dans l'historique des envois (qui ne garde que ce que le widget conduit : renvois, rattrapages,
// pauses, destinataires, voir addEvent). Écrire chaque envoi ordinaire dans cet historique n'est pas une voie sûre : il ne serait
// vu que page ouverte, il noierait les repères de destinataires (`join` et `revoke`) que `vanishedRecipients` relit dans les
// EVENTS_KEPT derniers événements, et chaque ouverture ajouterait une écriture de plus à la note.
//
// Ce que Grist dit, lui, tient dans l'état d'envoi de chaque webhook (`usage.lastSuccessTime`, en millisecondes) : l'heure du
// dernier envoi réussi chez ce destinataire (remise à zéro quand le webhook est coupé puis rallumé). L'écran la montre en tête de
// l'historique et la relit sans que personne ne touche à rien (voir tickFlows). Logique pure, sans écran.

// Heure d'un envoi réussi (ms), 0 si Grist n'en dit aucune ou une valeur qui n'en est pas une.
const deliveredAt = h => {
  const at = Number(((h || {}).usage || {}).lastSuccessTime);
  return Number.isFinite(at) && at > 0 && at < 4e12 ? at : 0;
};

// Le dernier envoi réussi parmi les destinataires : { at (ms), hook (le webhook qui l'a reçu), n (destinataires qui en ont reçu
// un), of (destinataires de l'export) }, null si aucun n'en a reçu. Un destinataire en pause garde sa dernière heure tant que
// Grist la garde.
export function lastSend(recipients) {
  const list = Array.isArray(recipients) ? recipients : [];
  let best = null;
  let n = 0;
  for (const hook of list) {
    const at = deliveredAt(hook);
    if (!at) continue;
    n += 1;
    if (!best || at > best.at) best = { at, hook };
  }
  return best && { ...best, n, of: list.length };
}
