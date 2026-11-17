// CIBLE : accepter un export et répondre, sans fenêtre. L'écran (js/target/wizard.js) montre les étapes ;
// chaque fonction ci-dessous fait ce qu'une étape fait quand la personne la valide, prend des données
// simples (le code collé, les destinations choisies, le lien du formulaire) et rend des données. Ce que
// la personne lit ne passe que par le port (`port.text`) ou par une erreur prévue (`failure`).
//
// Le déroulement :
//   readInvitation                               (le code collé, contrôlé)
//   knownReception → relinkReception             (une réception de cet export existe déjà : elle reprend)
//   checkDestinations → createReception          (un journal pour l'export, une destination par table)
//   receptionReply                               (le lien du formulaire vérifié, puis le code de réponse)
// undoReception défait la réception qu'on vient de créer (retour aux destinations).
import { APPLIED_COL, AUTHOR_COL, EXPORT_COL, LIST_COL, journalId, nowS } from '../logic/common.js';
import { buildReply, buildWebhookUrl, parseFormLink, parseInvitation } from '../logic/codes.js';
import { codeFacts, controlCode, linkKeys, newKeyPair, sameDoc } from '../logic/trust.js';
import { foreignSync } from '../logic/strays.js';
import { keySlot, missingColumns, optionsNote, receivedJournals, receivedKey } from '../logic/received.js';
import { canRevert, revertedNote, startRenf } from '../logic/reinforce.js';
import { apply, docIdentity, fetchRows, isOwner, readSchema, shareInfo } from '../port.js';
import { appVersion } from '../version.js';
import { ensureForm, removeTechnicalTables } from '../pages.js';
import { testUrl } from '../form-link.js';
import { wireExchange } from '../exchange.js';
import { readSourceNote, syncRows } from '../source/synchro.js';
import { createJournal, dropKey, prepareDest, storeKey, updateJournalNote } from './journals.js';
import { consolidateAll } from './loop.js';
import { checkDests } from './dest.js';

// 1. Invitation lue et contrôlée : même instance que ce document, encore valable ; un Échange suppose un
// propriétaire (ce document enverra aussi, par un webhook), et son adresse de retour doit désigner le
// document qui invite (demandé à Grist, voir shareInfo) : `share` le décrit, et `backCode` est le code de
// contrôle de l'envoi de retour.
export async function readInvitation(text) {
  const invitation = parseInvitation(text, appVersion());
  const { origin } = await docIdentity();
  if (invitation.mode === 'public' && new URL(invitation.base).origin !== origin) throw new Error('otherInstance');
  if (invitation.expire && nowS() > invitation.expire) throw new Error('invitationExpired');
  if (invitation.mode !== 'echange') return invitation;
  if (invitation.retourOrigin !== origin) throw new Error('otherInstance');
  if (!(await isOwner())) throw new Error('exchangeOwner');
  // L'Échange reprend l'identifiant de l'export de l'autre document : ce ne doit pas être celui
  // d'un export d'ici, qu'il remplacerait en coupant ses destinataires, sauf le retour de ce même
  // Échange (nouvelle invitation pour une réception déjà là, voir relinkReception).
  const schema = await readSchema();
  // Le retour de l'Échange est un export d'ici : il a besoin de la table Synchro du widget, que le
  // widget ne prend pas à quelqu'un d'autre (voir foreignSync).
  if (foreignSync(schema)) throw new Error('syncTableForeign');
  const local = readSourceNote(schema).exports.some(e => e.id === invitation.export) || (await syncRows(schema)).some(r => r[EXPORT_COL] === invitation.export);
  const again = receivedJournals(schema).some(r => r.note.export === invitation.export && r.note.mode === 'echange' && !r.note.retour);
  if (local && !again) throw new Error('exportTaken');
  const share = await shareInfo(invitation.retour);
  if (!share) throw new Error('shareUnknown');
  if (!sameDoc(share.docId, invitation.from.docId || '')) throw new Error('shareOtherDoc');
  return { ...invitation, share, backCode: await controlCode(invitation.retour, invitation.secret, codeFacts(invitation)) };
}

// Le document qui invite, tel que la note du journal le garde : ce que dit l'invitation (e-mail, identifiant, équipe,
// nom saisi par la SOURCE : des dires), et pour un Échange ce que Grist dit de la clé de retour, nom et équipe
// vérifiés, qui l'emportent.
export const sourceOf = invitation => ({
  ...invitation.from,
  ...(invitation.share ? { docName: invitation.share.name, ...(invitation.share.team ? { team: invitation.share.team } : {}) } : {}),
});

// Clés de cette réception (voir linkKeys) : une paire tirée ici, dont seule la clé publique est gardée
// (dans la note du journal, pour la réponse), et la clé publique de l'invitation. `down` vérifie les
// envois de la SOURCE, `up` signe l'envoi de retour d'un Échange.
async function receptionKeys(invitation) {
  const pair = await newKeyPair();
  return { pub: pair.pub, ...(await linkKeys(pair.priv, invitation.pub, invitation.export, invitation.id)) };
}
const keyNote = (invitation, keys) => ({ pub: keys.pub, pubSource: invitation.pub });

// 2. La réception de cet export qui existe déjà dans ce document (journal et note), ou null.
export async function knownReception(invitation) {
  return receivedJournals(await readSchema()).find(r => r.note.export === invitation.export) || null;
}

// Une nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) reprend la même
// réception si elle vient du même document, dans le même mode (jamais en lien public, ni pour un journal
// de retour). Sinon la personne ne peut pas la recevoir une seconde fois.
export const canRelink = (known, invitation) => invitation.mode !== 'public' && invitation.mode === (known.note.mode || 'reponse') && !known.note.retour
  && (known.note.from || {}).docId === invitation.from.docId;

// Réception branchée avant les clés de signature (ni sceau ni clé notée) : la renforcer est une suggestion.
export async function isUnsignedReception(known) {
  return !known.note.sceau && !receivedKey(await readSchema(), known.journal, known.note);
}

// Reprend la réception `known` avec la nouvelle invitation : son journal et ses tables restent, les clés
// de signature sont tirées de nouveau (avec la clé publique de cette invitation). Un Échange rebranche
// son retour sur la nouvelle adresse. Rend le journal et sa note, pour l'étape du lien.
export async function relinkReception(known, invitation) {
  if (!canRelink(known, invitation)) throw new Error('alreadyReceived');
  const { id, secret, name, renforce } = invitation;
  const from = sourceOf(invitation);
  const keys = await receptionKeys(invitation);
  // Une réception qui n'a jamais eu de clé (branchée avant les signatures) attend la première livraison signée en
  // acceptant l'ancien envoi, 7 jours au plus (voir reinforce.js).
  const wasUnsigned = await isUnsignedReception(known);
  const now = nowS();
  await updateJournalNote(known.journal, n => startRenf({ ...n, id, secret, name, from, renforce: renforce || undefined, ...keyNote(invitation, keys) }, wasUnsigned, now));
  await storeKey(known.note.tables.map(tb => tb.dest), invitation.export, keys.down);
  const note = receivedJournals(await readSchema()).find(r => r.journal === known.journal).note;
  if (invitation.mode === 'echange') await wireExchange(note, invitation.retour, keys.up);
  await ensureForm(known.journal);
  return { journal: known.journal, note };
}

// Un Échange en sécurité renforcée suppose d'avoir comparé avec la personne le code de contrôle de l'envoi de
// retour (`backCode`, rendu par readInvitation) : sans cela (`compared` faux), `codeNotCompared`. Vérifié avant
// de choisir les destinations et à nouveau avant de créer la réception.
export const mustCompare = invitation => Boolean(invitation.renforce && invitation.mode === 'echange');
const mustHaveCompared = (invitation, compared) => {
  if (mustCompare(invitation) && !compared) throw new Error('codeNotCompared');
};

// 3. Les destinations choisies (`plans` : [{ tb, dest }], `tb` = la table de l'invitation) : aucune ne doit
// boucler vers le document d'origine ni être déjà prise (voir checkDests). Rend le schéma lu et les
// destinations qui existent déjà (`existing`) : la personne en choisit la correspondance des colonnes
// avant de créer (`plan.map`, `plan.match`).
export async function checkDestinations(invitation, plans, { compared = false } = {}) {
  mustHaveCompared(invitation, compared);
  const schema = await readSchema();
  await checkDests(schema, plans.map(p => ({ table: p.tb.table, dest: p.dest })), invitation.from.docId);
  return { schema, existing: plans.filter(p => schema.has(p.dest)).map(p => p.dest) };
}

// Note du journal d'une réception qu'on vient d'accepter. Les colonnes que ce document crée (voir
// missingColumns, dans le schéma `before`) suivront les choix de la SOURCE. `reserve` : le journal est
// lisible par les éditeurs seulement ; `options` : archive et tables en lecture seule (hors Échange).
function receptionNote(invitation, plans, keys, before, { reserve, options }) {
  const { mode } = invitation;
  const own = p => missingColumns(before, p.dest, p.tb.columns, p.map || {});
  return {
    id: invitation.id, export: invitation.export, name: invitation.name, secret: invitation.secret,
    from: sourceOf(invitation),
    ...(mode === 'public' ? { mode, base: invitation.base } : mode === 'echange' ? { mode } : {}),
    ...(invitation.renforce ? { renforce: true } : {}), ...(reserve !== false ? { reserve: true } : {}), ...(keys ? keyNote(invitation, keys) : {}),
    ...(mode === 'echange' ? {} : optionsNote(options || {})),
    tables: plans.map(p => ({
      table: p.tb.table, dest: p.dest, columns: p.tb.columns, own: own(p), ...(p.map ? { map: p.map } : {}), ...(p.match ? { match: p.match } : {}),
      // Destination qui existait déjà, réception qui demande l'accord : sa première recopie attend un aperçu (voir adopt.js).
      ...(options && options.ask && mode !== 'echange' && mode !== 'public' && before.has(p.dest) ? { adopt: true } : {}),
    })),
    refused: [], missing: {},
  };
}

// Un journal pour l'export, nommé d'après lui, et une destination par table. `plans` : [{ tb, dest, map?,
// match? }]. Échange : l'envoi de retour est branché aussitôt ; l'adresse de retour, un droit d'écriture,
// n'est notée nulle part. Hors lien public, le formulaire du journal est publié (ensureForm) ; en lien
// public, il n'y a pas de formulaire et la recopie commence. `arrange` (faux par défaut : l'hôte décide de
// la mise en page de son document) : la page du formulaire se range sous celle de la destination
// (`ensureForm`, `below`) et le partage du formulaire garde de quoi reconnaître la réception si son
// journal est supprimé (`note`, voir markReceptions). Rend `{ journal, note, created }` : `created` = les
// destinations que cette réception a créées (pour undoReception).
export async function createReception(invitation, plans, { reserve = true, options = {}, compared = false, arrange = false } = {}) {
  mustHaveCompared(invitation, compared);
  const journal = journalId(invitation.name, (await readSchema()).tableIds);
  const { mode } = invitation;
  const keys = mode === 'public' ? null : await receptionKeys(invitation);
  const before = await readSchema();
  const note = receptionNote(invitation, plans, keys, before, { reserve, options });
  for (const p of plans) await prepareDest({ dest: p.dest, columns: p.tb.columns, map: p.map });
  if (keys) await storeKey(plans.map(p => p.dest), invitation.export, keys.down);
  await createJournal(journal, note);
  if (mode === 'echange') await wireExchange(note, invitation.retour, keys.up);
  const created = plans.map(p => p.dest).filter(d => !before.has(d));
  if (mode !== 'public') await ensureForm(journal, arrange ? { below: plans.map(p => p.dest), note } : {});
  else consolidateAll();
  return { journal, note, created };
}

// Défait la réception qu'on vient de créer (la personne revient aux destinations) : le journal et son
// formulaire (avec son lien d'écriture) sont effacés, et les tables que cette réception a créées, si
// elles sont encore vides.
export async function undoReception({ journal, created }) {
  const empty = [];
  for (const table of created) if (!(await fetchRows(table).catch(() => [null])).length) empty.push(table);
  await removeTechnicalTables([journal]);
  await apply(empty.map(table => ['RemoveTable', table]));
}

// E-mail de la personne connectée, calculé par le serveur Grist : une ligne vide ajoutée au journal avec
// ses droits remplit la colonne Sync_Par (formule user.Email). Le nettoyage l'efface.
export async function myEmail(journal) {
  const id = (await apply([['AddRecord', journal, null, { [APPLIED_COL]: true, [LIST_COL]: '' }]])).retValues[0];
  return ((await fetchRows(journal)).find(r => r.id === id) || {})[AUTHOR_COL] || '';
}

// 4. La réponse à renvoyer, une fois le lien du formulaire collé : il doit écrire dans ce journal (test de
// l'écriture, voir testUrl). Une réception d'avant la 0.10 en attente de réponse n'a pas de clé publique :
// il faut une nouvelle invitation. Rend le code de réponse et son code de contrôle.
export async function receptionReply({ journal, note }, link) {
  if (!note.pub) throw new Error('codeOld');
  if (!parseFormLink(link)) throw new Error('formLink');
  const url = buildWebhookUrl(link, journal);
  await testUrl(url, journal);
  const identity = await docIdentity();
  const exchange = note.mode === 'echange';
  const code = buildReply({
    id: note.id, secret: note.secret, url, retour: exchange ? note.tables.map(tb => ({ table: tb.dest, dest: tb.table })) : null, pub: note.pub, version: appVersion(),
    recipient: { email: await myEmail(journal), docId: identity.docId, team: identity.team, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
  });
  return { code, control: await controlCode(url, note.secret, codeFacts({ renforce: note.renforce, pub: note.pubSource }, note.pub)) };
}

// « Revenir à l'ancien fonctionnement » : une réception dont le renforcement n'est pas fini (la nouvelle clé n'a jamais
// signé une livraison) n'avait pas de clé avant lui ; elle l'oublie et accepte de nouveau l'ancien envoi tel quel.
// Rend la note du journal.
export async function revertReinforcement(journal) {
  const schema = await readSchema();
  const known = receivedJournals(schema).find(r => r.journal === journal);
  if (!known || !canRevert(known.note, nowS())) throw new Error('revertNone');
  await dropKey(known.note.tables.map(tb => tb.dest), keySlot(journal, known.note));
  return updateJournalNote(journal, revertedNote);
}
