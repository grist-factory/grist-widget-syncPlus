// Note SOURCE (description de la colonne Synchro_Export, voir source/synchro.js) :
// { nomDoc: nom que la personne a donné à ce document (voir setDocName),
//   exports: [{ id, name, at, public, renforce, echange, retour, regles, refus }],
//   invitations: [{ id, export, hash, at, renforce, journal, ready, pub, prive }],
//   pauses: [{ hook, export, at, columns }], fichiers: { <export>: { f, h, p } },
//   historique: { <export>: [{ at, kind, who, n }] },
//   lignes: { <export>: { at, n: { <table>: nombre de lignes } } },
//   dest: { <jeton de mémo>: { m: « e-mail · document · équipe/nom », at } } }.
// Chaque opération rend une nouvelle note, sans toucher à celle qu'elle reçoit.
import { cleanLabel } from './codes.js';

// Nom de ce document, tel que la personne l'a saisi : un widget ne peut pas lire le nom de son document
// (`getDocName` rend l'identifiant, la fiche REST est refusée au jeton, vérifié sur Grist 1.7). Il part dans les
// invitations (`from.docName`) pour que la CIBLE reconnaisse d'où viennent les données. Une note retouchée à la
// main est nettoyée à la lecture ; un nom vide l'efface.
export const docNameOf = note => cleanLabel(note.nomDoc);
export function setDocName(note, name) {
  const { nomDoc, ...rest } = note;
  const clean = cleanLabel(name);
  return clean ? { ...rest, nomDoc: clean } : rest;
}

// Élément remplacé à sa place (même `id`), sinon ajouté à la fin.
const put = (list, entry) => (list.some(x => x.id === entry.id) ? list.map(x => (x.id === entry.id ? entry : x)) : [...list, entry]);

// Champs d'un export changés ; l'export garde sa place (l'ordre des cartes).
export const setExport = (note, id, fields) => ({ ...note, exports: note.exports.map(e => (e.id === id ? { ...e, ...fields } : e)) });
export const putExport = (note, entry) => ({ ...note, exports: put(note.exports, entry) });

// Invitations et pauses d'un export retirées ; `dropExport` retire aussi l'export.
export const clearExport = (note, id) => ({ ...note, invitations: note.invitations.filter(i => i.export !== id), pauses: note.pauses.filter(p => p.export !== id) });
export function dropExport(note, id) {
  const next = { ...clearExport(note, id), exports: note.exports.filter(e => e.id !== id) };
  delete next.historique;
  delete next.lignes;
  const { [id]: gone, ...history } = note.historique || {};
  const { [id]: noRows, ...rows } = note.lignes || {};
  return { ...next, ...(Object.keys(history).length ? { historique: history } : {}), ...(Object.keys(rows).length ? { lignes: rows } : {}) };
}

// Historique des envois d'un export : les événements que le widget a lui-même conduits (renvois,
// rattrapages, pauses, destinataires), du plus récent au plus ancien, les EVENTS_KEPT derniers.
// Les envois ordinaires partent de Grist sans le widget : l'état de chaque destinataire (dernier
// succès, erreur) les dit. `event` : { at (secondes), kind ('join', 'resend', 'catchup', 'unblock',
// 'pause', 'autopause', 'resume', 'revoke', 'edit', 'editSent', 'shrink', 'reinforce'), who (destinataire, ou table pour
// 'shrink'), n (lignes ou tables) }.
export const EVENTS_KEPT = 30;
const WHO_MAX = 80;
const EVENT_KINDS = ['join', 'reinforce', 'resend', 'catchup', 'unblock', 'pause', 'autopause', 'resume', 'revoke', 'edit', 'editSent', 'shrink'];
export function addEvent(note, exportId, { at, kind, who = '', n = 0 }) {
  const event = { at, kind, ...(who ? { who: String(who).slice(0, WHO_MAX) } : {}), ...(n ? { n } : {}) };
  const before = (note.historique || {})[exportId];
  return { ...note, historique: { ...(note.historique || {}), [exportId]: [event, ...(Array.isArray(before) ? before : [])].slice(0, EVENTS_KEPT) } };
}
// Événements lisibles d'un export. La note peut avoir été retouchée à la main ou écrite par une autre
// version : un élément mal formé est écarté, jamais d'erreur à l'affichage.
const readable = e => e && typeof e === 'object' && EVENT_KINDS.includes(e.kind) && Number.isFinite(e.at) && e.at > 0 && e.at < 4e9;
// `all` : aussi les repères d'un historique effacé (voir clearEvents), qui comptent encore sans rien montrer.
export function eventsOf(note, exportId, { all = false } = {}) {
  const list = (note.historique || {})[exportId];
  return (Array.isArray(list) ? list : []).filter(readable).filter(e => all || !e.cleared).map(({ at, kind, who, n, cleared }) => ({
    at, kind, ...(who ? { who: String(who).slice(0, WHO_MAX) } : {}), ...(Number.isFinite(n) && n ? { n } : {}), ...(cleared ? { cleared: true } : {}),
  }));
}

// Historique des envois effacé sur demande (bouton de la SOURCE). Les ajouts et les retraits de destinataire restent comme
// repères, sans nom ni nombre et sans rien montrer : ils servent à voir un destinataire dont le webhook a été supprimé à la main
// (vanishedRecipients) et à dire qu'un export a des clés de signature (unkeyedRecipients). Tout le reste est oublié.
export function clearEvents(note, exportId) {
  const marks = eventsOf(note, exportId, { all: true }).filter(e => e.kind === 'join' || e.kind === 'revoke').map(({ at, kind }) => ({ at, kind, cleared: true }));
  return { ...note, historique: { ...(note.historique || {}), [exportId]: marks } };
}

// Destinataires ajoutés par le widget (événement `join`) et ni révoqués par lui (`revoke`) ni présents parmi les
// webhooks : leur webhook a été supprimé dans les réglages de Grist. Le nombre, 0 si rien ne manque ; seul
// l'historique gardé (EVENTS_KEPT) compte, donc au pire un destinataire manquant passe inaperçu, jamais l'inverse.
export function vanishedRecipients(events, present) {
  const joined = events.filter(e => e.kind === 'join').length;
  const revoked = events.filter(e => e.kind === 'revoke').length;
  return Math.max(0, joined - revoked - present);
}

export const putInvitation = (note, entry) => ({ ...note, invitations: put(note.invitations, entry) });
export const dropInvitation = (note, id) => ({ ...note, invitations: note.invitations.filter(i => i.id !== id) });

// Pause du webhook `hook` : notée (`entry`), ou levée (sans `entry`).
export const setPause = (note, hook, entry = null) => ({ ...note, pauses: [...note.pauses.filter(p => p.hook !== hook), ...(entry ? [entry] : [])] });

// Suivi des fichiers envoyés (voir source/files.js) : retiré de la note quand il est vide.
export function setFiles(note, fichiers) {
  const rest = { ...note };
  delete rest.fichiers;
  return Object.keys(fichiers).length ? { ...rest, fichiers } : rest;
}

// Lignes qui quittent un export (la CIBLE est passive : elle applique les suppressions de la SOURCE, qui
// répond de ses données ; la SOURCE en est avertie, après coup, car aucune confirmation ne peut précéder un
// envoi que fait le webhook de Grist sans le widget). Le widget, page d'un propriétaire ouverte, compare le
// nombre de lignes de chaque table de l'export (suivi de Synchro) à celui de sa dernière observation, gardée
// dans la note (`lignes`). Au moins ROWS_DROP.min lignes et une part ROWS_DROP.share de la table en moins :
// événement `shrink` dans l'historique (`who` : la table, `n` : combien), montré en avis pendant DROP_SHOWN_S.
// Supprimées, ou sorties du filtre de l'export : le compte ne les distingue pas.
export const ROWS_DROP = { min: 11, share: 0.2 };
export const ROWS_REFRESH_S = 300; // l'observation de référence se renouvelle au plus toutes les 5 minutes
export const DROP_SHOWN_S = 86400;

// Dernière observation d'un export : { at, n: { table: nombre } }, ou null si elle manque ou est mal formée
// (note retouchée à la main : jamais d'erreur à l'affichage).
export function rowsOf(note, exportId) {
  const seen = (note.lignes || {})[exportId];
  if (!seen || !Number.isFinite(seen.at) || !seen.n || typeof seen.n !== 'object' || Array.isArray(seen.n)) return null;
  const n = Object.fromEntries(Object.entries(seen.n).filter(([, v]) => Number.isInteger(v) && v >= 0));
  return { at: seen.at, n };
}

// Tables dont le nombre de lignes a tombé au-delà du seuil : [{ table, n (lignes en moins), was }].
export function rowDrops(before, counts) {
  return Object.keys(counts).filter(table => table in before).map(table => ({ table, n: before[table] - counts[table], was: before[table] }))
    .filter(d => d.n >= ROWS_DROP.min && d.n > ROWS_DROP.share * d.was);
}

// La note après observation de `counts` (table -> nombre de lignes, celles que le suivi de Synchro dit) à
// l'instant `now`, ou null s'il n'y a rien à écrire : la référence est écrite à la première observation, puis
// renouvelée quand les nombres ont changé et qu'elle a plus de ROWS_REFRESH_S ; une baisse au-delà du seuil
// l'écrit aussitôt avec son événement, si `warn` (export qui a des destinataires : sans eux, rien ne part).
export function observeRows(note, exportId, counts, now, warn = true) {
  const tables = Object.keys(counts);
  if (!tables.length) return null;
  const before = rowsOf(note, exportId);
  const drops = warn && before ? rowDrops(before.n, counts) : [];
  const changed = !before || tables.some(table => before.n[table] !== counts[table]) || Object.keys(before.n).some(table => !(table in counts));
  if (!drops.length && !(changed && (!before || now - before.at >= ROWS_REFRESH_S))) return null;
  let next = { ...note, lignes: { ...(note.lignes || {}), [exportId]: { at: now, n: counts } } };
  for (const drop of drops) next = addEvent(next, exportId, { at: now, kind: 'shrink', who: drop.table, n: drop.n });
  return next;
}

// Baisses récentes à montrer en avis : la plus récente de chaque table, `at` et `n`, dans les DROP_SHOWN_S
// secondes avant `now` (événements du plus récent au plus ancien, voir eventsOf).
export function recentDrops(events, now) {
  const seen = new Set();
  return events.filter(e => e.kind === 'shrink' && e.who && now - e.at < DROP_SHOWN_S && !seen.has(e.who) && seen.add(e.who))
    .map(e => ({ table: e.who, n: e.n || 0, at: e.at }));
}

// ---------------------------------------------------------------------------------------------
// Destinataires. Le mémo d'un webhook se lit dans les métadonnées du document (`_grist_Triggers`), que Grist montre à
// toute personne qui lit le document, lien public compris : il n'y met donc qu'un jeton (`r-` et douze chiffres
// hexadécimaux), et la fiche du destinataire (e-mail, document, équipe et nom) reste dans cette note, que les lecteurs
// ne lisent pas. `identifyHooks` remet la fiche dans les webhooks que lisent les écrans et le moteur.

export const MEMO_TOKEN = /^r-[0-9a-f]{12}$/;
export const isMemoToken = memo => MEMO_TOKEN.test(String(memo || ''));

// La note, avec la fiche `memo` rangée sous `token` (heure `at`, en secondes).
export const putDest = (note, token, memo, at) => ({ ...note, dest: { ...note.dest, [token]: { m: String(memo), at } } });

// Fiche rangée sous `token`, ou null.
export function destOf(note, token) {
  const entry = note.dest && Object.hasOwn(note.dest, token) ? note.dest[token] : null;
  return entry && typeof entry.m === 'string' ? entry.m : null;
}

// Webhooks dont le mémo est un jeton connu de la note : leur mémo devient la fiche (le jeton reste dans `memoToken`).
// Les autres (mémo d'avant la 4.0, ou jeton inconnu) sont rendus tels quels.
export const identifyHooks = (hooks, note) => hooks.map((h) => {
  const memo = h.fields.memo;
  const card = isMemoToken(memo) ? destOf(note, memo) : null;
  return card === null ? h : { ...h, fields: { ...h.fields, memo: card, memoToken: memo } };
});

// Jetons de la note qu'aucun webhook ne porte (`memos` : les mémos des webhooks, tels que Grist les garde) et posés il y a
// plus de `grace` secondes : un destinataire révoqué, ou un jeton posé avant un webhook qui n'a pas pu se créer. Le délai
// laisse à un onglet le temps de créer son webhook après avoir rangé la fiche.
export const staleDest = (note, memos, now, grace) => Object.entries(note.dest || {})
  .filter(([token, entry]) => !memos.has(token) && !(Number.isFinite(entry && entry.at) && now - entry.at < grace)).map(([token]) => token);

export function dropDest(note, tokens) {
  if (!tokens.length) return note;
  const { dest, ...rest } = note;
  const left = Object.fromEntries(Object.entries(dest || {}).filter(([token]) => !tokens.includes(token)));
  return Object.keys(left).length ? { ...rest, dest: left } : rest;
}
