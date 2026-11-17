// CIBLE : assistant de réception, en quatre étapes (Code, Destinations, Lien, Réponse). Une
// réception en attente (ou à rebrancher) l'ouvre directement à l'étape Lien (`group`).
import { docIdentity, readSchema } from '../grist.js';
import { VERSION } from '../config.js';
import { formWhere, linkFigures } from '../form-link.js';
import { protectSync, syncUnprotected } from '../engine/acl.js';
import { known } from '../engine/errors.js';
import { canRelink, checkDestinations, isUnsignedReception, createReception, knownReception, mustCompare, readInvitation, receptionReply, relinkReception, sourceOf, undoReception } from '../engine/target/receive.js';
import { sourceLine } from './source-line.js';
import { confirmFit, confirmNewTables, confirmOutgoing, destField, mappingBlock } from './dest.js';
import {
  backButton, cancelButton, closeButtons, codeField, confirmDialog, controlLine, el, laterButton, message, openWizard, run, versionNote, withHelp,
} from '../ui.js';
import { handoffButton, roleGuide } from '../guide.js';
import { receptionOptions } from './options.js';
import { stepHelp } from '../tutorial.js';
import { tabLink } from '../tab-link.js';
import { tabSendBlock } from '../tab-link-ui.js';
import { askWizard, dropWizard } from '../prefs.js';
import { t } from '../i18n.js';

const STEP = { code: 0, dest: 1, link: 2, reply: 3 };
const cancel = cancelButton();
const back = backButton;
const flowOf = note => (note.mode === 'echange' ? 'echange' : 'reponse');

// `onClose` : appelé à la fermeture (l'onglet se redessine). `offered` : le code d'une invitation arrivée d'un autre
// onglet (tab-link.js) : il remplit l'étape Code et passe aussitôt au contrôle, comme s'il avait été collé, et la réponse
// repart par le même chemin (étape Réponse).
export function receiveWizard(group, onClose, offered = '') {
  const steps = ['recv.step.code', 'recv.step.dest', 'recv.step.link', 'recv.step.reply'].map(k => t(k));
  const ctx = { steps, onClose, offered, viaTab: Boolean(offered), wizard: openWizard({ title: t('recv.new'), steps, onClose }) };
  return ctx.wizard.start(() => (group ? showLink(ctx, group) : showCode(ctx)));
}

// 1. Code d'invitation.
function showCode(ctx) {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('recv.invite.title') });
  const report = el('div', { class: 'report' });
  area.value = ctx.offered;
  const next = async () => {
    const invitation = await readInvitation(area.value);
    if (invitation.mode === 'echange' && await syncUnprotected()) return showProtect(ctx);
    ctx.origin = (await docIdentity()).origin; // pour le lien vers le document de la SOURCE (voir sourceLine)
    const known = await knownReception(invitation);
    return known ? showRelink(ctx, known, invitation) : showDest(ctx, invitation);
  };
  ctx.wizard.show(STEP.code, [el('p', {}, t('recv.invite.help')), area, report, stepHelp(['t-code']), roleGuide({ you: 'target', current: 1 })],
    [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
  if (ctx.offered && !ctx.offeredRead) { // une seule fois : « Retour » depuis l'étape suivante laisse le code, sans le relire
    ctx.offeredRead = true;
    run(null, report, next);
  }
}

// Un Échange renvoie à la SOURCE des tables de ce document, par la table technique Synchro. Ses règles d'accès (réservée aux
// propriétaires) sont posées avant d'y écrire quoi que ce soit : Grist recharge alors le document, donc le widget et cet
// assistant, d'où cette étape, avant toute écriture. Le code est à recoller ensuite.
function showProtect(ctx) {
  const report = el('div', { class: 'report' });
  const protect = async () => {
    askWizard('reception'); // le widget qui repart rouvre l'assistant (le rechargement coupe cet appel avant son retour)
    try {
      await protectSync();
    } catch (e) {
      // Une erreur prévue (table Synchro d'une autre personne, règle refusée par Grist) est dite ; un appel coupé par le
      // rechargement du document n'en est pas une.
      if (known(e)) {
        dropWizard('reception');
        throw e;
      }
    }
    ctx.wizard.show(STEP.code, [message('info', t('common.reloading'))], []);
  };
  ctx.wizard.show(STEP.code, [message('info', t('recv.protect.body'), t('recv.protect.title')), report],
    [cancel, { label: t('recv.protect.ok'), kind: 'btn-primary', onClick: () => run(null, report, protect) }]);
}

// Document vérifié chez Grist : nom (dossier · équipe), ou espace personnel.
const shareText = share => `${share.name} (${[share.folder, share.personal ? t('send.reply.personalSpace') : share.teamName || share.team].filter(Boolean).join(' · ')})`;

// Nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) : la même
// réception reprend, avec son journal et ses tables, si l'invitation vient du même document, dans
// le même mode. La fiche est montrée avant : la personne confirme que c'est bien la même SOURCE.
// Un Échange rebranche son retour sur la nouvelle adresse. Les clés de signature sont tirées de
// nouveau, avec la clé publique de cette invitation.
async function showRelink(ctx, known, invitation) {
  if (!canRelink(known, invitation)) throw new Error('alreadyReceived');
  const reinforcing = await isUnsignedReception(known);
  const report = el('div', { class: 'report' });
  const relink = async () => showLink(ctx, await relinkReception(known, invitation), message('info', t(reinforcing ? 'recv.relink.renf' : 'recv.relink')));
  ctx.wizard.show(STEP.dest, [message('info', t(reinforcing ? 'recv.relink.confirm.renf' : 'recv.relink.confirm', { name: known.note.name, journal: known.journal })), sourceFiche(invitation, ctx.origin), report],
    [back(() => showCode(ctx)), cancel, { label: t(reinforcing ? 'recv.relink.ok.renf' : 'recv.relink.ok'), kind: 'btn-primary', onClick: () => run(null, report, relink) }]);
}

// D'où vient une invitation : export, tables, personne et document qui l'ont faite ; pour un
// Échange, le document vérifié chez Grist et le code de contrôle de l'envoi de retour.
function sourceFiche(invitation, origin) {
  const { share } = invitation;
  return el('div', {},
    message('info', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })),
    sourceLine(sourceOf(invitation), { verified: Boolean(share), origin }),
    share ? el('p', { class: 'small' }, t('recv.backDoc', { doc: shareText(share) })) : null,
    share && share.personal ? message('warn', t('recv.backPersonal')) : null,
    invitation.backCode ? controlLine(t('recv.backCode'), invitation.backCode) : null,
    invitation.renforce ? el('p', { class: 'small' }, t('recv.renforce')) : null,
    versionNote(invitation.version, VERSION));
}

// 2. Destinations : une par table reçue.
// Le journal est lisible par les éditeurs seulement (case cochée par défaut, voir acl.js) : il garde
// les versions reçues, quelles que soient les règles des tables de destination. Hors Échange et lien
// public (la carte n'y a pas de bouton Options), des options par défaut (voir receptionOptions) : archive et tables en lecture
// seule décochées, et les colonnes que la SOURCE ajoutera ensuite à valider (case « automatique » décochée). Un Échange renforcé demande d'avoir comparé
// le code de contrôle de l'envoi de retour.
async function showDest(ctx, invitation) {
  const schema = await readSchema();
  const rows = invitation.tables.map(tb => ({ tb, pick: destField(schema, tb.table) }));
  const report = el('div', { class: 'report' });
  const reserveBox = el('input', { type: 'checkbox', checked: ctx.reserve !== false });
  const compared = el('input', { type: 'checkbox' });
  const askCompared = mustCompare(invitation);
  const options = ['echange', 'public'].includes(invitation.mode) ? null : receptionOptions(ctx.options || { ask: true });
  const next = async () => {
    ctx.compared = compared.checked; // le moteur refuse sans elle (codeNotCompared)
    ctx.reserve = reserveBox.checked;
    ctx.options = options ? options.read() : {};
    const plans = rows.map(({ tb, pick }) => ({ tb, dest: pick.dest() }));
    const { schema: current, existing } = await checkDestinations(invitation, plans, { compared: ctx.compared });
    const fresh = plans.map(p => p.dest).filter(dest => !current.has(dest));
    if (fresh.length && !(await confirmNewTables(fresh))) return null;
    if (existing.length) return showColumns(ctx, invitation, plans, current);
    return create(ctx, invitation, plans);
  };
  ctx.wizard.show(STEP.dest, [
    sourceFiche(invitation, ctx.origin),
    el('p', {}, t('recv.dest')),
    el('div', { class: 'dest-grid' }, el('span', { class: 'dest-head' }, t('recv.dest.from')), el('span', { class: 'dest-head' }, t('recv.dest.to')),
      ...rows.flatMap(r => [el('span', { class: 'dest-from' }, r.tb.table), r.pick.node])),
    invitation.mode === 'echange' ? withHelp(message('info', t('recv.consent.echange')), t('recv.consent.echange.help'), t('recv.consent.echange.name')) : null,
    withHelp(el('p', { class: 'muted small' }, t(invitation.mode === 'public' ? 'recv.consent.public' : 'recv.consent')),
      t(invitation.mode === 'public' ? 'recv.consent.public.help' : 'recv.consent.help'), t('recv.consent.name')),
    withHelp(el('label', { class: 'check' }, reserveBox, t('recv.reserve')), t('recv.reserve.help'), t('recv.reserve')),
    options ? el('details', { class: 'guide options-more' }, el('summary', {}, t('recv.options.advanced')), options.node) : null,
    askCompared ? el('label', { class: 'check' }, compared, t('recv.backCompared')) : null,
    report, stepHelp(['t-dest']), roleGuide({ you: 'target', mode: invitation.mode, current: 1 }),
  ], [back(() => showCode(ctx)), cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// 2 bis. Tables existantes : correspondance des colonnes et rattachement.
function showColumns(ctx, invitation, plans, schema) {
  const report = el('div', { class: 'report' });
  const blocks = plans.filter(p => schema.has(p.dest)).map(p => ({ p, block: mappingBlock(schema, p.tb.table, p.dest, p.tb.columns) }));
  const next = async () => {
    for (const { p, block } of blocks) Object.assign(p, block.read());
    if (!(await confirmFit(blocks.flatMap(({ block }) => block.issues())))) return null;
    if (invitation.mode === 'echange' && !(await confirmOutgoing(schema, plans.map(p => p.dest), shareText(invitation.share)))) return null;
    return create(ctx, invitation, plans);
  };
  ctx.wizard.show(STEP.dest, [el('p', {}, t('recv.existing')), ...blocks.map(b => b.block.node), report, stepHelp(['t-dest'])], [
    back(() => showDest(ctx, invitation)),
    { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, next) },
  ]);
}

// Un journal pour l'export, nommé d'après lui, et une destination par table (createReception). Échange :
// l'envoi de retour est branché aussitôt ; en lien public, il n'y a pas de formulaire.
async function create(ctx, invitation, plans) {
  const { mode } = invitation;
  const { journal, note, created } = await createReception(invitation, plans, { reserve: ctx.reserve, options: ctx.options, compared: ctx.compared, arrange: true });
  ctx.made = mode === 'reponse' || !mode ? { invitation, journal, created } : null;
  if (mode !== 'public') return showLink(ctx, { journal, note });
  ctx.wizard.setSteps(ctx.steps.slice(0, 2));
  ctx.wizard.show(STEP.link, [message('ok', t('recv.public.done')), roleGuide({ you: 'target', mode: 'public', current: 1 })], closeButtons());
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
  [made ? back(() => run(null, report, () => undoCreate(ctx, made))) : null, laterButton(),
    { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, () => showReply(ctx, group, input.value)) }].filter(Boolean));
}

// Retour aux destinations depuis l'étape Lien : le journal et son formulaire (avec son lien
// d'écriture) sont effacés, et les tables que cette réception a créées, si elles sont encore vides.
async function undoCreate(ctx, made) {
  if (!(await confirmDialog({ title: t('recv.undo.title'), body: t('recv.undo.body'), confirmLabel: t('common.back') }))) return null;
  await undoReception(made);
  ctx.made = null;
  return showDest(ctx, made.invitation);
}

// 4. Réponse à renvoyer, une fois le lien vérifié. Une réception d'avant la 0.10 en attente de
// réponse n'a pas de clé publique : il faut une nouvelle invitation.
async function showReply(ctx, { journal, note }, link) {
  const { code, control } = await receptionReply({ journal, note }, link);
  const flow = flowOf(note);
  // Renvoyer la réponse au document d'origine quand il est ouvert dans un autre onglet : d'elle-même quand l'invitation
  // est venue de là, sur un clic sinon ; le code reste à copier.
  const onTab = tabSendBlock({
    texts: { button: t('tab.back.button'), help: t('tab.back.help'), sent: t('tab.back.sent'), done: t('tab.back.got'), silent: t('tab.back.silent') },
    start: (alive, ack) => tabLink().sendReply(code, { alive, onGot: ack }),
    auto: ctx.viaTab,
  });
  ctx.wizard.show(STEP.reply, [message('ok', t('recv.link.ok')), el('p', {}, t('recv.reply.help')), codeField(code),
    controlLine(t('recv.reply.code'), control), onTab,
    handoffButton('source', flow, 3, code),
    stepHelp(['t-reply', 's-reply', 's-load', 't-daily']), roleGuide({ you: 'target', mode: flow, current: 3 })],
  [back(() => showLink(ctx, { journal, note })), ...closeButtons()]);
}
