// Onglet « Envoyer » (document SOURCE) : une carte par export (un nom, des tables et leurs
// colonnes) avec ses destinataires. Une seule table technique, Synchro ; un webhook par
// destinataire, filtré par Grist sur les lignes de son export.
import { EXPORT_COL, KIND, LOT_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, nowS } from '../engine/logic/common.js';
import { known } from '../engine/errors.js';
import { maskKey } from '../engine/logic/codes.js';
import { conditionExport, driftDetails, exportDrift, exportEmail, exportStatus, exportTables, failureStatus, hookBusy, hookErrorKey, hookStatus, hooksOf, NO_UNBLOCK, queueBlocker, readTables } from '../engine/logic/exports.js';
import { editorsEditStructure, hiddenTables } from '../engine/logic/acl.js';
import { STATES, parseLot } from '../engine/logic/journal.js';
import { eventsOf, recentDrops, vanishedRecipients } from '../engine/logic/notes.js';
import { exchangeRules } from '../engine/logic/consolidation.js';
import { listDue, lotLate, parseCharge, trackedCounts } from '../engine/logic/resend.js';
import { flowMoves } from '../engine/logic/health.js';
import { LONG_SECONDS } from '../engine/logic/estimate.js';
import { deleteWebhook, docIdentity, fetchRows, listWebhooks, publicAccess, readSchema, webhookConditions } from '../grist.js';
import { expiresAt, unkeyedRecipients } from '../engine/logic/trust.js';
import { unsignedHooks } from '../engine/logic/reinforce.js';
import { columnFault, foreignSync, hasContent, lostSync, ownsSync, refusedColumn, strayColumns, syncColumnIds } from '../engine/logic/strays.js';
import { protectSync, ruleRefusal, syncRules } from '../engine/acl.js';
import { ensureSyncTable, identified, isCharge, protectMemos, readHooks, readSourceNote, refreshMajLe, refreshOptions, updateSourceNote, watchRows } from '../engine/source/synchro.js';
import { catchUp, currentCharge, flowOf, resendTables } from '../engine/source/resend.js';
import { exportEstimate } from '../engine/source/estimate.js';
import { newColumns } from '../engine/logic/new-columns.js';
import { autoSendNewColumns, baselineNewColumns, dismissNewColumns, sendNewColumns } from '../engine/source/new-columns.js';
import { driftNotice, newColumnsNotice } from './new-columns.js';
import { checkHooks, hookCheck, personLabel } from '../engine/source/hook-check.js';
import { canReinforce, invitationState, startReinforcement } from '../engine/source/invite.js';
import { confirmSend, flowView, progressTo } from './flow.js';
import { filesPending, resendFiles } from '../engine/source/files.js';
import { cancelInvitation, clearHistory, deleteExport, pause, resume, revoke, showPublicCode, stopPublic, unblockQueue } from './actions.js';
import { exportWizard } from './export-wizard.js';
import { foreignDialog, strayDialog } from './strays.js';
import { checkKeys } from '../engine/source/keys.js';
import { keysBlock } from './keys.js';
import { lastSend } from './last-send.js';
import { accessMoved, clearStay, forgettable, lingering, waitsForAccess, watchesAccess } from './public-stay.js';
import { filterSummary } from './filter-editor.js';
import { recipientWizard } from './recipient-wizard.js';
import { hookDoc, hookShown } from './shown.js';
import { rulesRefusedNotice } from '../rules-notice.js';
import { confirmDialog, docLink, el, icon, message, noteError, notice as noticeBox, pill, redraw, reloading, run, smallButton } from '../ui.js';
import { roleGuide } from '../guide.js';
import { dateText, t } from '../i18n.js';
import { askWizard, dropWizard, wizardAsked } from '../prefs.js';

// Fiche affichée d'un destinataire : sans l'identifiant du document (il reste dans l'infobulle, `personLabel`).
const personShown = h => hookShown(h.fields.memo, hookCheck(h.id).docName) || '—';

// Instance de CE document (les liens vers les documents des destinataires en sont refaits : ils ne quittent pas
// l'instance), lue à chaque affichage.
let here = '';

// La même fiche, le document en lien (nouvel onglet) tant que le lien du destinataire désigne bien le document
// approuvé : pas de lien quand le contrôle horaire dit le contraire (autre document, adresse qui n'est pas celle d'un
// formulaire), le texte reste.
const personNameOf = (exp, inv) => {
  const h = exp.recipients.find(r => r.id === inv.replaces);
  return h ? personShown(h) : t('send.renf.someone');
};

function personWho(h) {
  const { other, bad, docName } = hookCheck(h.id);
  const { who, place, url } = hookDoc(h.fields.memo, docName, other || bad ? '' : here);
  if (!place) return personShown(h);
  return [who, who ? ' · ' : null, docLink(place, url)];
}

let container;
let notice = null; // message à montrer au prochain affichage (fin d'un renvoi)
let resumed = false; // l'assistant d'un Échange ne se rouvre seul qu'une fois par chargement
// Droit du lien public tel que l'écran l'a dessiné (voir public-stay.js) : `watch` dit si l'écran en dépend, donc si chaque coup
// d'œil le relit à `base`, et `waiting` si la personne est en train de le changer dans Grist (relecture plus rapprochée).
let shownAccess = { base: '', access: null, watch: false, waiting: false };

// ---------------------------------------------------------------------------------------------
// État du document : exports (note + lignes Synchro), destinataires (webhooks sur Synchro, rangés
// par l'export que nomme leur condition), invitations en attente.

async function loadState() {
  let hooks = [];
  let ownerOnly = false;
  try { hooks = await listWebhooks(); } catch (e) { if (e.message !== 'ownerOnly') throw e; ownerOnly = true; }
  const conditions = ownerOnly ? new Map() : await webhookConditions();
  const schema = await readSchema();
  // Une table nommée Synchro qui n'est pas celle du widget n'est pas lue (voir foreignSync).
  const all = ownsSync(schema) ? await fetchRows(SYNC_TABLE) : [];
  const rows = all.filter(r => !isCharge(r));
  const note = readSourceNote(schema);
  hooks = identified(hooks, note); // le mémo de chaque webhook devient la fiche de son destinataire (rangée dans la note)
  // Règles d'accès (lisibles par un propriétaire seulement) : revérifiées à chaque affichage.
  const [resources, aclRules] = ownerOnly ? [[], []] : await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const acl = { resources, rules: aclRules };
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])];
  const exports = ids.map(id => exportState(id, { note, rows, schema, acl, recipients: hooksOf(hooks, conditions, id) }));
  const unsafe = hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id)));
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  // Colonnes de Synchro qui ne sont pas au widget : un envoi les emporte, un journal les refuse.
  const syncCols = ownsSync(schema) ? schema.columns(SYNC_TABLE).map(c => c.colId) : [];
  const strays = ownerOnly || !syncCols.length ? [] : strayColumns(schema.columns(SYNC_TABLE), all);
  // Lignes sans clé ou de même clé dans les tables envoyées : elles n'arrivent pas chez les destinataires.
  const keys = ownerOnly ? new Map() : await checkKeys(exports.flatMap(exp => exp.tables.map(tb => tb.table)));
  const blocker = queueBlocker(exports.flatMap(exp => exp.recipients));
  // Synchro perdue (effacée, renommée, illisible) alors que des webhooks du widget restent : voir lostSync.
  const lost = ownerOnly ? null : lostSync(schema, hooks, conditions);
  return { ownerOnly, schema, rows, note, exports, unsafe, charge, strays, syncCols, keys, blocker, lost, foreign: !ownerOnly && !lost && foreignSync(schema) };
}

// Ce que « Vos partages » (js/news.js) annonce : exports, destinataires dont l'envoi se renforce, invitations d'avant les clés (à refaire).
export async function reinforceFacts() {
  const { exports, note } = await loadState();
  const mine = exports.filter(exp => !exp.retour);
  const people = mine.filter(exp => !exp.echange && !exp.public).reduce((n, exp) => n + exp.recipients.filter(h => exp.unsigned.has(h.id)).length, 0);
  return { exports: mine.length, people, invitations: note.invitations.filter(inv => !inv.pub && !inv.journal).length };
}

function exportState(id, { note, rows, schema, acl, recipients }) {
  const mine = rows.filter(r => r[EXPORT_COL] === id);
  const tables = exportTables(rows, id);
  const entry = note.exports.find(e => e.id === id) || { id, name: id };
  return {
    ...entry, tables, recipients, invitations: note.invitations.filter(i => i.export === id),
    // Lien public : une règle d'accès posée depuis cache une partie de ce qu'il montre à tous.
    hidden: entry.public ? hiddenTables(acl.resources, acl.rules, readTables(tables)) : [],
    // Renforcé : les éditeurs peuvent réécrire les formules de Synchro (droit de structure).
    structure: Boolean(entry.renforce) && editorsEditStructure(acl.resources, acl.rules),
    email: exportEmail(mine, id),
    events: eventsOf(note, id),
    // Avec les repères d'un historique effacé (clearEvents) : ils comptent encore pour les destinataires disparus et les clés.
    ledger: eventsOf(note, id, { all: true }),
    // Destinataires sans clé de signature (ligne 'signature' de Synchro perdue) : leur CIBLE rejette les envois.
    unkeyed: new Set(unkeyedRecipients((mine.find(r => r[TYPE_COL] === KIND.sign) || {})[SCHEMA_COL], recipients.map(h => h.id), eventsOf(note, id, { all: true }).some(e => e.kind === 'join'))),
    // Destinataires sans clé de signature (envoi d'avant les clés) : leur partage se renforce, par une invitation qui remplace l'envoi.
    unsigned: new Set(unsignedHooks((mine.find(r => r[TYPE_COL] === KIND.sign) || {})[SCHEMA_COL], recipients)),
    // Tables dont des lignes ou la liste des clés restent à envoyer (voir exportFlow).
    owed: recipients.length ? new Set(mine.filter(r => lotLate(r) || listDue(r)).map(r => r[TABLE_COL])).size : 0,
    // Lien public : tables dont l'instantané dépasse la taille permise (il reste vide).
    tooBig: mine.filter(r => r[TYPE_COL] === KIND.full && (parseLot(r[LOT_COL]) || {}).tooBig).map(r => r[TABLE_COL]),
    ...exportDrift(schema, tables),
    // Le détail de ces colonnes, et celles ajoutées depuis l'enregistrement (voir new-columns.js) : jamais pour un Échange.
    details: driftDetails(schema, tables),
    fresh: entry.retour || entry.echange ? [] : newColumns(schema, tables, entry.known),
  };
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord

// Redessine l'onglet s'il est affiché et qu'aucune fenêtre n'est ouverte (rattrapage terminé). Ce
// redessin périodique ne touche pas aux règles d'accès : leur changement rechargerait le widget au
// milieu d'une action en cours (vu : le partage d'un formulaire effacé restait).
export async function refreshSource() {
  if (container && container.isConnected && !document.querySelector('.scrim')) await renderSource(container, { periodic: true });
}

export async function renderSource(root = container, { periodic = false } = {}) {
  container = root;
  const state = await upgradeSource(await loadState());
  const { access, open } = await readPublicAccess(state);
  // Règles d'accès du widget (voir syncRules) : Synchro réservée aux propriétaires, et lien public
  // accordé aux exports partagés.
  if (!periodic && !state.ownerOnly && await syncRules({ publicIds: state.exports.filter(e => e.public).map(e => e.id), open })) {
    reloading(container, renderSource);
    return;
  }
  redraw(container, sourceView(state, access, open));
  // « Nouvel export » demandé juste avant le rechargement que les règles d'accès ont causé : l'assistant s'ouvre.
  if (!periodic && wizardAsked('export', { consume: true }) && !state.ownerOnly && !state.foreign && !blocksNew(state.lost)) run(null, container.querySelector('.out'), newExport);
  watchSource(state);
  if (state.ownerOnly) return;
  resumeExchange(state);
  if (!periodic) askAboutSync(state);
  if (await checkHooks(state.exports.flatMap(exp => exp.recipients))) await renderSource(root, { periodic });
}

// Document lisible par lien public ? Vérifié à chaque affichage : tant qu'il l'est, le refus général posé par le widget reste en
// place, même sans export public ; le widget n'en pose jamais un sur un document qu'il n'a pas partagé lui-même. Lien public réglé
// sur Éditeur : les règles du widget, qui visent les lecteurs, ne protègent plus rien. Réponse inconnue (null) : rien ne change.
async function readPublicAccess(state) {
  const identity = await docIdentity();
  here = identity.origin;
  const access = await publicAccess(identity.baseUrl);
  // Ce que l'écran montre du lien public, relu à chaque coup d'œil tant qu'il en dépend (voir tickFlows).
  const facts = { note: state.note, exports: state.exports, access };
  shownAccess = { base: identity.baseUrl, access, watch: !state.ownerOnly && watchesAccess(facts), waiting: !state.ownerOnly && waitsForAccess(facts) };
  if (!state.ownerOnly && forgettable(facts)) updateSourceNote(clearStay).catch(console.warn); // lien fermé : le lien coupé est oublié
  return { access, open: access === null ? null : Boolean(access) };
}

// Relecture de l'état d'envoi tant que quelque chose bouge, ou au rythme du repos s'il y a un destinataire ou un lien public à suivre.
function watchSource(state) {
  if ([...flowSlots.values()].some(slot => slot.moving) || state.exports.some(exp => exp.recipients.some(hookBusy))) watchFlows();
  else if (state.exports.some(exp => exp.recipients.length) || shownAccess.watch) watchFlows(restMs());
}

// Mise à niveau silencieuse du montage (colonnes de Synchro, dépendances de MajLe), puis
// rattrapage d'un envoi coupé. Les lectures de loadState servent aux deux : l'état n'est relu
// qu'après une écriture.
async function upgradeSource(state) {
  if (state.ownerOnly || !ownsSync(state.schema)) return state;
  let current = state;
  if (await ensureSyncTable(current.schema, current.rows)) current = await loadState();
  if (await refreshMajLe(current.schema, current.rows)) current = await loadState();
  if (await refreshOptions(current.schema, current.rows)) current = await loadState();
  if (await protectMemos()) current = await loadState(); // fiches des destinataires hors du mémo des webhooks (lisible par tous)
  // Lignes qui quittent un export (la CIBLE est passive, la SOURCE est prévenue) : voir observeRows.
  const recipientsOf = id => (current.exports.find(exp => exp.id === id) || { recipients: [] }).recipients.length;
  if (await watchRows(current.note, trackedCounts(current.rows), recipientsOf)) current = await loadState();
  // Colonnes ajoutées aux tables d'un export : la référence se pose sans rien dire, et un export qui les envoie seul le fait (voir new-columns.js).
  if (await baselineNewColumns(current.exports)) current = await loadState();
  if (await autoSendNewColumns(current.exports).catch(noteError)) current = await loadState();
  catchUp(refreshSource);
  return current;
}

// Cartes de l'onglet, les avertissements d'abord (table perdue, d'une autre personne, colonnes en trop, envois
// douteux), puis un export par carte. Les exports ne se montrent qu'aux propriétaires : Synchro leur est réservée
// (voir acl.js).
function sourceCards(state, open, out) {
  const cards = state.ownerOnly || state.foreign ? [] : state.exports.map(exp => exportCard(exp, state, open, out));
  if (state.unsafe.length) cards.unshift(unsafeCard(state.unsafe, state.ownerOnly, out));
  if (state.strays.length) cards.unshift(strayCard(state, out));
  if (state.foreign) cards.unshift(foreignCard(state, out));
  if (state.lost) cards.unshift(lostCard(state.lost, out));
  return cards;
}

// « Nouvel export » : grisé quand rien ne peut s'écrire (table d'une autre personne, table perdue) ou pour qui n'est pas propriétaire.
function newExportButton(state, out) {
  const why = state.foreign ? t('send.foreign.blocked') : blocksNew(state.lost) ? t('send.lost.blocked') : null;
  return el('button', {
    class: 'btn btn-primary', type: 'button', disabled: state.ownerOnly || Boolean(why), title: why,
    onclick: e => run(e.currentTarget, out, newExport),
  }, icon('plus'), t('send.new'));
}

// Avant l'assistant, les règles d'accès de Synchro sont posées (protectSync) : la première ligne d'un export copie les
// colonnes envoyées, y compris celles qu'une règle cache aux lecteurs, et personne ne doit pouvoir la lire dans
// l'intervalle. Si Grist recharge le document pour cela, le widget repart et rouvre l'assistant (`wizardAsked`, qui refait
// ce même contrôle). Un appel coupé en route par le rechargement (il échoue alors sans message utile) n'est pas une erreur ;
// un refus de Grist ou une table Synchro d'une autre personne (erreurs prévues) sont dits à la personne.
async function newExport() {
  askWizard('export'); // noté AVANT : le rechargement de Grist coupe le widget en plein appel, avant que protectSync rende la main
  let posted;
  try {
    posted = await protectSync();
  } catch (e) {
    if (known(e)) {
      dropWizard('export');
      throw e;
    }
    posted = true;
  }
  if (posted) {
    reloading(container, renderSource);
    return;
  }
  dropWizard('export');
  exportWizard(null, renderSource);
}

// Contenu de l'onglet : « Nouvel export », avertissements, avis de la dernière action, cartes.
function sourceView(state, access, open) {
  flowSlots.clear();
  personSlots.clear();
  const out = el('div', { class: 'out' }, notice);
  notice = null;
  const cards = sourceCards(state, open, out);
  return [el('div', { class: 'toolbar' }, newExportButton(state, out)),
    state.ownerOnly ? message('info', t('send.ownersOnly')) : null,
    access && access !== 'viewers' ? message('err', t('send.public.editors')) : null,
    stayNotice(state, access, out),
    state.ownerOnly ? null : rulesRefusedNotice(),
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : state.ownerOnly ? null : el('p', { class: 'muted' }, t('send.empty')),
    roleGuide({ you: 'source' })].filter(Boolean);
}

// Échange qui attend le lien de son formulaire de retour (page fermée en route) : l'assistant
// reprend à cette étape, une fois par chargement.
function resumeExchange(state) {
  const pending = state.exports.flatMap(exp => exp.invitations.filter(inv => inv.journal && !inv.ready).map(inv => [exp, inv]))[0];
  if (pending && !resumed && !document.querySelector('.scrim')) openRecipient(...pending);
}

const openRecipient = (exp, pending = null, started = null) => {
  resumed = true;
  recipientWizard(exp, pending, renderSource, started);
};

// Renforcer la sécurité de ce destinataire : une invitation qui remplace son envoi (voir reinforce.js).
const reinforce = async (exp, hook) => {
  const started = await startReinforcement(exp, hook);
  openRecipient(started.exp, null, started);
};

// Bouton d'une carte : grisé pour qui n'est pas propriétaire, ou avec la raison (`reason`).
// L'action finie, l'onglet est redessiné.
const actionButton = (label, iconName, fn, ownerOnly, out, { kind = '', reason = '' } = {}) => smallButton(label, iconName,
  e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }), { kind, disabled: ownerOnly || Boolean(reason), title: reason || null });

// Bouton qui ouvre un assistant.
const wizardButton = (label, iconName, onclick, { primary = false, ownerOnly = false, reason = '' } = {}) =>
  smallButton(label, iconName, onclick, { kind: primary ? 'btn-primary' : '', disabled: ownerOnly || Boolean(reason), title: reason || null });

const statusPill = (key, tone, vars) => pill(t(`send.status.${key}`, vars), tone);

// Échange administré ici : les types de changement des participants qui ne sont pas acceptés d'office.
function rulesLine(exp) {
  const rules = exchangeRules(exp);
  if (!rules) return null;
  const list = STATES.filter(st => rules[st] !== 'accepter').map(st => `${t(`send.rules.${st}`)} (${t(`send.rules.${rules[st]}`)})`);
  return el('p', { class: 'muted small' }, t('send.exchange.rules', { rules: list.join(', ') }));
}

// Avis d'un export : tables perdues, colonnes changées, envoi incomplet, fichiers à envoyer, Échange.
const exportNotes = (exp, newColumnsActions) => [
  !exp.tables.length && !exp.retour ? message('err', t('send.export.rowsGone')) : null,
  exp.hidden.length ? message('err', t('send.public.hiddenNow', { tables: exp.hidden.join(', ') })) : null,
  exp.structure ? message('warn', t('send.renforce.structure')) : null,
  exp.lost.length ? message('warn', t('send.export.lost', { tables: exp.lost.join(', ') })) : null,
  driftNotice(exp),
  newColumnsNotice(exp, newColumnsActions),
  filesPending(exp.id) ? message('info', t('send.files.pending', { n: filesPending(exp.id) })) : null,
  exp.retour ? message('info', t('send.exchange.managed')) : null,
  exp.echange && !exp.retour ? el('p', { class: 'muted small' }, exp.recipients.length > 1 ? t('send.exchange.hub', { n: exp.recipients.length }) : t('send.exchange.with')) : null,
  exp.echange && !exp.retour ? rulesLine(exp) : null,
];

const tablesLine = exp => exp.tables.map(tb => t(tb.filter ? 'send.export.tableFiltered' : 'send.export.table',
  { table: tb.table, n: tb.columns.length, filter: filterSummary(tb.filter) })).join(' · ') || '—';

function exportCard(exp, state, open, out) {
  const { ownerOnly } = state;
  const n = exp.recipients.length;
  const [status, tone] = exportStatus(exp);
  const rows = [
    ...exp.recipients.map(h => personRow(exp, h, ownerOnly, out, state)),
    ...exp.invitations.map(inv => inviteRow(exp, inv, ownerOnly, out)),
    exp.public ? publicRow(exp, open, ownerOnly, out) : null,
  ].filter(Boolean);
  // Un envoi long se confirme avec son coût (lignes, lots, durée) ; il se suit sur la carte (voir
  // flowSlot), pendant que ce bouton attend la fin.
  const load = async () => {
    const est = await exportEstimate(exp).catch(() => null);
    if (est && est.seconds >= LONG_SECONDS && !(await confirmSend(est))) return;
    await resendFiles(exp.id);
    loading++;
    watchFlows();
    try {
      const total = await resendTables(exp.id, exp.tables.map(tb => tb.table), null);
      notice = total === null ? message('info', t('send.load.queued')) : message('ok', t('send.load.done', { n: total }));
    } finally {
      loading--;
    }
  };
  // L'export de retour d'un Échange (reçu d'un autre document) se règle depuis l'onglet Recevoir.
  // Un seul bouton principal par carte, l'étape suivante : ajouter un premier destinataire, ou
  // celui d'une invitation en attente.
  return el('article', { class: 'card', 'data-export': exp.id },
    el('div', { class: 'card-head' }, el('strong', {}, exp.name), statusPill(status, tone, { n: n + (exp.public ? 1 : 0) })),
    el('p', { class: 'muted small' }, tablesLine(exp)),
    keyNotice(exp, state),
    reinforceNotice(exp),
    behindNotice(exp, state),
    vanishedNotice(exp),
    shrinkNotices(exp),
    exportNotes(exp, newColumnsButtons(exp, ownerOnly, out)),
    flowSlot(exp, state.charge),
    rows.length ? el('ul', { class: 'people' }, rows) : el('p', { class: 'small' }, t('send.export.nobody')),
    eventsBlock(exp, out, ownerOnly),
    el('div', { class: 'card-actions' },
      exp.retour ? null : wizardButton(t(exp.echange ? 'send.action.addParticipant' : 'send.action.addPerson'), 'plus', () => openRecipient(exp), { primary: !rows.length, ownerOnly }),
      exp.retour ? null : wizardButton(t('send.action.edit'), 'edit', () => exportWizard(exp, renderSource), { ownerOnly }),
      actionButton(t('send.action.load'), 'send', load, ownerOnly, out, { reason: n ? '' : t('send.load.nobody') }),
      actionButton(t('send.action.delete'), 'trash', () => deleteExport(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Les deux gestes de l'avis des colonnes ajoutées : les envoyer (l'export est enregistré avec elles, la table renvoyée), ou les ignorer.
const newColumnsButtons = (exp, ownerOnly, out) => ({
  send: actionButton(t('send.new.send'), 'send', async () => {
    const n = await sendNewColumns(exp, progressTo(out));
    notice = n === null ? message('info', t('send.load.queued')) : message('ok', n ? t('send.edit.saved', { n }) : t('send.edit.savedNone'));
  }, ownerOnly, out, { kind: 'btn-primary' }),
  dismiss: actionButton(t('send.new.dismiss'), 'x', () => dismissNewColumns(exp), ownerOnly, out),
});

// Destinataires de cet export dont les envois attendent derrière l'envoi en échec d'une autre personne (la file de
// Grist est commune à tout le document) : un seul avis, quel que soit leur nombre.
function behindNotice(exp, { blocker }) {
  if (!blocker) return null;
  const n = exp.recipients.filter(h => h.id !== blocker.id && hookStatus(h)[0] !== 'error' && (h.usage || {}).numWaiting > 0).length;
  return n ? message('warn', t('send.behind', { n, who: personShown(blocker) })) : null;
}

// Destinataires dont le webhook a disparu des réglages de Grist (supprimé à la main) : rien ne leur est plus envoyé,
// et la carte n'en montre aucun.
function vanishedNotice(exp) {
  const n = exp.retour || exp.public ? 0 : vanishedRecipients(exp.ledger, exp.recipients.length);
  return n ? message('warn', t('send.vanished', { n }), t('send.vanished.title', { n })) : null;
}

// Lignes en moins dans une table de l'export depuis la dernière observation (voir observeRows) : la CIBLE les
// supprime aussi, et la SOURCE peut encore revenir en arrière.
const shrinkNotices = exp => recentDrops(exp.events, nowS()).map(d => message('warn',
  t('send.shrink.body', { date: dateText(d.at * 1000) }), t('send.shrink.title', { table: d.table, n: d.n })));

// Clés manquantes ou en double dans les tables de l'export (voir keysBlock).
function keyNotice(exp, state) {
  const problems = new Map([...state.keys].filter(([table]) => exp.tables.some(tb => tb.table === table)));
  return problems.size ? keysBlock(problems, () => renderSource(), { ownerOnly: state.ownerOnly }) : null;
}

// Historique des envois (voir addEvent), replié par défaut ; ce qu'on ouvre le reste d'un dessin à
// l'autre. En tête de liste, le dernier envoi ordinaire d'après Grist (voir last-send.js) : une ligne ajoutée ou modifiée part par
// le webhook, sans le widget, donc sans événement ici. Cette ligne n'est pas un événement de la note (elle n'est pas comptée dans le
// titre) : elle est relue toutes les 30 s page ouverte (voir tickFlows) et se met à jour sur place.
const eventsOpen = new Set();
const eventLine = e => el('li', { class: 'send-event' },
  el('time', { class: 'chg-time', datetime: new Date(e.at * 1000).toISOString() }, dateText(e.at * 1000)),
  el('span', {}, t(`send.history.${e.kind}`, { who: e.who || '—', n: e.n || 0 })));

// Remplit (ou cache) la ligne du dernier envoi ordinaire d'un export, à partir de l'état de ses destinataires.
function fillLast(row, recipients) {
  const last = lastSend(recipients);
  row.hidden = !last;
  if (!last) return;
  const text = [t('send.history.last')];
  // Plusieurs destinataires : celui qui a reçu le plus récent, les autres ont leur propre heure sur leur fiche.
  if (last.of > 1) text.push(' ', t('send.history.lastWho', { who: personShown(last.hook), n: last.n, of: last.of }));
  row.replaceChildren(
    el('time', { class: 'chg-time', datetime: new Date(last.at).toISOString() }, dateText(last.at)),
    el('span', {}, ...text));
}

const lastRow = exp => {
  const row = el('li', { class: 'send-event send-last', 'data-last-send': exp.id });
  fillLast(row, exp.recipients);
  return row;
};
const eventsBlock = (exp, out, ownerOnly) => (exp.events.length || lastSend(exp.recipients) ? el('details', {
  class: 'history', open: eventsOpen.has(exp.id), ontoggle: e => (e.currentTarget.open ? eventsOpen.add(exp.id) : eventsOpen.delete(exp.id)),
}, el('summary', {}, el('span', { class: 'history-title' }, t(exp.events.length ? 'send.history.title' : 'send.history.title.none', { n: exp.events.length }))),
  el('p', { class: 'muted small' }, t('send.history.help')), el('ul', { class: 'history-rows' }, [lastRow(exp), ...exp.events.map(eventLine)]),
  exp.events.length ? actionButton(t('send.history.clear'), 'trash', () => clearHistory(exp), ownerOnly, out, { kind: 'btn-link' }) : null) : null);

// Ce que dit l'erreur d'un destinataire. Un journal qui refuse une colonne que Synchro porte sans
// qu'elle soit au widget, ou qu'elle ne porte plus mais que la file garde, n'a rien à faire de son
// côté : le texte le dit (voir columnFault).
function errorText(h, syncCols) {
  const fault = columnFault(h.usage, syncCols);
  if (fault === 'stray') return t('send.error.stray', { col: refusedColumn(h.usage) });
  if (fault === 'gone') return t('send.error.gone', { col: refusedColumn(h.usage) });
  return t(hookErrorKey(h), { col: refusedColumn(h.usage) || '?', status: failureStatus(h) || '' });
}

// Un destinataire : sa fiche (mémo du webhook), son état, et ce qu'on peut faire pour lui seul. Son
// état d'envoi (pastille, dernier envoi, envois en attente, erreur) est redessiné sur place tant
// qu'un envoi bouge (voir tickFlows).
function personRow(exp, h, ownerOnly, out, { syncCols, note }) {
  const [status] = hookStatus(h);
  const slot = { pill: el('span', {}), lines: el('div', {}), syncCols, status };
  personSlots.set(h.id, slot);
  fillPerson(slot, h);
  return el('li', { class: 'person', 'data-memo': h.fields.memo || '' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who', title: personLabel(h) }, personWho(h)), slot.pill),
    personNotices(exp, h, status, note),
    slot.lines,
    personActions(exp, h, { status, ownerOnly, out, syncCols }));
}

// Les avis d'une personne : adresse refusée, autre document, clé de signature absente, renforcement, pause.
function personNotices(exp, h, status, note) {
  const autoPaused = status === 'paused' ? note.pauses.find(p => p.hook === h.id && p.auto) : null;
  const { other, bad } = hookCheck(h.id);
  return [
    bad ? message('err', t('send.person.badAddress')) : null,
    other ? message('err', t('send.person.otherDoc', { doc: other })) : null,
    // Sans clé de signature : si le renforcement est possible, il est aussi la réparation (un envoi neuf, avec sa clé) ;
    // l'avis d'erreur ne reste que lorsqu'il ne l'est pas (en pause) ou déjà en cours.
    exp.unkeyed.has(h.id) && !renfPossible(exp, h) ? message('err', t('send.person.noKey')) : null,
    reinforceLine(exp, h),
    autoPaused ? message('info', t(autoPaused.why === 'slow' ? 'send.paused.slow' : 'send.paused.auto')) : null,
    status === 'paused' && !autoPaused ? message('info', t('send.paused.manual')) : null,
  ];
}

function personActions(exp, h, { status, ownerOnly, out, syncCols }) {
  const action = (label, iconName, fn, options) => actionButton(label, iconName, fn, ownerOnly, out, options);
  const failing = status === 'error';
  // Vider la file ne règle ni un lien mort, ni un serveur qui n'en peut plus (l'envoi suivant échoue de la même
  // façon) : la pause libère les autres destinataires, ou l'on attend (Grist retente seul).
  const waits = failing && !columnFault(h.usage, syncCols) && NO_UNBLOCK.includes(hookErrorKey(h));
  return el('div', { class: 'person-actions' },
    reinforceable(exp, h) ? smallButton(t('send.renf.action'), 'key', () => run(null, out, () => reinforce(exp, h)), { disabled: ownerOnly }) : null,
    status === 'paused' ? action(t('send.action.resume'), 'play', () => resume(exp, h, out)) : action(t('send.action.pause'), 'pause', () => pause(exp, h)),
    failing && !waits ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
    action(t('send.action.revoke'), 'revoke', () => revoke(exp, h), { kind: 'btn-danger-text' }));
}

function fillPerson(slot, h) {
  const [status, tone] = hookStatus(h);
  const u = h.usage || {};
  const failing = status === 'error';
  slot.status = status;
  slot.pill.replaceChildren(statusPill(status, tone));
  slot.lines.replaceChildren(...[
    u.lastSuccessTime ? el('p', { class: 'muted small' }, t('send.lastOk', { at: dateText(u.lastSuccessTime) })) : null,
    u.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: u.numWaiting })) : null,
    failing ? el('p', { class: 'small text-danger' }, errorText(h, slot.syncCols)) : null,
    failing && u.lastErrorMessage ? el('p', { class: 'muted small' }, t('send.error.detail', { detail: maskKey(`${failureStatus(h) || ''} ${u.lastErrorMessage}`.trim()) })) : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------
// Où en est l'envoi de chaque export : sa phrase (voir exportFlow) est redessinée sur place, avec l'état
// de ses destinataires, tant qu'un envoi bouge ; une page qui change d'état se redessine en entier.
// Une lecture légère toutes les 10 s (ligne 'charge', webhooks), jamais la table Synchro.
const FLOW_MS = 10000;
// Au repos (rien n'est en route), la page relit l'état des destinataires plus rarement : un envoi ordinaire, parti de Grist sans le
// widget, s'y montre alors tout seul (dernier envoi de la fiche et de l'historique, voir last-send.js).
const IDLE_MS = 30000;
const flowSlots = new Map(); // export -> { node, exp, moving }
const personSlots = new Map(); // webhook -> { pill, lines, syncCols, status }
let flowTimer = 0;
let flowDue = 0;
let loading = 0; // envois lancés depuis cette page par « Tout renvoyer »

function flowSlot(exp, charge) {
  const node = el('div', { class: 'flow-slot', 'data-export-flow': exp.id });
  const flow = flowOf(exp, charge);
  const view = flowView(flow);
  if (view) node.append(view);
  flowSlots.set(exp.id, { node, exp, moving: flowMoves(flow) });
  return node;
}

// Relecture suivante dans `ms` : la plus proche l'emporte (un envoi qui bouge ne attend pas la relecture lente du repos).
function watchFlows(ms = FLOW_MS) {
  const due = Date.now() + ms;
  if (flowTimer && flowDue <= due) return;
  clearTimeout(flowTimer);
  flowDue = due;
  flowTimer = setTimeout(tickFlows, ms);
}

// Redessine l'avancement de chaque export affiché ; rend { moving (un envoi est en route), changed (un envoi vient de finir) }.
function refreshFlows(charge, hooks, conditions, moving) {
  let changed = false;
  for (const [id, slot] of flowSlots) {
    if (!slot.node.isConnected) {
      flowSlots.delete(id);
      continue;
    }
    slot.exp = { ...slot.exp, recipients: hooksOf(hooks, conditions, id) };
    const flow = flowOf(slot.exp, charge);
    const view = flowView(flow);
    slot.node.replaceChildren(...(view ? [view] : []));
    // Dernier envoi ordinaire de l'historique : mis à jour sur place ; l'historique n'était pas affiché (aucun envoi ni événement
    // jusque-là) et un envoi vient d'arriver : la carte se redessine.
    const row = slot.node.parentElement && slot.node.parentElement.querySelector('[data-last-send]');
    if (row) fillLast(row, slot.exp.recipients);
    else changed ||= Boolean(lastSend(slot.exp.recipients));
    changed ||= slot.moving && !flowMoves(flow);
    slot.moving = flowMoves(flow);
    moving ||= slot.moving;
  }
  return { moving, changed };
}

// Met à jour la pastille de chaque destinataire affiché ; même rendu que refreshFlows.
function refreshPeople(hooks, state) {
  let { moving, changed } = state;
  for (const h of hooks) {
    const slot = personSlots.get(h.id);
    if (!slot || !slot.pill.isConnected) continue;
    changed ||= hookStatus(h)[0] !== slot.status;
    moving ||= hookBusy(h);
    fillPerson(slot, h);
  }
  return { moving, changed };
}

async function tickFlows() {
  flowTimer = 0;
  if (!container || !container.isConnected) return;
  // Au repos et page cachée : rien à lire, la relecture reprend à son rythme (le rattrapage, lui, a le sien).
  if (document.visibilityState === 'hidden' && !loading && ![...flowSlots.values()].some(slot => slot.moving)) {
    watchFlows(IDLE_MS);
    return;
  }
  let charge;
  let hooks;
  let conditions;
  try {
    let read;
    [charge, read] = await Promise.all([currentCharge(), readHooks()]);
    ({ hooks, conditions } = read);
  } catch (e) {
    watchFlows(loading ? FLOW_MS : IDLE_MS);
    return;
  }
  const { moving, changed } = refreshPeople(hooks, refreshFlows(charge, hooks, conditions, loading > 0));
  const moved = await accessChanged();
  if ((changed || moved) && !document.querySelector('.scrim')) await refreshSource();
  else watchFlows(moving || changed || moved ? FLOW_MS : restMs());
}

// Rythme de relecture au repos : plus rapproché quand la personne est en train de régler le lien public dans Grist.
const restMs = () => (shownAccess.waiting ? FLOW_MS : IDLE_MS);

// Le droit du lien public a-t-il changé depuis le dernier dessin (activé, coupé, passé sur Éditeur dans Partager) ? Relu seulement
// quand l'écran en dépend ; une réponse inconnue (réseau, serveur occupé) ne change rien. Le redessin est périodique : il ne pose
// aucune règle d'accès (voir refreshSource), celles-ci suivent au prochain affichage complet de l'onglet.
async function accessChanged() {
  if (!shownAccess.watch) return false;
  return accessMoved(shownAccess.access, await publicAccess(shownAccess.base));
}

// Invitation en attente. Celle d'un Échange attend d'abord le lien de son formulaire de retour, et
// son code peut être refait (nouveau secret) : il n'est gardé nulle part.
// Une invitation vaut 7 jours : expirée, son code est à refaire.
// Renforcement de la sécurité (voir engine/logic/reinforce.js) : l'invitation en cours d'un destinataire, ses avis et son bouton.
const pendingFor = (exp, h) => exp.invitations.find(inv => inv.replaces === h.id);
const renfPossible = (exp, h) => exp.unsigned.has(h.id) && !exp.echange && !exp.public && Boolean(pendingFor(exp, h) || canReinforce(exp, h));
const reinforceable = (exp, h) => exp.unsigned.has(h.id) && !pendingFor(exp, h) && canReinforce(exp, h);

function reinforceLine(exp, h) {
  if (!exp.unsigned.has(h.id) || pendingFor(exp, h) || exp.echange || exp.public) return null;
  return message('info', t(canReinforce(exp, h) ? 'send.renf.person' : 'send.renf.paused'));
}

function reinforceNotice(exp) {
  if (!exp.unsigned.size || exp.echange || exp.public || exp.retour) return null;
  return noticeBox({ tone: 'info', title: t('send.renf.title.n', { n: exp.unsigned.size }), lines: [t('send.renf.body'), t('send.renf.safe'), t('send.renf.how')], 'data-renf': 'suggest' });
}

function inviteRow(exp, inv, ownerOnly, out) {
  const state = invitationState(inv);
  const back = state === 'link';
  const expired = state === 'expired';
  const until = t(expired ? 'send.invite.expiredOn' : 'send.invite.until', { at: dateText(expiresAt(inv.at) * 1000) });
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' },
      el('span', { class: 'person-who' }, inv.replaces ? t('send.renf.pending', { who: personNameOf(exp, inv), at: dateText(inv.at * 1000) }) : t('send.invite.pending', { at: dateText(inv.at * 1000) })),
      expired ? statusPill(inv.replaces ? 'renfExpired' : 'expired', 'err') : statusPill(inv.replaces ? 'renfWait' : 'invited', 'pending')),
    el('p', { class: 'muted small' }, [back ? t('send.mode.echange') : until, inv.renforce ? t('send.renforce.on') : ''].filter(Boolean).join(' · ')),
    el('div', { class: 'person-actions' },
      wizardButton(back ? t('send.back.resume') : expired ? t('send.newCode.ok') : t('send.reply'), back ? 'link' : expired ? 'key' : 'paste', () => openRecipient(exp, inv), { primary: true, ownerOnly }),
      inv.journal && inv.ready ? wizardButton(t('send.back.again'), 'key', () => openRecipient(exp, { ...inv, ready: false }), { ownerOnly }) : null,
      actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, { kind: 'btn-danger-text' })));
}

function publicRow(exp, open, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, t('send.public.label')), statusPill(open ? 'public' : 'publicOff', open ? 'ok' : 'pending')),
    open ? null : el('p', { class: 'small' }, t('send.public.turnOn')),
    exp.tooBig.length ? message('warn', t('send.public.tooBig', { tables: exp.tooBig.join(', ') })) : null,
    el('div', { class: 'person-actions' },
      actionButton(t('send.public.code'), 'key', () => showPublicCode(exp), ownerOnly, out),
      actionButton(t('send.public.stop'), 'unlink', () => stopPublic(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Lien public coupé ici alors que le partage public de Grist reste ouvert (voir public-stay.js) : avis orange tant que Grist dit le
// document public, jusqu'à ce que la personne le ferme dans Grist ou confirme qu'elle le laisse ainsi (l'avis disparaît alors).
function stayNotice(state, access, out) {
  if (state.ownerOnly || !lingering({ note: state.note, exports: state.exports, access })) return null;
  return noticeBox({
    tone: 'warn', title: t('send.public.stay.title'), lines: [t('send.public.stay.body'), t('send.public.stay.how'), t('send.public.stay.rules')], 'data-public-stay': '',
    actions: [actionButton(t('send.public.stay.keep'), 'check', () => updateSourceNote(clearStay), false, out)],
  });
}

// Carte d'avertissement avec un bouton qui nettoie, après confirmation.
function cleanupCard({ title, body, status, clean, confirm, ownerOnly, out, fn }) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, title), status),
    el('p', { class: 'small' }, body),
    el('div', { class: 'card-actions' }, actionButton(clean, 'trash', async () => {
      if (await confirmDialog({ title, body: confirm, confirmLabel: clean })) await fn();
    }, ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Webhook sur Synchro sans filtre reconnu : il recevrait les lignes de tous les exports.
const unsafeCard = (hooks, ownerOnly, out) => cleanupCard({
  title: t('send.unsafe.title'), status: statusPill('error', 'err'), body: t('send.unsafe.body', { who: hooks.map(h => h.fields.memo || h.fields.name).join(', ') }),
  clean: t('send.unsafe.delete'), confirm: t('send.unsafe.confirm'), ownerOnly, out,
  fn: async () => { for (const h of hooks) await deleteWebhook(h.id); },
});

// ---------------------------------------------------------------------------------------------
// Table Synchro à remettre en état (voir logic/strays.js) : colonnes en trop, ou table de ce nom qui
// n'est pas celle du widget. Chaque cas a sa carte, avec le bouton qui ouvre la fenêtre ; la
// fenêtre s'ouvre aussi d'elle-même, une fois par chargement de la page (« Plus tard » la ferme).

const strayCard = (state, out) => {
  const risky = state.strays.filter(hasContent);
  return el('article', { class: 'card', 'data-stray': '' },
    el('div', { class: 'card-head' }, el('strong', {}, t('send.stray.title')), statusPill('error', 'err')),
    el('p', { class: 'small' }, t('send.stray.body', { n: state.strays.length, list: state.strays.map(s => s.id).join(', '), total: syncColumnIds().size })),
    risky.length ? message('warn', t('send.stray.filled', { cols: risky.map(s => s.id).join(', ') })) : null,
    el('div', { class: 'card-actions' }, actionButton(t('send.stray.open'), 'trash', () => removeStrays(state), false, out, { kind: 'btn-primary' })));
};

// Synchro perdue : ce qui s'est passé, ce qu'on peut faire. Effacée : un nouvel export recrée la table (les anciens
// webhooks, qui ne servent plus, se retirent d'un bouton). Renommée ou illisible : un nouvel export se heurterait à
// la table qui reste, il est refusé tant que ce n'est pas réglé.
// Synchro perdue ? Dit au premier écran (propriétaires seulement : eux seuls lisent les webhooks).
export async function lostSynchro(schema) {
  try {
    return lostSync(schema, await listWebhooks(), await webhookConditions());
  } catch (e) {
    return null;
  }
}
// Personne propriétaire du document ? (Eux seuls lisent les webhooks.) Null : Grist n'a pas répondu, on ne sait pas.
export async function isOwnerHere() {
  try {
    await listWebhooks();
    return true;
  } catch (e) {
    return e.message === 'ownerOnly' ? false : null;
  }
}
const blocksNew = lost => Boolean(lost) && lost.kind !== 'deleted';
function lostCard(lost, out) {
  const vars = { name: lost.name, n: lost.hooks.length };
  const title = t(`send.lost.${lost.kind}.title`, vars);
  const clean = lost.kind !== 'deleted' ? null : actionButton(t('send.lost.deleted.clean'), 'trash', async () => {
    if (!(await confirmDialog({ title, body: t('send.lost.deleted.confirm', vars), confirmLabel: t('send.lost.deleted.clean') }))) return;
    for (const id of lost.hooks) await deleteWebhook(id);
    notice = message('ok', t('send.lost.deleted.done', vars));
  }, false, out, { kind: 'btn-danger-text' });
  return el('article', { class: 'card', 'data-lost': lost.kind },
    el('div', { class: 'card-head' }, el('strong', {}, title), statusPill('error', 'err')),
    el('p', { class: 'small' }, t(`send.lost.${lost.kind}.body`, vars)),
    el('p', { class: 'small' }, t(`send.lost.${lost.kind}.how`, vars)),
    clean ? el('div', { class: 'card-actions' }, clean) : null);
}

const foreignCard = (state, out) => el('article', { class: 'card', 'data-foreign': '' },
  el('div', { class: 'card-head' }, el('strong', {}, t('send.foreign.title')), statusPill('error', 'err')),
  el('p', { class: 'small' }, t('send.foreign.body')),
  el('div', { class: 'card-actions' }, actionButton(t('send.foreign.open'), 'edit', renameForeign, false, out, { kind: 'btn-primary' })));

// Un envoi bloqué par l'une des colonnes : la fenêtre vide ensuite la file de Grist (voir strayDialog).
async function removeStrays(state) {
  const stuck = state.exports.some(exp => exp.recipients.some(h => columnFault(h.usage, state.syncCols) === 'stray'));
  if (await strayDialog(state.strays, { stuck })) notice = message('ok', t('send.stray.done', { n: state.strays.length }));
}

async function renameForeign() {
  if (await foreignDialog()) notice = message('ok', t('send.foreign.done'));
}

const asked = new Set();
function askAboutSync(state) {
  if (state.ownerOnly || document.querySelector('.scrim')) return;
  const [kind, open] = state.foreign ? ['foreign', renameForeign] : state.strays.length ? ['stray', () => removeStrays(state)] : [];
  if (!kind || asked.has(kind)) return;
  asked.add(kind);
  open().then(() => renderSource()).catch((e) => { console.error(e); noteError(e); });
}
