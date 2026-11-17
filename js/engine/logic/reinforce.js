// Renforcer la sécurité d'un partage déjà branché (envoi d'avant les clés de signature, sans clé propre au
// destinataire). Rien n'est imposé : un partage sans clé continue d'arriver, la personne le renforce quand elle
// veut, destinataire par destinataire, par une nouvelle invitation qui remplace l'ancien envoi.
//
// Pendant l'échange (la CIBLE a collé le nouveau code, la SOURCE n'a pas encore approuvé sa réponse), l'ancien
// webhook de la SOURCE envoie toujours sans signature : la CIBLE les accepte jusqu'à la première livraison
// signée avec la nouvelle clé, 7 jours au plus (`GRACE_S`). Une ligne qui forge un envoi peut passer dans ce
// délai : c'est le prix de ne rien couper, dit à Antoine le 6 novembre. Passé le délai, l'ancien envoi est
// refusé comme tout envoi non signé, et la carte dit pourquoi (`expired`).
//
// État noté dans la note du journal de la CIBLE (`renf`) :
//   absent               rien à dire (réception sans clé jamais renforcée, ou renforcée dès l'invitation)
//   { at }               attend la première livraison signée (`at` : quand la CIBLE a collé le code, secondes)
//   { at, done }         renforcée (`done` : première livraison signée vue)
import { INVITE_DAYS, readKeys } from './trust.js';

export const GRACE_DAYS = INVITE_DAYS;
export const GRACE_S = GRACE_DAYS * 86400;

const valid = renf => renf && typeof renf === 'object' && Number.isFinite(renf.at) && renf.at > 0 && renf.at < 4e9;

// 'none' | 'pending' (l'ancien envoi est toléré) | 'expired' (le délai est passé, l'ancien envoi est refusé) | 'done'.
export function renfState(note, now) {
  const renf = (note || {}).renf;
  if (!valid(renf)) return 'none';
  if (Number.isFinite(renf.done) && renf.done > 0) return 'done';
  return now - renf.at < GRACE_S ? 'pending' : 'expired';
}

// Vrai tant que les envois sans signature sont acceptés (voir checkSigned).
export const graceOpen = (note, now) => renfState(note, now) === 'pending';

// Quand le délai prend fin (secondes), pour le dire sur la carte.
export const graceEnd = note => (valid((note || {}).renf) ? note.renf.at + GRACE_S : 0);

// Nouvelle invitation collée pour une réception qui n'avait jamais de clé : l'attente commence ; pour une
// réception déjà attendue, le délai repart de ce nouveau code ; une réception déjà renforcée ou qui avait
// sa clé n'attend rien.
export function startRenf(note, wasUnsigned, now) {
  const before = (note || {}).renf;
  if (wasUnsigned || renfState(note, now) === 'pending' || renfState(note, now) === 'expired') return { ...note, renf: { at: now } };
  return { ...note, ...(valid(before) ? { renf: before } : {}) };
}

// Première livraison signée vue : le partage est renforcé.
export function finishRenf(note, now) {
  if (!valid((note || {}).renf) || note.renf.done) return note;
  return { ...note, renf: { ...note.renf, done: now } };
}

// « Revenir à l'ancien fonctionnement » : permis tant que le renforcement n'est pas fini (la réception n'a jamais
// eu de clé avant lui) ; la clé, la clé publique, le sceau et l'état d'attente s'effacent, l'ancien envoi
// redevient accepté tel quel.
export const canRevert = (note, now) => ['pending', 'expired'].includes(renfState(note, now));
export function revertedNote(note) {
  const { pub, pubSource, sceau, renf, ...rest } = note;
  return rest;
}

// Webhooks (`hooks` : [{ id }]) d'un export dont la SOURCE n'a aucune clé de signature : ceux d'un envoi d'avant les
// clés, ou dont la ligne `signature` a été perdue. `value` : la ligne `signature` de Synchro. Une clé commune d'avant la
// 0.10 (`'*'`) signe pour tous : rien à dire.
export function unsignedHooks(value, hooks) {
  const keys = readKeys(value);
  return keys['*'] ? [] : hooks.filter(h => !keys[h.id]).map(h => h.id);
}
