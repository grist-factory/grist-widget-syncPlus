// SOURCE : inviter une personne et brancher sa réception, sans fenêtre. L'écran (js/source/recipient-wizard.js)
// montre les étapes ; chaque fonction ci-dessous fait ce qu'une étape fait quand la personne la valide,
// prend des données simples (l'export, l'invitation, le code collé) et rend des données (le code à
// transmettre, la réponse lue, l'étape qui suit). Ce que la personne voit et lit ne passe que par le
// port (`port.text`) ou par une erreur prévue (`failure`).
//
// Le déroulement, pour un envoi dans un seul sens :
//   startInvitation → invitationCode            (le code à transmettre)
//   checkReply                                   (la réponse collée, contrôlée chez Grist)
//   approveReply → loadPlan → sendExisting       (le webhook, puis l'existant si la personne le veut ; en sécurité
//                                                 renforcée, la comparaison du code de contrôle est exigée ici)
// Un Échange passe d'abord par startReturn → linkReturn (le formulaire de retour d'ici), puis
// invitationCode avec l'adresse de retour. Un lien public se fait en une fois (enablePublicLink).
// Une invitation expirée se refait par renewInvitation, annulée par cancelPendingInvitation.
//
// Une invitation porte toujours un secret, vaut 7 jours, et la clé publique d'une paire tirée pour elle ;
// la réponse porte celle de la CIBLE, et chaque côté en tire la clé qui signe les envois vers ce
// destinataire (voir linkKeys, trust.js). La réponse est contrôlée chez Grist : la clé de son formulaire
// doit désigner le document que dit la fiche. Un code de contrôle, tiré de l'adresse, du secret, des clés
// publiques et du niveau de sécurité, s'affiche des deux côtés ; en sécurité renforcée (`renforce`), il
// faut l'avoir comparé (l'écran le demande, le moteur ne le sait pas).
import { SYNC_TABLE, journalId, nowS, randomHex, sha256 } from '../logic/common.js';
import { buildInvitation, buildWebhookUrl, loopingTables, parseFormLink, parseReply } from '../logic/codes.js';
import { exportCondition, exportEmail, hookLabel, hookMemo, hookName, memoDoc, readTables } from '../logic/exports.js';
import { dropInvitation, putInvitation, setExport, setPause } from '../logic/notes.js';
import { codeFacts, controlCode, expiresAt, isExpired, isPrivateKey, linkKeys, newKeyPair, sameDoc } from '../logic/trust.js';
import { hiddenTables } from '../logic/acl.js';
import { receivedDests } from '../logic/received.js';
import { createWebhook, deleteWebhook, docIdentity, fetchRows, readSchema, shareInfo, t } from '../port.js';
import { appVersion } from '../version.js';
import { failure } from '../errors.js';
import { testUrl } from '../form-link.js';
import { addDeleteColumns, markHub } from '../exchange.js';
import { createJournal, storeKey, updateJournalNote } from '../target/journals.js';
import { pruneKeys, putRecipientKey, readHooks, recordEvent, rememberDest, saveExport, sourceFrom, syncRows, updateSourceNote } from './synchro.js';
import { publicCode } from './actions.js';
import { resendTables } from './resend.js';
import { exportEstimate } from './estimate.js';

// Où en est une invitation en attente : 'link' (un Échange attend le lien de son formulaire de retour), 'expired'
// (elle vaut 7 jours : son code est à refaire, voir renewInvitation) ou 'valid'.
export const invitationState = (inv, now = nowS()) => (inv.journal && !inv.ready ? 'link' : isExpired(inv.at, now) ? 'expired' : 'valid');

// Paire de clés d'une invitation (voir linkKeys) : la publique part dans le code, la privée reste
// dans la note jusqu'à l'approbation de la réponse. Une invitation d'avant la 0.10 en reçoit une
// quand son code est refait.
async function withKeys(entry) {
  if (isPrivateKey(entry.prive) && entry.pub) return entry;
  const { pub, priv } = await newKeyPair();
  return { ...entry, pub, prive: priv };
}

// 1. Une invitation pour un envoi dans un seul sens : secret tiré ici (le code ne le garde nulle part,
// seulement son empreinte), paire de clés, 7 jours. Une invitation renforcée rend l'export renforcé (plus
// de lien public). Rend l'export à jour, l'invitation (`entry`, à garder pour la suite) et son secret.
export async function startInvitation(exp, { renforce = false, replaces = '' } = {}) {
  let current = exp;
  if (renforce && !exp.renforce) {
    await updateSourceNote(note => setExport(note, exp.id, { renforce: true }));
    current = { ...exp, renforce: true };
  }
  const secret = randomHex(16);
  const entry = await withKeys({ id: randomHex(8), export: exp.id, hash: await sha256(secret), at: nowS(), ...(renforce ? { renforce: true } : {}), ...(replaces ? { replaces } : {}) });
  await updateSourceNote(note => putInvitation(note, entry));
  return { exp: current, entry, secret };
}

// Renforcer la sécurité d'un destinataire déjà branché (voir reinforce.js) : une invitation comme les autres, qui
// porte le webhook qu'elle remplace (`replaces`). À l'approbation de la réponse, un webhook neuf (avec sa clé propre)
// prend la place de l'ancien, sans avis de fin ; l'export, son historique et la réception de la personne ne changent pas.
// Seul un destinataire actif d'un envoi dans un seul sens se renforce ici (l'Échange se reprend par sa propre reprise).
export const canReinforce = (exp, hook) => Boolean(!exp.echange && !exp.public && hook && hook.fields.enabled);
export async function startReinforcement(exp, hook) {
  if (!canReinforce(exp, hook)) throw new Error('reinforceNot');
  return startInvitation(exp, { renforce: Boolean(exp.renforce), replaces: hook.id });
}

// Le webhook que `inv` remplace, s'il est encore là ; sa personne doit être celle de la réponse (le document dit par
// Grist, pas par le code), sinon une réponse d'un autre document prendrait la place d'un destinataire. Null sans `replaces`
// ou si l'ancien webhook a disparu entre-temps (l'invitation vaut alors celle d'un nouveau destinataire).
async function replacedHook(exp, inv, reply) {
  if (!inv.replaces) return null;
  const old = (await readHooks()).of(exp.id).find(h => h.id === inv.replaces);
  if (!old) return null;
  const { docId } = memoDoc(old.fields.memo);
  if (docId && !sameDoc(reply.share.docId, docId)) throw new Error('reinforceOtherDoc');
  return old;
}

// Le code à transmettre pour l'invitation `entry` (et son secret). `retour` : l'adresse d'écriture du
// journal de retour d'un Échange. Rend le code, sa date d'expiration (secondes) et, pour un Échange, le
// code de contrôle de l'envoi de retour que la CIBLE voit en lisant l'invitation (`backCode`).
export async function invitationCode(exp, entry, secret, retour = '') {
  const [identity, rows] = await Promise.all([docIdentity(), syncRows()]);
  const { origin } = identity;
  const expire = expiresAt(entry.at);
  const code = buildInvitation({
    id: entry.id, exportId: exp.id, name: exp.name, origin, secret, from: await sourceFrom(exportEmail(rows, exp.id), identity), tables: exp.tables, retour,
    expire, renforce: Boolean(entry.renforce), pub: entry.pub, version: appVersion(),
  });
  return { code, expire, backCode: retour ? await controlCode(retour, secret, codeFacts(entry)) : null };
}

// Refaire l'invitation `inv` (expirée, ou dont le code n'a pas été gardé) : nouveau secret, 7 jours de
// plus ; l'ancien code ne sert plus. Pour une invitation d'Échange (`inv.journal`), c'est linkReturn qui
// refait le code, par le lien de retour : rien n'est fait ici.
export async function renewInvitation(inv) {
  if (inv.journal) return null;
  const secret = randomHex(16);
  const entry = await withKeys({ ...inv, hash: await sha256(secret), at: nowS() });
  await updateSourceNote(note => putInvitation(note, entry));
  return { entry, secret };
}

// Lien public : l'export devient lisible par ses instantanés. Refusé si une règle d'accès cache une
// partie de ses tables. Rend le code à transmettre. Les règles d'accès sont posées à la fermeture de la
// fenêtre (le document se recharge alors : voir syncRules).
export async function enablePublicLink(exp) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const hidden = hiddenTables(resources, rules, readTables(exp.tables));
  if (hidden.length) throw failure('publicHidden', { tables: hidden.join(', ') });
  await updateSourceNote(note => setExport(note, exp.id, { public: true }));
  await saveExport(exp.id, exp.tables, { isPublic: true });
  return publicCode(exp, appVersion());
}

// 2 bis. Échange : un journal de retour, que la CIBLE remplira par le formulaire publié ici, sur sa
// propre page. Rend l'invitation en attente de l'adresse de ce formulaire (`entry.journal`), que
// l'écran montre avec ensureForm (pages.js) et formWhere ; sans secret tant que linkReturn n'a pas fait
// le code.
export async function startReturn(exp, { renforce = false } = {}) {
  let current = exp;
  if (renforce && !exp.renforce) {
    await updateSourceNote(note => setExport(note, exp.id, { renforce: true }));
    current = { ...exp, renforce: true };
  }
  const journal = journalId(exp.name, (await readSchema()).tableIds);
  const entry = await withKeys({ id: randomHex(8), export: exp.id, hash: '', at: nowS(), journal, ...(renforce ? { renforce: true } : {}) });
  await createJournal(journal, {
    id: entry.id, export: exp.id, name: exp.name, secret: '', from: {}, mode: 'echange', retour: true, reserve: true, tables: [], refused: [], missing: {},
  });
  await updateSourceNote(note => putInvitation(note, entry));
  return { exp: current, entry };
}

// Le lien du formulaire de retour, collé par la personne : le lien doit écrire dans ce journal-ci (test
// de l'écriture, voir testUrl). Rend l'invitation prête (secret tiré, clés), son secret et l'adresse
// d'écriture du retour (à passer à invitationCode ; un droit d'écriture, jamais notée).
export async function linkReturn(inv, link) {
  if (!parseFormLink(link)) throw new Error('formLink');
  const retour = buildWebhookUrl(link, inv.journal);
  await testUrl(retour, inv.journal);
  const secret = randomHex(16);
  const entry = await withKeys({ ...inv, hash: await sha256(secret), at: nowS(), ready: true });
  await updateSourceNote(note => putInvitation(note, entry));
  return { entry, secret, retour };
}

// 3. La réponse collée par la personne, lue et contrôlée : même instance, cette invitation, encore
// valable, même secret, pas de boucle ; la clé de son formulaire désigne bien le document de la fiche
// (demandé à Grist, voir shareInfo) ; un Échange dit où la CIBLE a rangé chaque table de l'export. Une
// invitation en attente d'avant le secret obligatoire (sans empreinte) est acceptée sans secret. Les clés
// de ce destinataire sont tirées ici (`keys`) : une clé publique qui n'en est pas une rend la réponse
// invalide avant toute approbation. Rend la réponse avec `share` (le document, dit par Grist), `keys`,
// `code` (de contrôle) et `tables` (le texte des tables, selon le mode).
export async function checkReply(exp, inv, text) {
  const reply = parseReply(text, (await docIdentity()).origin, appVersion());
  if (reply.id !== inv.id || inv.hash !== (reply.secret ? await sha256(reply.secret) : '')) throw new Error('unknownInvitation');
  if (!isPrivateKey(inv.prive)) throw new Error('inviteOld');
  if (isExpired(inv.at, nowS())) throw new Error('invitationExpired');
  if (loopingTables(exp.tables.map(tb => tb.table), reply.recipient.docId, receivedDests(await readSchema())).length) throw new Error('loop');
  if (Boolean(inv.journal) !== Boolean(reply.retour) || (reply.retour || []).some(b => !exp.tables.some(tb => tb.table === b.dest))) throw new Error('codeInvalid');
  const share = await shareInfo(reply.url);
  if (!share) throw new Error('shareUnknown');
  if (!sameDoc(share.docId, reply.recipient.docId)) throw new Error('shareOtherDoc');
  return {
    ...reply, share, keys: await linkKeys(inv.prive, reply.pub, exp.id, inv.id), code: await controlCode(reply.url, reply.secret, codeFacts(inv, reply.pub)),
    tables: reply.retour ? reply.retour.map(b => t('send.exchange.map', b)).join(', ') : exp.tables.map(tb => tb.table).join(', '),
  };
}

// 4. Approuver la réponse (en sécurité renforcée, `compared` doit être vrai : sinon `codeNotCompared`, avant toute
// écriture) : un webhook sur Synchro, filtré sur l'export, vers le journal de la CIBLE ; la
// clé de ce destinataire est posée avant (rangée sous l'invitation, puis sous le webhook) : rien ne part
// vers lui sans sa signature. Échange : l'export reçoit sa ligne 'echange', le journal de retour sait
// d'où viennent ses tables (il commence à recopier) et quel webhook est celui de ce participant ; dès
// deux participants, l'Échange est à plusieurs (markHub). Rend l'identifiant du webhook.
export async function approveReply(exp, inv, reply, { compared = false } = {}) {
  // Sécurité renforcée : le code de contrôle doit avoir été comparé avec la personne (`compared`, case de l'écran).
  if (inv.renforce && !compared) throw new Error('codeNotCompared');
  const r = reply.recipient;
  const old = await replacedHook(exp, inv, reply);
  await putRecipientKey(exp.id, inv.id, reply.keys.down);
  const memo = hookMemo({ ...r, docName: reply.share.name });
  // Le mémo d'un webhook se lit dans les métadonnées du document : il ne porte qu'un jeton, la fiche reste dans la note.
  const hook = await createWebhook({ name: hookName(exp.name, exp.id), memo: await rememberDest(memo), url: reply.url, tableId: SYNC_TABLE, condition: exportCondition(exp.id) });
  // Renforcement : ni arrivée ni départ dans l'historique (le compte des destinataires ne change pas), un seul événement.
  await recordEvent(exp.id, old ? 'reinforce' : 'join', { who: hookLabel(memo) });
  await putRecipientKey(exp.id, hook, reply.keys.down, inv.id);
  // L'ancien envoi s'arrête sans avis de fin : la CIBLE ne doit pas se croire coupée. Le nouveau est déjà branché.
  if (old) await deleteWebhook(old.id);
  if (inv.journal) {
    await addDeleteColumns(exp.tables.map(tb => tb.table));
    await saveExport(exp.id, exp.tables, { swap: true });
    // Le journal de retour vérifie la signature des envois du participant, avec la clé de retour
    // tirée de sa réponse : elle est rangée dans ses destinations, les tables de l'export (voir
    // receivedKey).
    await storeKey(exp.tables.map(tb => tb.table), inv.journal, reply.keys.up);
    // `own` vide : les tables de l'export sont les nôtres, le widget n'y a créé aucune colonne.
    await updateJournalNote(inv.journal, n => ({
      ...n, from: { email: r.email, docId: r.docId, docName: reply.share.name }, hook, tables: reply.retour.map(b => ({ table: b.table, dest: b.dest, columns: [], own: [] })),
    }));
    await markHub(exp.id);
  }
  await updateSourceNote((note) => {
    const rest = dropInvitation(note, inv.id);
    const kept = old ? setPause(rest, old.id) : rest;
    return inv.journal ? setExport(kept, exp.id, { echange: true }) : kept;
  });
  await pruneKeys(exp.id);
  return hook;
}

// 5. L'existant : le branchement n'envoie que les modifications à venir. `loadPlan` dit ce que l'envoi de
// l'existant coûterait : `total` (lignes des tables) et `est` (lignes qui peuvent partir, lots, durée :
// voir exportEstimate ; null si Grist ne permet pas de le dire).
export async function loadPlan(exp) {
  let total = 0;
  for (const { table } of exp.tables) total += (await fetchRows(table)).length;
  const est = total ? await exportEstimate(exp).catch(() => null) : null;
  return { total, est, count: est ? est.rows : total };
}

// Envoie l'existant à tous les destinataires de l'export (par tranches, sous le budget des renvois :
// `progress` reçoit l'avancement, voir resendTables). Rend le nombre de lignes envoyées, ou null si le
// renvoi attend son tour.
export const sendExisting = (exp, progress) => resendTables(exp.id, exp.tables.map(tb => tb.table), progress);

// Renforcement : la CIBLE reconnaît le nouvel envoi à sa première livraison signée. Un renvoi de contrôle (ce que les
// destinataires ont déjà n'est pas touché : une version sans changement est sans effet chez eux) fait partir cette
// livraison tout de suite, avec ce qui a changé depuis l'invitation. Rend le nombre de lignes envoyées, ou null si le
// renvoi attend son tour.
export const controlResend = (exp, inv, progress) => resendTables(exp.id, exp.tables.map(tb => tb.table), progress, inv.at);
