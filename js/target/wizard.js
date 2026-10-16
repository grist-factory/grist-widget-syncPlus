// CIBLE : assistant de réception, en quatre étapes (Code, Destinations, Lien, Réponse). Une
// réception en attente (ou à rebrancher) l'ouvre directement à l'étape Lien (`group`).
import { APPLIED_COL, AUTHOR_COL, JOURNAL_PREFIX, LIST_COL, freeTableId, toTableId } from '../logic/common.js';
import { buildReply, buildWebhookUrl, parseFormLink, parseInvitation } from '../logic/codes.js';
import { apply, docIdentity, fetchRows, isOwner, readSchema } from '../grist.js';
import { ensureForm, removeTechnicalTables } from '../pages.js';
import { formWhere, linkFigures, testUrl } from '../form-link.js';
import { wireExchange } from '../exchange.js';
import { createJournal, prepareDest, receivedJournals, updateJournalNote } from './journals.js';
import { consolidateAll } from './loop.js';
import { checkDests, destField, mappingBlock } from './dest.js';
import { confirmDialog, copyButton, copyField, el, message, openWizard, run } from '../ui.js';
import { handoffText, roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { t } from '../i18n.js';

const STEP = { code: 0, dest: 1, link: 2, reply: 3 };
const cancel = { label: t('common.cancel') };
const back = onClick => ({ label: t('common.back'), back: true, onClick });
const flowOf = note => (note.mode === 'echange' ? 'echange' : 'reponse');

// `onClose` : appelé à la fermeture (l'onglet se redessine).
export function receiveWizard(group, onClose) {
  const steps = ['recv.step.code', 'recv.step.dest', 'recv.step.link', 'recv.step.reply'].map(k => t(k));
  const ctx = { steps, onClose, wizard: openWizard({ title: t('recv.new'), steps, onClose }) };
  return group ? showLink(ctx, group) : showCode(ctx);
}

// 1. Code d'invitation.
function showCode(ctx) {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('recv.invite.title') });
  const report = el('div', { class: 'report' });
  const next = async () => {
    const invitation = await readInvitation(area.value);
    const known = receivedJournals(await readSchema()).find(r => r.note.export === invitation.export);
    return known ? showRelink(ctx, known, invitation) : showDest(ctx, invitation);
  };
  ctx.wizard.show(STEP.code, [el('p', {}, t('recv.invite.help')), area, report, stepHelp(['t-code']), roleGuide({ you: 'target', current: 1 })],
    [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// Invitation lue et contrôlée : même instance que ce document ; un Échange suppose un propriétaire
// (ce document enverra aussi, par un webhook).
async function readInvitation(text) {
  const invitation = parseInvitation(text);
  const { origin } = await docIdentity();
  if (invitation.mode === 'public' && new URL(invitation.base).origin !== origin) throw new Error('otherInstance');
  if (invitation.mode === 'echange' && invitation.retourOrigin !== origin) throw new Error('otherInstance');
  if (invitation.mode === 'echange' && !(await isOwner())) throw new Error('exchangeOwner');
  return invitation;
}

// Nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) : la même
// réception reprend, avec son journal et ses tables, si l'invitation vient du même document, dans
// le même mode. La fiche est montrée avant : la personne confirme que c'est bien la même SOURCE.
// Un Échange rebranche son retour sur la nouvelle adresse.
function showRelink(ctx, known, invitation) {
  const same = invitation.mode !== 'public' && invitation.mode === (known.note.mode || 'reponse') && !known.note.retour
    && (known.note.from || {}).docId === invitation.from.docId;
  if (!same) throw new Error('alreadyReceived');
  const report = el('div', { class: 'report' });
  const relink = async () => {
    const { id, secret, name, from } = invitation;
    await updateJournalNote(known.journal, n => ({ ...n, id, secret, name, from }));
    const note = receivedJournals(await readSchema()).find(r => r.journal === known.journal).note;
    if (invitation.mode === 'echange') await wireExchange(note, invitation.retour);
    await ensureForm(known.journal);
    return showLink(ctx, { journal: known.journal, note }, message('info', t('recv.relink')));
  };
  ctx.wizard.show(STEP.dest, [message('info', t('recv.relink.confirm', { name: known.note.name, journal: known.journal })), sourceFiche(invitation), report],
    [back(() => showCode(ctx)), cancel, { label: t('recv.relink.ok'), kind: 'btn-primary', onClick: () => run(null, report, relink) }]);
}

// D'où vient une invitation : export, tables, personne et document qui l'ont faite.
function sourceFiche(invitation) {
  const { from } = invitation;
  return el('div', {},
    message('info', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })),
    from.email ? el('p', { class: 'small' }, t(from.docId ? 'recv.fromDoc' : 'recv.from', { from: from.email, doc: from.docId })) : null);
}

// 2. Destinations : une par table reçue.
async function showDest(ctx, invitation) {
  const schema = await readSchema();
  const rows = invitation.tables.map(tb => ({ tb, pick: destField(schema, tb.table) }));
  const report = el('div', { class: 'report' });
  const next = async () => {
    const current = await readSchema();
    const plans = rows.map(({ tb, pick }) => ({ tb, dest: pick.dest() }));
    await checkDests(current, plans.map(p => ({ table: p.tb.table, dest: p.dest })), invitation.from.docId);
    if (plans.some(p => current.has(p.dest))) return showColumns(ctx, invitation, plans, current);
    return create(ctx, invitation, plans);
  };
  ctx.wizard.show(STEP.dest, [
    sourceFiche(invitation),
    el('p', {}, t('recv.dest')),
    el('div', { class: 'dest-grid' }, el('span', { class: 'dest-head' }, t('recv.dest.from')), el('span', { class: 'dest-head' }, t('recv.dest.to')),
      ...rows.flatMap(r => [el('span', { class: 'dest-from' }, r.tb.table), r.pick.node])),
    invitation.mode === 'echange' ? message('info', t('recv.consent.echange')) : null,
    el('p', { class: 'muted small' }, t(invitation.mode === 'public' ? 'recv.consent.public' : 'recv.consent')),
    report, stepHelp(['t-dest']), roleGuide({ you: 'target', mode: invitation.mode, current: 1 }),
  ], [back(() => showCode(ctx)), cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// 2 bis. Tables existantes : correspondance des colonnes et rattachement.
function showColumns(ctx, invitation, plans, schema) {
  const report = el('div', { class: 'report' });
  const blocks = plans.filter(p => schema.has(p.dest)).map(p => ({ p, block: mappingBlock(schema, p.tb.table, p.dest, p.tb.columns) }));
  const next = () => {
    for (const { p, block } of blocks) Object.assign(p, block.read());
    return create(ctx, invitation, plans);
  };
  ctx.wizard.show(STEP.dest, [el('p', {}, t('recv.existing')), ...blocks.map(b => b.block.node), report, stepHelp(['t-dest'])], [
    back(() => showDest(ctx, invitation)),
    { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, next) },
  ]);
}

// Un journal pour l'export, nommé d'après lui, et une destination par table. Échange : l'envoi de
// retour est branché aussitôt ; l'adresse de retour, un droit d'écriture, n'est notée nulle part.
async function create(ctx, invitation, plans) {
  const journal = freeTableId(JOURNAL_PREFIX + toTableId(invitation.name, 'Export'), (await readSchema()).tableIds);
  const { mode } = invitation;
  const note = {
    id: invitation.id, export: invitation.export, name: invitation.name, secret: invitation.secret, from: invitation.from,
    ...(mode === 'public' ? { mode, base: invitation.base } : mode === 'echange' ? { mode } : {}),
    tables: plans.map(p => ({ table: p.tb.table, dest: p.dest, columns: p.tb.columns, ...(p.map ? { map: p.map } : {}), ...(p.match ? { match: p.match } : {}) })),
    refused: [], missing: {},
  };
  const before = await readSchema();
  for (const p of plans) await prepareDest({ dest: p.dest, columns: p.tb.columns, map: p.map });
  await createJournal(journal, note);
  ctx.made = mode === 'reponse' || !mode ? { invitation, journal, tables: plans.map(p => p.dest).filter(d => !before.has(d)) } : null;
  if (mode === 'echange') await wireExchange(note, invitation.retour);
  if (mode !== 'public') {
    await ensureForm(journal);
    return showLink(ctx, { journal, note });
  }
  ctx.wizard.setSteps(ctx.steps.slice(0, 2));
  ctx.wizard.show(STEP.link, [message('ok', t('recv.public.done')), roleGuide({ you: 'target', mode: 'public', current: 1 })], [{ label: t('common.close'), kind: 'btn-primary' }]);
  consolidateAll();
  return null;
}

// 3. Lien du formulaire de réception.
async function showLink(ctx, group, intro = null) {
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
  const report = el('div', { class: 'report' });
  const where = await formWhere(group.journal);
  const made = ctx.made && ctx.made.journal === group.journal ? ctx.made : null;
  ctx.wizard.show(STEP.link, [intro, el('p', {}, t('recv.link.help', { where, n: group.note.tables.length })),
    ...linkFigures(), input, report, roleGuide({ you: 'target', mode: flowOf(group.note), current: 2 })],
  [made ? back(() => run(null, report, () => undoCreate(ctx, made))) : null, { label: t('common.later') },
    { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, () => showReply(ctx, group, input.value)) }].filter(Boolean));
}

// Retour aux destinations depuis l'étape Lien : le journal et son formulaire (avec son lien
// d'écriture) sont effacés, et les tables que cette réception a créées, si elles sont encore vides.
async function undoCreate(ctx, made) {
  if (!(await confirmDialog({ title: t('recv.undo.title'), body: t('recv.undo.body'), confirmLabel: t('common.back') }))) return null;
  const empty = [];
  for (const table of made.tables) if (!(await fetchRows(table).catch(() => [null])).length) empty.push(table);
  await removeTechnicalTables([made.journal]);
  await apply(empty.map(table => ['RemoveTable', table]));
  ctx.made = null;
  return showDest(ctx, made.invitation);
}

// 4. Réponse à renvoyer, une fois le lien vérifié.
async function showReply(ctx, { journal, note }, link) {
  if (!parseFormLink(link)) throw new Error('formLink');
  const url = buildWebhookUrl(link, journal);
  await testUrl(url, journal);
  const identity = await docIdentity();
  const code = buildReply({
    id: note.id, secret: note.secret, url, retour: note.mode === 'echange' ? note.tables.map(tb => ({ table: tb.dest, dest: tb.table })) : null,
    recipient: { email: await myEmail(journal), docId: identity.docId, team: identity.team, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
  });
  const flow = flowOf(note);
  ctx.wizard.show(STEP.reply, [message('ok', t('recv.link.ok')), el('p', {}, t('recv.reply.help')), copyField(code),
    el('div', { class: 'handoff' }, copyButton(() => handoffText('source', flow, 3, code), t('guide.copyHandoff')), el('span', { class: 'muted small' }, t('guide.copyHandoff.help'))),
    roleGuide({ you: 'target', mode: flow, current: 3 }), stepHelp(['t-reply', 's-reply', 's-load', 't-daily'])],
  [back(() => showLink(ctx, { journal, note })), { label: t('common.close'), kind: 'btn-primary' }]);
}

// E-mail de la personne connectée, calculé par le serveur Grist : une ligne vide ajoutée au
// journal avec ses droits remplit la colonne Sync_Par (formule user.Email). Le nettoyage l'efface.
async function myEmail(journal) {
  const id = (await apply([['AddRecord', journal, null, { [APPLIED_COL]: true, [LIST_COL]: '' }]])).retValues[0];
  return ((await fetchRows(journal)).find(r => r.id === id) || {})[AUTHOR_COL] || '';
}
