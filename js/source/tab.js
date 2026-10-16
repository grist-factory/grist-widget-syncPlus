// Onglet « Envoyer » (document SOURCE) : une carte par export (un nom, des tables et leurs
// colonnes) avec ses destinataires. Une seule table technique, Synchro ; un webhook par
// destinataire, filtré par Grist sur les lignes de son export.
import { AUTHOR_COL, EXPORT_COL, KIND, LOT_COL, MISSING_COL, RESEND_COL, SYNC_TABLE, TABLE_COL, TYPE_COL } from '../logic/common.js';
import { maskKey } from '../logic/codes.js';
import { PUBLIC_MEMO, conditionExport, exportTables, exportableColumns, hooksOf, isPublicRule, publicAclActions, publicAclRules, ruleText } from '../logic/exports.js';
import { parseLot } from '../logic/journal.js';
import { listDue, parseCharge } from '../logic/resend.js';
import { apply, deleteWebhook, docIdentity, fetchRows, gristFetch, listWebhooks, readSchema, webhookConditions } from '../grist.js';
import { ensureSyncTable, isCharge, legacyTables, readSourceNote, refreshMajLe, removeLegacy } from './synchro.js';
import { catchUp, chargeNotice, hookStatus, resendTables } from './resend.js';
import { cancelInvitation, deleteExport, pause, resume, revoke, showPublicCode, stopPublic, unblockQueue } from './actions.js';
import { exportWizard } from './export-wizard.js';
import { recipientWizard } from './recipient-wizard.js';
import { confirmDialog, el, icon, message, run } from '../ui.js';
import { roleGuide } from '../guide.js';
import { dateText, t } from '../i18n.js';

let container;
let notice = null; // message à montrer au prochain affichage (fin d'un renvoi)
let resumed = false; // l'assistant d'un Échange ne se rouvre seul qu'une fois par chargement

// ---------------------------------------------------------------------------------------------
// État du document : exports (note + lignes Synchro), destinataires (webhooks sur Synchro, rangés
// par l'export que nomme leur condition), invitations en attente.

async function loadState() {
  let hooks = [];
  let ownerOnly = false;
  try { hooks = await listWebhooks(); } catch (e) { if (e.message !== 'ownerOnly') throw e; ownerOnly = true; }
  const conditions = ownerOnly ? new Map() : await webhookConditions();
  const schema = await readSchema();
  const all = schema.has(SYNC_TABLE) ? await fetchRows(SYNC_TABLE) : [];
  const rows = all.filter(r => !isCharge(r));
  const note = readSourceNote(schema);
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])];
  const exports = ids.map(id => exportState(id, { note, rows, schema, recipients: hooksOf(hooks, conditions, id) }));
  const legacy = legacyTables(schema);
  // Webhooks de l'ancien montage : sur ses tables, ou vers un journal par une clé de formulaire.
  // Les autres webhooks du document (autres outils) ne sont pas à lui.
  const legacyHooks = hooks.filter(h => h.fields.tableId !== SYNC_TABLE && (legacy.includes(h.fields.tableId) || /\/api\/s\/[^/]+\/tables\/[^/]+\/records\?flat=1$/.test(h.fields.url || '')));
  const unsafe = hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id)));
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  return { ownerOnly, schema, note, exports, unsafe, charge, legacy: { tables: legacy, hooks: legacyHooks } };
}

function exportState(id, { note, rows, schema, recipients }) {
  const mine = rows.filter(r => r[EXPORT_COL] === id);
  const tables = exportTables(rows, id);
  return {
    ...(note.exports.find(e => e.id === id) || { id, name: id }), tables, recipients, invitations: note.invitations.filter(i => i.export === id),
    email: (mine[0] || {})[AUTHOR_COL] || '',
    partial: recipients.some(h => h.fields.enabled) && mine.some(r => (r[TYPE_COL] === KIND.lot && r[MISSING_COL] > 0) || listDue(r)),
    // Lien public : tables dont l'instantané dépasse la taille permise (il reste vide).
    tooBig: mine.filter(r => r[TYPE_COL] === KIND.full && (parseLot(r[LOT_COL]) || {}).tooBig).map(r => r[TABLE_COL]),
    ...drift(schema, tables),
  };
}

// Ce que la SOURCE a changé depuis l'enregistrement de l'export : tables introuvables (renommées
// ou effacées : leurs lignes ne partent plus) et colonnes renommées, effacées ou d'un autre type
// (elles partiraient vides ou fausses). « Modifier » remet l'export d'accord avec les tables.
function drift(schema, tables) {
  const lost = tables.filter(tb => !schema.has(tb.table)).map(tb => tb.table);
  const changed = tables.filter(tb => schema.has(tb.table)).flatMap(({ table, columns }) => {
    const current = new Map(exportableColumns(schema.columns(table)).map(c => [c.id, c]));
    return columns.filter((c) => {
      const cur = current.get(c.id);
      return !cur || cur.source !== (c.source || c.type) || (cur.visible || '') !== (c.visible || '');
    }).map(c => `${table}.${c.id}`);
  });
  return { lost, changed };
}

// Lien public : le document est-il lisible sans identifiant ? (requête anonyme) Vrai, faux, ou
// null quand la réponse ne permet pas de le dire (réseau, serveur occupé) : rien ne change alors.
async function isPublic(base) {
  try {
    const response = await gristFetch(base);
    if (response.ok) return true;
    return [401, 403, 404].includes(response.status) ? false : null;
  } catch (e) {
    return null;
  }
}

// Règles d'accès du lien public, accordées aux exports partagés : réécrites seulement si elles
// diffèrent (changer une règle fait recharger le document, et donc le widget). Le refus général
// posé par le widget reste tant que le document est public ; le widget n'en pose jamais un sur un
// document qu'il n'a pas partagé lui-même (un document public sans export public reste lisible).
async function syncPublicRules(exportIds, open) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const mine = rules.filter(isPublicRule);
  const keepDeny = open && mine.length > 0;
  const resource = id => resources.find(r => r.id === id) || {};
  const have = mine.map(r => ruleText({ ...resource(r.resource), ...r }) + r.memo).sort().join('\n');
  const want = publicAclRules(exportIds, { keepDeny }).map(r => ruleText(r) + PUBLIC_MEMO).sort().join('\n');
  if (have !== want) await apply(publicAclActions(resources, rules, exportIds, { keepDeny }));
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord

// Redessine l'onglet s'il est affiché et qu'aucune fenêtre n'est ouverte (rattrapage terminé).
export async function refreshSource() {
  if (container && container.isConnected && !document.querySelector('.scrim')) await renderSource();
}

export async function renderSource(root = container) {
  container = root;
  let state = await loadState();
  // Mise à niveau silencieuse du montage (colonnes de Synchro, dépendances de MajLe), puis
  // rattrapage d'un envoi coupé.
  if (!state.ownerOnly && state.schema.has(SYNC_TABLE)) {
    const upgraded = await ensureSyncTable();
    const majle = await refreshMajLe();
    if (upgraded || majle) state = await loadState();
    catchUp(refreshSource);
  }
  // Document lisible par lien public ? Vérifié à chaque affichage : tant qu'il l'est, le refus
  // général posé par le widget reste en place, même sans export public.
  const open = await isPublic((await docIdentity()).baseUrl);
  if (!state.ownerOnly && open !== null) await syncPublicRules(state.exports.filter(e => e.public).map(e => e.id), open);
  const out = el('div', { class: 'out' }, notice);
  notice = null;
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.ownerOnly, onclick: () => exportWizard(null, renderSource) }, icon('plus'), t('send.new')));
  const cards = state.exports.map(exp => exportCard(exp, state, open, out));
  if (state.unsafe.length) cards.unshift(unsafeCard(state.unsafe, state.ownerOnly, out));
  if (state.legacy.tables.length) cards.push(legacyCard(state, out));
  container.replaceChildren(...[toolbar,
    state.ownerOnly ? message('warn', t('common.ownerOnly')) : null,
    chargeNotice(state.charge),
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, t('send.empty')),
    roleGuide({ you: 'source' })].filter(Boolean));
  // Échange qui attend le lien de son formulaire de retour (page fermée en route) : l'assistant
  // reprend à cette étape, une fois par chargement.
  const pending = state.exports.flatMap(exp => exp.invitations.filter(inv => inv.journal && !inv.ready).map(inv => [exp, inv]))[0];
  if (pending && !resumed && !state.ownerOnly && !document.querySelector('.scrim')) openRecipient(...pending);
}

const openRecipient = (exp, pending = null) => {
  resumed = true;
  recipientWizard(exp, pending, renderSource);
};

// Bouton d'une carte : grisé pour qui n'est pas propriétaire, ou avec la raison (`reason`).
// L'action finie, l'onglet est redessiné.
function actionButton(label, iconName, fn, ownerOnly, out, { kind = '', reason = '' } = {}) {
  return el('button', {
    class: `btn btn-small ${kind}`, type: 'button', disabled: ownerOnly || Boolean(reason), title: reason || null,
    onclick: e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }),
  }, icon(iconName), label);
}

// Bouton qui ouvre un assistant.
const wizardButton = (label, iconName, onclick, { primary = false, ownerOnly = false, reason = '' } = {}) => el('button', {
  class: `btn btn-small ${primary ? 'btn-primary' : ''}`, type: 'button', disabled: ownerOnly || Boolean(reason), title: reason || null, onclick,
}, icon(iconName), label);

const pill = (key, tone, vars) => el('span', { class: `pill pill-${tone}` }, t(`send.status.${key}`, vars));

// Erreur d'envoi d'un destinataire, dite simplement, et ce qu'il faut faire.
function hookError(u) {
  const status = u.lastHttpStatus || (u.lastEventBatch || {}).httpStatus;
  if (status === 413) return t('send.error.size');
  if (/Invalid column/i.test(u.lastErrorMessage || '')) return t('send.error.column');
  return t([401, 403, 404].includes(status) ? 'send.error.link' : 'send.error.other');
}

function exportStatus(exp) {
  if (exp.recipients.some(h => hookStatus(h)[0] === 'error')) return ['error', 'err'];
  if (exp.recipients.length || exp.public) return ['people', 'ok'];
  return exp.invitations.length ? ['invited', 'pending'] : ['alone', 'off'];
}

// Avis d'un export : tables perdues, colonnes changées, envoi incomplet, Échange.
const exportNotes = exp => [
  exp.lost.length ? message('warn', t('send.export.lost', { tables: exp.lost.join(', ') })) : null,
  exp.changed.length ? message('warn', t('send.export.drift', { cols: exp.changed.join(', ') })) : null,
  exp.partial ? message('info', t('send.export.partial')) : null,
  exp.retour ? message('info', t('send.exchange.managed')) : null,
  exp.echange && !exp.retour ? el('p', { class: 'muted small' }, t('send.exchange.with')) : null,
];

const tablesLine = exp => exp.tables.map(tb => t(tb.filter ? 'send.export.tableFiltered' : 'send.export.table',
  { table: tb.table, n: tb.columns.length, ...(tb.filter ? { col: tb.filter.id, value: tb.filter.value } : {}) })).join(' · ') || '—';

function exportCard(exp, state, open, out) {
  const { ownerOnly } = state;
  const n = exp.recipients.length;
  const [status, tone] = exportStatus(exp);
  const rows = [
    ...exp.recipients.map(h => personRow(exp, h, ownerOnly, out)),
    ...exp.invitations.map(inv => inviteRow(exp, inv, ownerOnly, out)),
    exp.public ? publicRow(exp, open, ownerOnly, out) : null,
  ].filter(Boolean);
  const load = async () => {
    const total = await resendTables(exp.id, exp.tables.map(tb => tb.table), out);
    notice = total === null ? message('info', t('send.load.queued')) : message('ok', t('send.load.done', { n: total }));
  };
  // Échange : un seul destinataire ; l'export de retour (reçu d'un autre document) se règle depuis
  // l'onglet Recevoir.
  const single = exp.echange || exp.invitations.some(inv => inv.journal) ? t('send.exchange.single') : '';
  return el('article', { class: 'card', 'data-export': exp.id },
    el('div', { class: 'card-head' }, el('strong', {}, exp.name), pill(status, tone, { n: n + (exp.public ? 1 : 0) })),
    el('p', { class: 'muted small' }, tablesLine(exp)),
    exportNotes(exp),
    rows.length ? el('ul', { class: 'people' }, rows) : el('p', { class: 'small' }, t('send.export.nobody')),
    el('div', { class: 'card-actions' },
      exp.retour ? null : wizardButton(t('send.action.addPerson'), 'plus', () => openRecipient(exp), { primary: true, ownerOnly, reason: single }),
      exp.retour ? null : wizardButton(t('send.action.edit'), 'edit', () => exportWizard(exp, renderSource), { ownerOnly }),
      actionButton(t('send.action.load'), 'send', load, ownerOnly, out, { reason: n ? '' : t('send.load.nobody') }),
      actionButton(t('send.action.delete'), 'trash', () => deleteExport(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Un destinataire : sa fiche (mémo du webhook), son état, et ce qu'on peut faire pour lui seul.
function personRow(exp, h, ownerOnly, out) {
  const [status, tone] = hookStatus(h);
  const u = h.usage || {};
  const action = (label, iconName, fn, options) => actionButton(label, iconName, fn, ownerOnly, out, options);
  const failing = status === 'error';
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, h.fields.memo || '—'), pill(status, tone)),
    u.lastSuccessTime ? el('p', { class: 'muted small' }, t('send.lastOk', { at: dateText(u.lastSuccessTime) })) : null,
    u.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: u.numWaiting })) : null,
    failing ? el('p', { class: 'small text-danger' }, hookError(u)) : null,
    failing && u.lastErrorMessage ? el('p', { class: 'muted small' }, t('send.error.detail', { detail: maskKey(`${u.lastHttpStatus || ''} ${u.lastErrorMessage}`) })) : null,
    el('div', { class: 'person-actions' },
      status === 'paused' ? action(t('send.action.resume'), 'play', () => resume(exp, h, out)) : action(t('send.action.pause'), 'pause', () => pause(exp, h)),
      failing ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
      action(t('send.action.revoke'), 'revoke', () => revoke(exp, h), { kind: 'btn-danger-text' })));
}

// Invitation en attente. Celle d'un Échange attend d'abord le lien de son formulaire de retour, et
// son code peut être refait (nouveau secret) : il n'est gardé nulle part.
function inviteRow(exp, inv, ownerOnly, out) {
  const back = inv.journal && !inv.ready;
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' },
      el('span', { class: 'person-who' }, t('send.invite.pending', { at: dateText(inv.at * 1000) })), pill('invited', 'pending')),
    el('p', { class: 'muted small' }, back ? t('send.mode.echange') : inv.hash ? t('send.secret.on') : t('send.secret.off')),
    el('div', { class: 'person-actions' },
      wizardButton(back ? t('send.back.resume') : t('send.reply'), back ? 'link' : 'paste', () => openRecipient(exp, inv), { primary: true, ownerOnly }),
      inv.journal && inv.ready ? wizardButton(t('send.back.again'), 'key', () => openRecipient(exp, { ...inv, ready: false }), { ownerOnly }) : null,
      actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, { kind: 'btn-danger-text' })));
}

function publicRow(exp, open, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, t('send.public.label')), pill(open ? 'public' : 'publicOff', open ? 'ok' : 'pending')),
    open ? null : el('p', { class: 'small' }, t('send.public.turnOn')),
    exp.tooBig.length ? message('warn', t('send.public.tooBig', { tables: exp.tooBig.join(', ') })) : null,
    el('div', { class: 'person-actions' },
      actionButton(t('send.public.code'), 'key', () => showPublicCode(exp), ownerOnly, out),
      actionButton(t('send.public.stop'), 'unlink', () => stopPublic(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
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
  title: t('send.unsafe.title'), status: pill('error', 'err'), body: t('send.unsafe.body', { who: hooks.map(h => h.fields.memo || h.fields.name).join(', ') }),
  clean: t('send.unsafe.delete'), confirm: t('send.unsafe.confirm'), ownerOnly, out,
  fn: async () => { for (const h of hooks) await deleteWebhook(h.id); },
});

// Montage d'avant la version 0.4 : à refaire avec un export ; le bouton efface l'ancien.
const legacyCard = (state, out) => cleanupCard({
  title: t('send.legacy.title'), status: pill('legacy', 'pending'), body: t('send.legacy.body', { tables: state.legacy.tables.join(', ') }),
  clean: t('send.legacy.clean'), confirm: t('send.legacy.confirm'), ownerOnly: state.ownerOnly, out,
  fn: async () => {
    for (const h of state.legacy.hooks) await deleteWebhook(h.id);
    await removeLegacy(await readSchema());
  },
});
