// SOURCE : assistant d'ajout d'un destinataire, en quatre étapes (Options, Invitation, Réponse,
// Envoi ; Options et Invitation seulement pour le lien public). Une invitation en attente le
// rouvre à l'étape Réponse (`pending`), ou à l'étape Invitation pour un Échange qui attend le lien
// de son formulaire de retour.
import { AUTHOR_COL, EXPORT_COL, JOURNAL_PREFIX, SYNC_TABLE, freeTableId, randomHex, sha256, toTableId } from '../logic/common.js';
import { buildInvitation, buildWebhookUrl, loopingTables, maskKey, parseFormLink, parseReply } from '../logic/codes.js';
import { exportCondition, hookName } from '../logic/exports.js';
import { createWebhook, docIdentity, fetchRows, readSchema } from '../grist.js';
import { ensureForm, removeTechnicalTables } from '../pages.js';
import { formWhere, linkFigures, testUrl } from '../form-link.js';
import { addDeleteColumns } from '../exchange.js';
import { saveExport, syncRows, updateSourceNote } from './synchro.js';
import { createJournal, receivedDests, updateJournalNote } from '../target/journals.js';
import { resendTables } from './resend.js';
import { handoff, publicCode } from './actions.js';
import { confirmDialog, copyField, el, message, openWizard, run } from '../ui.js';
import { roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { t } from '../i18n.js';

const STEP = { options: 0, invitation: 1, reply: 2, load: 3 };
const now = () => Date.now() / 1000;
const later = { label: t('common.later') };
const back = onClick => ({ label: t('common.back'), back: true, onClick });
const closeButton = () => [{ label: t('common.close'), kind: 'btn-primary' }];

// `onClose` : appelé à la fermeture (l'onglet se redessine).
export function recipientWizard(exp, pending, onClose) {
  const steps = ['send.step.options', 'send.step.invitation', 'send.step.reply', 'send.step.load'].map(k => t(k));
  const ctx = { exp, steps, onClose, codes: new Map(), wizard: openWizard({ title: t('send.person.title', { name: exp.name }), steps, onClose }) };
  if (!pending) return showOptions(ctx);
  return pending.journal && !pending.ready ? showBack(ctx, pending) : showReply(ctx, pending);
}

// 1. Mode (réponse, lien public ou Échange) et secret (sans objet pour le lien public : grisé).
// L'Échange suppose un export sans autre destinataire.
function showOptions(ctx) {
  const { exp } = ctx;
  const secretBox = el('input', { type: 'checkbox', checked: true });
  const secretPart = el('div', { class: 'form' }, el('label', { class: 'check' }, secretBox, t('send.secret')), el('p', { class: 'muted small' }, t('send.secret.help')));
  const parts = { public: el('div', { class: 'hidden' }, message('warn', t('send.public.warn'))), echange: el('div', { class: 'hidden' }, message('info', t('send.mode.echange.help'))) };
  const radio = (value, label, checked, disabled) => el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-mode', value, checked, disabled, onchange: () => {
      secretBox.disabled = value === 'public';
      for (const [key, part] of Object.entries(parts)) part.classList.toggle('hidden', value !== key);
    } }), label);
  const report = el('div', { class: 'report' });
  const mode = () => (document.querySelector('input[name="gristsync-mode"]:checked') || {}).value;
  const exchangeOk = !exp.recipients.length && !exp.invitations.length && !exp.public;
  // Le parcours principal d'abord (un seul sens, avec secret) ; les autres modes, plus discrets.
  ctx.wizard.show(STEP.options, [
    el('p', { class: 'muted small' }, t('send.person.tables', { tables: exp.tables.map(tb => tb.table).join(', ') })),
    el('p', { class: 'field-title', id: 'gristsync-mode-title' }, t('send.mode')),
    el('div', { class: 'form', role: 'radiogroup', 'aria-labelledby': 'gristsync-mode-title' },
      radio('reponse', t('send.mode.reply'), true, false),
      el('p', { class: 'muted small' }, t('send.mode.others')),
      radio('echange', exchangeOk ? t('send.mode.echange') : t('send.mode.echange.off'), false, !exchangeOk),
      radio('public', exp.public ? t('send.mode.publicDone') : t('send.mode.public'), false, exp.public)),
    secretPart, parts.public, parts.echange, report, stepHelp(['s-options', 'public']), roleGuide({ you: 'source', current: 0 }),
  ], [{ label: t('common.cancel') }, { label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, () => invite(ctx, mode() !== 'public' && secretBox.checked, mode())) }]);
}

// 2. Invitation : le code à transmettre ; elle attend sa réponse sur la carte de l'export.
async function invite(ctx, withSecret, mode) {
  if (mode === 'echange') return openBack(ctx, withSecret);
  if (mode === 'public') return invitePublic(ctx);
  const secret = withSecret ? randomHex(16) : '';
  const entry = { id: randomHex(8), export: ctx.exp.id, hash: secret ? await sha256(secret) : '', at: now() };
  await updateSourceNote((note) => { note.invitations = [...note.invitations, entry]; });
  return showInvitation(ctx, entry, secret);
}

// Lien public : l'export devient lisible par ses instantanés. Les règles d'accès sont posées à la
// fermeture (le document se recharge alors).
async function invitePublic({ exp, wizard, steps }) {
  await updateSourceNote((note) => { note.exports = note.exports.map(e => (e.id === exp.id ? { ...e, public: true } : e)); });
  await saveExport(exp.id, exp.tables, { isPublic: true });
  const code = await publicCode(exp);
  wizard.setSteps(steps.slice(0, 2));
  wizard.show(STEP.invitation, [el('p', {}, t('send.public.help')), copyField(code), handoff('public', code),
    message('warn', t('send.public.turnOn')), roleGuide({ you: 'source', mode: 'public', current: 1 }), stepHelp(['public'])], closeButton());
}

async function showInvitation(ctx, entry, secret, retour = '') {
  const { exp } = ctx;
  const mode = retour ? 'echange' : 'reponse';
  const [{ origin, docId }, rows] = await Promise.all([docIdentity(), syncRows()]);
  const email = (rows.find(r => r[EXPORT_COL] === exp.id) || {})[AUTHOR_COL] || '';
  const code = buildInvitation({ id: entry.id, exportId: exp.id, name: exp.name, origin, secret, from: { email, docId }, tables: exp.tables, retour });
  ctx.codes.set(entry.id, { secret, retour });
  const report = el('div', { class: 'report' });
  ctx.wizard.show(STEP.invitation, [el('p', {}, t('send.invite.help')), copyField(code), handoff(mode, code), report,
    roleGuide({ you: 'source', mode, current: 1 }), stepHelp(['s-invite', 't-code', 't-dest', 't-link', 't-reply'])],
  [back(() => run(null, report, () => backToOptions(ctx, entry))), later, { label: t('send.reply.ready'), kind: 'btn-primary', onClick: () => showReply(ctx, entry) }]);
}

// Retour aux options : l'invitation est annulée (son code ne sert plus), avec le journal de retour
// d'un Échange ; la personne en crée une autre.
async function backToOptions(ctx, inv) {
  if (!(await confirmDialog({ title: t('send.backOptions.title'), body: t('send.backOptions.body'), confirmLabel: t('common.back') }))) return;
  await updateSourceNote((note) => { note.invitations = note.invitations.filter(i => i.id !== inv.id); });
  if (inv.journal) await removeTechnicalTables([inv.journal]);
  showOptions(ctx);
}

// Retour à l'invitation depuis l'étape Réponse : le même code s'il a été fait dans cette fenêtre ;
// sinon il est refait (ni le code ni son secret ne sont gardés), et un nouveau secret rend l'ancien
// code inutile : la personne le confirme. Un Échange le refait par son lien de retour.
async function backToInvitation(ctx, inv) {
  const kept = ctx.codes.get(inv.id);
  if (kept) return showInvitation(ctx, inv, kept.secret, kept.retour);
  if (inv.hash && !(await confirmDialog({ title: t('send.newCode.title'), body: t('send.newCode.body'), confirmLabel: t('send.newCode.ok') }))) return null;
  if (inv.journal) return showBack(ctx, inv);
  const secret = inv.hash ? randomHex(16) : '';
  const entry = { ...inv, hash: secret ? await sha256(secret) : '' };
  await updateSourceNote((note) => { note.invitations = note.invitations.map(i => (i.id === inv.id ? entry : i)); });
  return showInvitation(ctx, entry, secret);
}

// 2 bis. Échange : un journal de retour, que la CIBLE remplira par le formulaire publié ici, sur
// sa propre page. Le secret est tiré quand le code est fait, et le code n'est gardé nulle part :
// il peut être refait.
async function openBack(ctx, withSecret) {
  const { exp } = ctx;
  const journal = freeTableId(JOURNAL_PREFIX + toTableId(exp.name, 'Export'), (await readSchema()).tableIds);
  const entry = { id: randomHex(8), export: exp.id, hash: '', at: now(), journal, withSecret };
  await createJournal(journal, { id: entry.id, export: exp.id, name: exp.name, secret: '', from: {}, mode: 'echange', retour: true, tables: [], refused: [], missing: {} });
  await updateSourceNote((note) => { note.invitations = [...note.invitations, entry]; });
  return showBack(ctx, entry);
}

async function showBack(ctx, inv) {
  await ensureForm(inv.journal);
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('send.back.title') });
  const report = el('div', { class: 'report' });
  const check = async () => {
    if (!parseFormLink(input.value)) throw new Error('formLink');
    const retour = buildWebhookUrl(input.value, inv.journal);
    await testUrl(retour, inv.journal);
    const secret = inv.withSecret ? randomHex(16) : '';
    const entry = { ...inv, hash: secret ? await sha256(secret) : '', ready: true };
    await updateSourceNote((note) => { note.invitations = note.invitations.map(i => (i.id === inv.id ? entry : i)); });
    await showInvitation(ctx, entry, secret, retour);
  };
  ctx.wizard.show(STEP.invitation, [el('p', {}, t('send.back.help', { where: await formWhere(inv.journal) })), ...linkFigures(), input, report,
    roleGuide({ you: 'source', mode: 'echange', current: 0 })],
  [back(() => run(null, report, () => backToOptions(ctx, inv))), later, { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
}

// 3. Réponse : vérifier, montrer la fiche, approuver. La réponse doit désigner cette invitation
// et porter le même secret (comparé par empreinte).
function showReply(ctx, inv) {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('send.reply.title') });
  const report = el('div', { class: 'report' });
  const body = [el('p', {}, t('send.reply.help')), area, report, stepHelp(['s-reply', 's-load']), roleGuide({ you: 'source', current: 3 })];
  const check = async () => {
    const reply = await checkReply(ctx.exp, inv, area.value);
    report.replaceChildren(...replyFiche(reply, (await docIdentity()).docId));
    ctx.wizard.show(STEP.reply, body, [toInvitation, later, { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, () => approve(ctx, inv, reply)) }]);
  };
  const toInvitation = back(() => run(null, report, () => backToInvitation(ctx, inv)));
  ctx.wizard.show(STEP.reply, body, [toInvitation, later, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
}

// Réponse lue et contrôlée : même instance, cette invitation, même secret, pas de boucle ; un
// Échange dit où la CIBLE a rangé chaque table de l'export.
async function checkReply(exp, inv, text) {
  const reply = parseReply(text, (await docIdentity()).origin);
  if (reply.id !== inv.id || inv.hash !== (reply.secret ? await sha256(reply.secret) : '')) throw new Error('unknownInvitation');
  if (loopingTables(exp.tables.map(tb => tb.table), reply.recipient.docId, receivedDests(await readSchema())).length) throw new Error('loop');
  if (Boolean(inv.journal) !== Boolean(reply.retour) || (reply.retour || []).some(b => !exp.tables.some(tb => tb.table === b.dest))) throw new Error('codeInvalid');
  return { ...reply, tables: reply.retour ? reply.retour.map(b => t('send.exchange.map', b)).join(', ') : exp.tables.map(tb => tb.table).join(', ') };
}

// Fiche de la personne qui répond, à vérifier avant d'approuver.
function replyFiche(reply, docId) {
  const r = reply.recipient;
  const fiche = [[t('send.reply.tables'), reply.tables], [t('send.reply.email'), r.email],
    [t('send.reply.doc'), r.docId === docId ? `${r.docId} · ${t('send.reply.sameDoc')}` : r.docId], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
  return [el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
    reply.secret ? null : message('warn', t('send.reply.nosecret')),
    el('p', { class: 'muted small' }, maskKey(reply.url))].filter(Boolean);
}

// Un webhook sur Synchro, filtré sur l'export, vers le journal de la CIBLE. Échange : l'export
// reçoit sa ligne 'echange', et le journal de retour sait d'où viennent ses tables : il commence
// à recopier.
async function approve(ctx, inv, reply) {
  const { exp } = ctx;
  const r = reply.recipient;
  await createWebhook({
    name: hookName(exp.name, exp.id), memo: [r.email, r.docId, r.team].filter(Boolean).join(' · '), url: reply.url,
    tableId: SYNC_TABLE, condition: exportCondition(exp.id),
  });
  if (inv.journal) {
    await addDeleteColumns(exp.tables.map(tb => tb.table));
    await saveExport(exp.id, exp.tables, { swap: true });
    await updateJournalNote(inv.journal, n => ({
      ...n, from: { email: r.email, docId: r.docId }, tables: reply.retour.map(b => ({ table: b.table, dest: b.dest, columns: [] })),
    }));
  }
  await updateSourceNote((note) => {
    note.invitations = note.invitations.filter(i => i.id !== inv.id);
    if (inv.journal) note.exports = note.exports.map(e => (e.id === exp.id ? { ...e, echange: true } : e));
  });
  await showLoad(ctx);
}

// 4. Envoi : le branchement n'envoie que les modifications à venir ; proposer l'existant. La
// fenêtre se ferme pendant l'envoi, qui continue (voir resendTables) : l'onglet se redessine à la fin.
async function showLoad({ exp, wizard, onClose }) {
  let total = 0;
  for (const { table } of exp.tables) total += (await fetchRows(table)).length;
  const report = el('div', { class: 'report' });
  if (!total) {
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.empty'))], closeButton());
    return;
  }
  const send = async () => {
    wizard.show(STEP.load, [message('ok', t('send.connected')), report, el('p', { class: 'muted small' }, t('send.load.background'))], closeButton());
    report.replaceChildren(message('info', t('send.load.progress', { done: 0, total })));
    const n = await resendTables(exp.id, exp.tables.map(tb => tb.table), report);
    if (!report.isConnected) return onClose && onClose();
    return wizard.show(STEP.load + 1, n === null ? message('info', t('send.load.queued')) : message('ok', t('send.done')), closeButton());
  };
  wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.body', { n: total })), report],
    [later, { label: t('send.load.ok'), kind: 'btn-primary', onClick: () => run(null, report, send) }]);
}
