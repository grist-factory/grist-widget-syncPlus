// CIBLE : la recopie, tant qu'un éditeur a la page du widget ouverte. Toutes les 10 secondes, le
// widget demande à Grist quelles tables ont changé (voir due) ; si un journal ou une destination a
// changé, et au moins une fois par minute, chaque journal est déplié, recopié dans ses
// destinations, puis nettoyé. Le résultat de chaque passage est gardé ici pour l'onglet.
import {
  ARCHIVE_COL, DELETE_COL, EXPORT_COL, HUB, KEY_COL, KIND, LIST_COL, RESEND_COL, SCHEMA_COL, SEAL_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, chunk, isBlank, nowS, randomHex, sleep,
} from '../logic/common.js';
import { exportTables, returnExportTables } from '../logic/exports.js';
import {
  awaitingPartner, currentRows, destColumns, expandRows, hasSchema, isRaw, nextGaps, planPull, planPurge, planUnpack, rowsByTable, sentColumns, touchedTables, unpackActions,
} from '../logic/journal.js';
import {
  copyColumns, destRefs, droppedColumns, exchangeRules, followRenames, manualEdits, planConsolidation, receivedColumns, refusedGaps,
  restoreActions, rowNumbers,
} from '../logic/consolidation.js';
import { resendValue } from '../logic/resend.js';
import { nextTally, tallyDue, tallyGap } from '../logic/tally.js';
import { citedFiles, fillActions, resolveRows, short, waitingVersions } from '../logic/files.js';
import { decideLinks, fillLinks, linkActions, planLinks, resolveLinks, targetRows, textFill, unlinkActions } from '../logic/links.js';
import { backfillActions, acknowledged, structureChanges } from '../logic/structure.js';
import { adoptionPreview, adoptionStep } from '../logic/adopt.js';
import { formulaColumns } from './formulas.js';
import { cardShape, driftResult, endedAt, exportShape, filesSummary, nextSuspect, offersOf, tableResult, wrote } from '../logic/report.js';
import { apply, docChanges, docIdentity, fetchRows, isOwner, page, prefs, publicRecords, readSchema, t, withLock } from '../port.js';
import { updateJournalNote, upgradeJournal } from './journals.js';
import { moveNotes } from '../note-move.js';
import { addDestColumnsActions, missingColumns, optionActions, receivedJournals, receivedKey, restyleOptionActions, valueChoiceActions } from '../logic/received.js';
import { checkSeals, checkSigned, isUnpacked, sealMark, sealRows, sealer } from '../logic/trust.js';
import { finishRenf, graceOpen, renfState } from '../logic/reinforce.js';
import { noteHeldFiles } from '../source/files.js';
import { attachments, receiveFiles } from './files.js';
import { styleColumns } from './style.js';
import { describeColumns } from './describe.js';
import { layoutColumns } from './layout.js';
import { readSourceNote, syncRows } from '../source/synchro.js';
import { stopReturn, wireExchange } from '../exchange.js';
import { errorText, failure, noteError } from '../errors.js';

const POLL_MS = 10000;
const IDLE_MS = 60000;
// Quand Grist dit ce qui a changé (voir due), un passage sans changement ne sert qu'aux tâches à
// échéance (marques de refus, fichiers à retenter) : toutes les 5 minutes. Un passage relit chaque
// journal en entier (mesuré : 16 Mo pour deux réceptions de 10 000 lignes).
const QUIET_MS = 300000;
// Décision prise pendant un passage : le suivant est relancé dès que celui-ci finit.
const DECIDE_RETRY_MS = 300;
// Lignes reçues dépliées par passage, au plus ; au-delà de FLOOD_PER_MIN lignes reçues par minute,
// l'arrivée est anormale (le webhook n'en dépose que quelques-unes) : la carte le signale.
const RAW_BATCH = 500;
const FLOOD_PER_MIN = 600;
// Une destination dont le journal n'a pas changé n'est relue, pour y voir les retouches faites à la
// main, que si Grist dit qu'elle a changé (voir due), au retour sur la page, sur « Synchroniser »,
// et au plus tard au bout de 5 minutes.
const REREAD_MS = 300000;
// Refus corrigé, chez le document qui administre un Échange : la demande d'envoi posée au lot
// (Synchro_Renvoi, marque FIX_MARK suivie de l'heure) est effacée au premier passage après
// FIX_HOLD_S secondes ; l'envoi est parti depuis longtemps (Grist le met en file aussitôt).
const FIX_MARK = 'refus';
const FIX_VALUE = new RegExp(`^${FIX_MARK}(\\d+):`);
const FIX_HOLD_S = 60;

// Ce que l'onglet montre. `results` : dernier passage par journal ({ at, rows, gaps } ; { at,
// error, text } en cas d'erreur) et par table reçue (clé `journal|table` : { at, text, table,
// stats, recent, dest, copyCols, labelCol, labelCols, types, drift, droppedCols, driftCount,
// driftGone, pending, gaps, files }, ou { at, error, text } ; voir tableResult dans
// logic/report.js). `drift` : les premières lignes retouchées à la main (SHOWN), `droppedCols` :
// les colonnes reçues effacées ici ([colonne du journal, d'ici]), `driftCount` : le nombre de
// retouches en tout (cellules, lignes et colonnes effacées), `driftGone` : celui des lignes
// effacées. Échange administré ici : `pending`, les changements d'un participant à valider ;
// `gaps`, les lignes refusées restées différentes chez lui (voir planConsolidation). `files` :
// pièces jointes attendues, trop grosses ({ waiting, big, public }). `offers` : tables proposées
// par journal ([{ table, columns, n }]). `readOnly` : le document refuse l'écriture (lecteur).
// `lastVisit` : date de la visite précédente sur ce document (secondes), ou 0.
export const state = { results: new Map(), offers: new Map(), readOnly: false, viewer: false, lastVisit: null };
export const tableKey = (journal, table) => `${journal}|${table}`;
// Refus de Grist faute de droits (lecteur) : le widget passe en lecture seule.
export const isAccessError = e => /access|denied|blocked|permission/i.test(e.message);

let busy = false;
let lastArrival = Date.now(); // dernière arrivée dans un journal (ou retour sur la page)
let lastPass = 0; // début du dernier passage
// Coup d'œil sur le document (voir due) : son état au coup d'œil précédent (`hash`), les journaux
// et destinations du dernier passage (`tables`), un journal en lien public (`pull`) ; `compare`
// passe à faux si Grist refuse.
const watch = { hash: '', tables: new Set(), pull: false, compare: true };
export const comparing = () => watch.compare; // pour le diagnostic
let onChange = async () => {}; // l'onglet, redessiné quand un passage a changé quelque chose
const inflow = new Map(); // journal -> { ids, at } : lignes reçues vues au passage précédent
const settled = new Map(); // `journal|table` -> { signature, at, dest, deps } : journal déjà recopié sans effet (`deps` : tables visées par ses Références)
const lastRead = new Map(); // `journal|table` -> { numbers, drift } : numéros de ligne et retouches, à la dernière lecture
const pulled = new Map(); // journal -> empreintes des instantanés publics déjà lus
const stopped = new Set(); // Échanges coupés par l'autre document dont l'envoi de retour est arrêté
const decided = new Map(); // `journal|version` -> 'accepter' ou 'refuser', jusqu'au passage qui l'applique
let choices = new Map(); // les décisions prises en compte par le passage en cours

export function startAutoConsolidation(render) {
  onChange = render;
  const tick = async () => {
    if (page.visible() && await due()) await consolidateAll();
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
  page.onShow(() => {
    lastArrival = Date.now();
    consolidateAll({ reread: true });
  });
}

// Un passage est-il dû ? Grist dit quelles tables ont changé depuis le coup d'œil précédent
// (docChanges) : un journal où des lignes sont arrivées, une destination retouchée à la main (elle
// est alors relue), ou le schéma. Sinon un passage toutes les QUIET_MS. Un lien public, que rien
// ne signale ici, et le cas où Grist refuse la comparaison (droits) gardent le rythme d'avant :
// toutes les POLL_MS tant que des lignes arrivent, puis toutes les minutes.
async function due() {
  if (busy) return false; // un passage en cours : le coup d'œil attend le suivant
  const elapsed = Date.now() - lastPass;
  const steady = elapsed >= (Date.now() - lastArrival > IDLE_MS ? IDLE_MS : POLL_MS);
  if (watch.compare) {
    const changes = await docChanges(watch.hash).catch(() => ({ hash: watch.hash, tables: null }));
    if (changes) {
      const touched = changes.hash === watch.hash ? [] : touchedTables(changes.tables, watch.tables);
      watch.hash = changes.hash;
      if (touched === null) settled.clear();
      else for (const [key, was] of settled) if ([was.dest, ...(was.deps || [])].some(table => touched.includes(table))) settled.delete(key);
      return elapsed >= QUIET_MS || touched === null || touched.length > 0 || (watch.pull && steady);
    }
    watch.compare = false;
  }
  return steady;
}

// Date de la visite précédente, retenue par navigateur et par document : la seule chose que le
// widget garde hors de Grist pour l'historique (aucune donnée des tables).
async function readLastVisit() {
  if (state.lastVisit !== null) return;
  const key = `visit.${(await docIdentity()).docId}`;
  state.lastVisit = Number(prefs.read(key)) || 0;
  prefs.write(key, String(Math.floor(nowS())));
}

// Oublie ce qui est gardé d'un journal (réception arrêtée).
export function forgetJournal(journal) {
  for (const key of [...state.results.keys()]) if (key === journal || key.startsWith(`${journal}|`)) state.results.delete(key);
  for (const map of [settled, lastRead]) for (const key of [...map.keys()]) if (key.startsWith(`${journal}|`)) map.delete(key);
  state.offers.delete(journal);
}

// ---------------------------------------------------------------------------------------------
// Un passage sur un journal

// Lien public : lit les instantanés de l'export dans la table Synchro de la SOURCE, sans
// identifiant, et ajoute au journal ce qui a changé, comme l'aurait fait un webhook. Les
// instantanés ne sont relus que si leur empreinte (taille et CRC-32, une petite ligne à part) a
// changé depuis la dernière lecture de cette page. Rend vrai si quelque chose est arrivé.
async function pull(note, journal) {
  const read = kind => publicRecords(note.base, SYNC_TABLE, { [EXPORT_COL]: [note.export], [TYPE_COL]: [kind] });
  const marks = await read(KIND.mark);
  const seen = JSON.stringify(marks.map(r => [r.fields[TABLE_COL], r.fields[LIST_COL]]).sort());
  if (pulled.get(journal) === seen) return false;
  const { actions, tooBig } = planPull({ records: await read(KIND.full), journalRows: await fetchRows(journal), journalTable: journal });
  await apply(actions);
  if (JSON.stringify(tooBig) !== JSON.stringify(note.tooBig || [])) await updateJournalNote(journal, n => ({ ...n, tooBig }));
  pulled.set(journal, seen);
  return actions.length > 0;
}

// Arrivée anormale : plus de FLOOD_PER_MIN lignes reçues par minute depuis le passage précédent.
// Le premier passage d'un chargement ne peut pas le dire (on ne sait pas depuis quand elles sont là).
function flooded(journal, raw) {
  const at = nowS();
  const was = inflow.get(journal);
  inflow.set(journal, { ids: new Set(raw.map(r => r.id)), at });
  if (!was) return false;
  return raw.filter(r => !was.ids.has(r.id)).length > FLOOD_PER_MIN * Math.max(1, (at - was.at) / 60);
}

// Clé de signature de l'export reçu (voir receivedKey) et sceau des lignes dépliées (voir trust.js).
// Première fois avec une clé, ou clé changée par une nouvelle invitation : les lignes dépliées
// déjà là sont scellées avec elle (confiance à ce moment-là) et son empreinte notée (`sceau`). Une
// fois notée, une clé introuvable (destination effacée, description vidée) arrête la recopie de ce
// journal, au lieu de tout accepter. Sans clé jamais vue (réception d'avant la 0.8, lien public) :
// rien n'est vérifié. Rend { key, seal, note }.
export async function sealing(schema, journal, note) {
  const key = note.mode === 'public' ? '' : receivedKey(schema, journal, note);
  if (!key) {
    if (note.sceau) throw failure('keyLost');
    return { key: '', seal: null, note };
  }
  const seal = await sealer(key);
  const mark = await sealMark(seal);
  if (note.sceau === mark) return { key, seal, note };
  sealsSeen.delete(journal);
  const sealed = await sealRows((await fetchRows(journal)).filter(isUnpacked), note.export, seal);
  await apply(chunk(sealed).map(part => ['BulkUpdateRecord', journal, part.map(r => r.id), { [SEAL_COL]: part.map(r => r[SEAL_COL]) }]));
  return { key, seal, note: await updateJournalNote(journal, n => ({ ...n, sceau: mark })) };
}

// Sceaux déjà vérifiés, par journal (voir checkSeals).
export const sealsSeen = new Map();

// Lignes du journal sans les lignes dépliées au sceau faux (`forged`, numéros) : ajoutées par la
// clé du formulaire sans passer par le dépliage. Sans sceau (voir sealing) : toutes.
async function trusted(journal, note, rows, seal) {
  if (!seal) return { rows, forged: [] };
  if (!sealsSeen.has(journal)) sealsSeen.set(journal, new Map());
  const { kept, forged } = await checkSeals(rows, note.export, seal, sealsSeen.get(journal));
  return { rows: kept, forged };
}

// Déplie ce qui est arrivé (lignes scellées, voir sealing), efface les lignes au sceau faux, et note
// dans le journal ce qui manque encore, les arrivées suspectes (lignes rejetées ou au sceau faux,
// flot anormal) et la fin de l'envoi annoncée par la SOURCE (`ended`, heure ; effacée si des
// données arrivent ensuite). Avec la clé de signature, les lignes mal signées sont rejetées. Rend
// la note à jour, les lignes du journal, et s'il reste des lignes reçues pour le passage suivant.
async function unpack(journal, { key, seal, note: known }) {
  let note = known;
  let rows = await fetchRows(journal);
  const raw = rows.filter(isRaw);
  const flood = flooded(journal, raw);
  // Un partage en cours de renforcement accepte, 7 jours au plus, l'ancien envoi sans signature ; la première
  // livraison signée avec la nouvelle clé finit le renforcement (voir reinforce.js).
  const { bad, bare, signed } = key && raw.length ? await checkSigned(raw, key, note.export, { grace: graceOpen(note, nowS()) }) : {};
  if (signed && ['pending', 'expired'].includes(renfState(note, nowS()))) note = await updateJournalNote(journal, n => finishRenf(n, nowS()));
  const plan = planUnpack(rows, journal, { exportId: note.mode === 'public' ? null : note.export, max: RAW_BATCH, now: nowS(), bad, bare });
  if (plan.actions.length) {
    lastArrival = Date.now();
    await apply(seal ? unpackActions(journal, await sealRows(plan.added, note.export, seal), plan.removed) : plan.actions);
    rows = await fetchRows(journal);
  }
  const checked = await trusted(journal, note, rows, seal);
  rows = checked.rows;
  if (checked.forged.length) await apply(chunk(checked.forged).map(ids => ['BulkRemoveRecord', journal, ids]));
  if (!plan.actions.length && !checked.forged.length) return { note, rows, left: 0 };
  return { note: await noteArrivals(journal, note, { plan, forged: checked.forged.length, flood }), rows, left: plan.left };
}

// Ce que le dépliage note dans le journal (voir unpack) ; rend la note à jour.
async function noteArrivals(journal, note, { plan, forged, flood }) {
  const rejected = plan.rejected + forged;
  const gaps = nextGaps(note, plan);
  if (rejected || flood) gaps.suspect = nextSuspect(note.suspect, rejected, flood, nowS());
  const ended = endedAt(note, plan, nowS());
  // Nombre de clés annoncé par la SOURCE pour chaque table (voir tally.js) ; pas de clé 'tally' sans annonce.
  const announced = nextTally(note.tally, plan.tally, note.tables.map(tb => tb.table));
  const tally = Object.keys(announced).length ? announced : undefined;
  if (!gaps.suspect && ended === note.ended && JSON.stringify(gaps) === JSON.stringify({ missing: note.missing || {}, big: note.big || {} })
    && JSON.stringify(tally) === JSON.stringify(note.tally)) return note;
  await updateJournalNote(journal, n => ({ ...n, ...gaps, ended, tally }));
  return { ...note, ...gaps, ended, tally };
}

// Colonnes d'une table reçue, avant sa recopie : celles qui arrivent (voir receivedColumns),
// celles effacées ici (notées ; l'Échange les recrée, comme avant : la destination repart vers
// l'autre document), et celles qui manquent à la destination, ajoutées tout de suite. Rend
// l'entrée à jour (correspondance, colonnes effacées, numéros des colonnes, Références décidées),
// les colonnes recopiées, leurs types, les colonnes de pièces jointes et celles qui sont des
// Références vers une table reçue (`links`, voir linkColumns).
async function prepareColumns(ctx, noted, tableRows) {
  const base = await addColumns(ctx, noted, tableRows);
  const { received, dropped, kept, made, own } = base;
  await refreshColumnOptions(ctx, base, tableRows);
  const { linked, laid, formulas } = await decideColumns(ctx, base, tableRows);
  const structure = ctx.exchange ? null : structureChanges({ ...laid, own }, { held: received.held, all: received.all, described: hasSchema(tableRows), here: ctx.schema.columns(received.entry.dest) });
  // Un clic sur « Appliquer » : les avis sont vus (voir acknowledged), et les colonnes créées à l'instant se remplissent.
  const ack = ctx.approve ? acknowledged(laid, structure) : laid.ack;
  const entry = { ...laid, ...(ack ? { ack } : {}), sends: received.sends.length ? received.sends : undefined, ...(received.doc ? { sourceDoc: received.doc } : {}), refs: destRefs(ctx.schema, received.entry.dest), dropped: dropped.length ? dropped.map(([, to]) => to) : undefined };
  const copyCols = copyColumns(received.sent.map(c => c.id), ctx.schema.columns(entry.dest), entry.map);
  const types = Object.fromEntries(received.sent.map(c => [c.id, c.type]));
  const created = ctx.approve ? made.map(id => ({ from: id, to: (received.entry.map || {})[id] || id })) : [];
  return { entry, dropped, copyCols, types, formulas, structure: ctx.approve ? null : structure, created, fileCols: copyCols.filter(([from]) => types[from] === 'Attachments'), links: linked.specs, relinkable: linked.text };
}

// Les colonnes qui arrivent, celles effacées ici et celles qui manquent à la destination, ajoutées tout de suite.
async function addColumns(ctx, noted, tableRows) {
  // La réception demande l'accord (`ask`) : les colonnes arrivées après coup attendent un clic (voir structure.js).
  const received = receivedColumns(noted, tableRows, ctx.schema, ctx.allowedFor(noted.dest), Math.floor(nowS()), { hold: ctx.ask && !ctx.approve });
  const dropped = ctx.exchange ? [] : droppedColumns(received.entry, received.sent, ctx.schema.columns(received.entry.dest).map(c => c.colId));
  const kept = received.sent.filter(c => !dropped.some(([from]) => from === c.id));
  const added = [...addDestColumnsActions(ctx.schema, received.entry.dest, kept, received.entry.map), ...archiveColumn(ctx, received.entry.dest)];
  const made = missingColumns(ctx.schema, received.entry.dest, kept, received.entry.map);
  const own = received.entry.own && made.length ? [...new Set([...received.entry.own, ...made])] : received.entry.own;
  if (added.length) {
    await apply(added);
    ctx.schema = await readSchema();
  }
  return { received, dropped, kept, made, own };
}

// Choix ajoutés à la SOURCE, format d'une colonne créée avant l'arrivée de sa description ; ou, sur
// demande (« Reprendre la mise en forme »), le style de chaque colonne reçue remis sur celui de la SOURCE.
async function refreshColumnOptions(ctx, { received, kept, own }, tableRows) {
  const again = ctx.restyle || {}; // « Reprendre depuis la SOURCE » : les éléments à reprendre ({ style, notes, table, formulas })
  const options = (again.style ? restyleOptionActions : optionActions)(ctx.schema, { ...received.entry, own }, kept);
  if (options.length) {
    await apply(options);
    ctx.schema = await readSchema();
  }
  // Pas de liste envoyée (export filtré) : les choix sont les valeurs reçues.
  const values = valueChoiceActions(ctx.schema, { ...received.entry, own }, kept, () => currentRows(tableRows));
  if (values.length) {
    await apply(values);
    ctx.schema = await readSchema();
  }
}

// Ce que la SOURCE décide pour les colonnes reçues, dans l'ordre : références, mise en forme, descriptions, ordre de la page, formules.
async function decideColumns(ctx, { received, kept, own }, tableRows) {
  const again = ctx.restyle || {};
  const linked = await linkColumns(ctx, { ...received.entry, own }, kept, tableRows, { relink: Boolean(again.links) });
  // Règles de mise en forme conditionnelle de la SOURCE (reconstruites, jamais copiées), et sa langue.
  const styled = await styleColumns(ctx, linked.entry, kept, { replace: Boolean(again.style) });
  // Descriptions des colonnes et de la table, envoyées par la SOURCE si l'export les porte.
  const described = await describeColumns(ctx, styled, destColumns(kept), { tableNote: received.tableNote, replace: Boolean(again.notes), replaceTable: Boolean(again.table) });
  // Ordre et colonnes cachées de la page de la table (voir layout.js) : décidés une fois pour les colonnes créées ici, puis sur « Reprendre depuis la SOURCE ».
  const laid = await layoutColumns(ctx, described, destColumns(kept), { replace: Boolean(again.layout) });
  // Formules de colonne : lues à chaque passage (la carte les montre), posées seulement sur « Reprendre depuis la SOURCE ».
  const formulas = await formulaColumns(ctx, laid, kept, { replace: Boolean(again.formulas) });
  return { linked, laid, formulas };
}

// Références conservées (voir links.js) : une colonne que la SOURCE envoie comme Référence ou Liste de références
// vers une autre table de l'export, créée ici en texte et encore vide, devient une Référence (une Liste de références)
// vers la table reçue (affichant la même colonne). Une colonne déjà remplie reste du texte ; dans les deux cas le sort
// est noté (`linked`) et la destination n'est plus relue pour cela. Jamais en Échange (les colonnes y vont dans les
// deux sens, par nom). Rend l'entrée à jour, les colonnes qui sont des Références (`specs`) et celles qui sont restées
// du texte (`text`, que « Refaire les références » convertit sur demande : `relink` les convertit toutes, remplies
// comprises, et leurs cellules reprennent la SOURCE). Une colonne dont la SOURCE ne garde plus le lien redevient du texte.
async function linkColumns(ctx, noted, sent, tableRows, { relink = false } = {}) {
  if (ctx.exchange) return { entry: noted, specs: [], text: [] };
  const plan = planLinks(ctx.schema, noted, sent, ctx.dests, { relink });
  let entry = noted;
  if (plan.undo.length) {
    await apply(unlinkActions(entry.dest, plan.undo));
    await apply(textFill({ journalRows: tableRows, destRows: await fetchRows(entry.dest), specs: plan.undo, destTable: entry.dest }));
    ctx.schema = await readSchema();
    entry = { ...entry, linked: (entry.linked || []).filter(id => !plan.undo.some(s => s.from === id)) };
  }
  if (!plan.todo.length) return { entry, specs: plan.ready, text: plan.text };
  const destRows = await fetchRows(entry.dest);
  const { convert, decided } = decideLinks(plan.todo, to => destRows.every(r => isBlank(r[to])), { all: relink });
  if (convert.length) {
    await apply(convert.flatMap(spec => linkActions(entry.dest, spec)));
    ctx.schema = await readSchema();
  }
  return {
    entry: { ...entry, linked: [...new Set([...(entry.linked || []), ...decided])] },
    specs: [...plan.ready, ...convert.map(spec => (relink ? { ...spec, relink: true } : spec))],
    text: [...plan.text, ...plan.todo.filter(spec => !convert.includes(spec))],
  };
}

// Réception en archive : la case des lignes parties de la SOURCE, ajoutée à la destination qui ne
// l'a pas (aussi quand l'option est choisie après coup).
const archiveColumn = (ctx, dest) => (ctx.archive && !ctx.schema.columns(dest).some(c => c.colId === ARCHIVE_COL)
  ? [['AddVisibleColumn', dest, ARCHIVE_COL, { type: 'Bool', label: t('recv.archive.col'), isFormula: false }]] : []);

// Recopie d'une table dans sa destination (voir prepareColumns pour ses colonnes). Rend l'entrée à
// jour (destination renommée, correspondance, colonnes effacées), les compteurs, les colonnes
// recopiées et leurs types, les numéros de ligne et les retouches faites à la main (lus après la
// recopie).
async function copyTable(ctx, noted) {
  const renamed = followRenames(noted, ctx.schema);
  if (!ctx.schema.has(renamed.dest)) return { entry: renamed, error: failure('destMissing', { dest: renamed.dest }) };
  const tableRows = ctx.groups.get(renamed.table) || [];
  const { entry, copyCols, types, dropped, fileCols, links, relinkable, formulas, structure, created } = await prepareColumns(ctx, renamed, tableRows);
  const present = fileCols.length ? await ctx.files() : new Map();
  // Échange : une version dont un fichier n'est pas encore arrivé attend (voir waitingVersions).
  const waiting = ctx.exchange ? waitingVersions(tableRows, fileCols.map(([from]) => from), present) : new Map();
  const key = tableKey(ctx.journal, entry.table);
  const signature = JSON.stringify([tableRows.map(r => r.id), copyCols, entry.match || '', entry.dest, present.size, links.map(s => [s.to, s.target])]);
  if (unchanged(key, signature)) return { entry, stats: { added: 0, updated: 0, removed: 0 }, copyCols, types, dropped, links, relinkable, formulas, structure, wrote: false, ...lastRead.get(key) };
  // Références conservées : la cellule porte le numéro de la ligne d'ici qui a la clé citée.
  const lookups = await linkLookups(links);
  const rows = resolveLinks(resolveRows(tableRows, fileCols.map(([from]) => from), present), links, lookups);
  const destRows = await fetchRows(entry.dest);
  const plan = planTable(ctx, entry, { rows, destRows, copyCols, waiting });
  // Table qui existait avant la réception, dans une réception qui demande l'accord : rien n'y est écrit avant que la personne ait vu
  // ce qui arriverait aux lignes déjà là (voir adopt.js).
  const adopting = adoptionStep(ctx, entry, destRows);
  if (adopting === 'hold' && plan.stats.added + plan.stats.updated > 0) {
    const adoption = adoptionPreview(plan, { copyCols, destRows, match: entry.match || '' });
    return { entry, stats: { added: 0, updated: 0, removed: 0 }, copyCols, types, dropped, links, formulas, structure: { held: [], gone: [], retyped: [], ...structure, adoption },
      numbers: rowNumbers(destRows), drift: [], pending: [], gaps: [], files: null, wrote: false };
  }
  const fill = fillWrites(ctx, entry, { tableRows, rows, destRows, fileCols, present, links, lookups, created });
  const destChanged = await writeTable(ctx, entry, plan, fill);
  if (plan.actions.length || destChanged) settled.delete(key);
  else settled.set(key, { signature, at: Date.now(), dest: entry.dest, deps: links.map(s => s.target) });
  const after = destChanged ? await fetchRows(entry.dest) : destRows;
  const files = filesSummary(tableRows, fileCols, present, ctx.mode === 'public', plan.waiting);
  rememberRead(ctx, key, { rows, after, copyCols, plan, files });
  return { entry: { ...entry, waiting: files.waiting, ...(adopting === 'mark' ? { adopted: true } : {}) }, stats: plan.stats, copyCols, types, dropped, links, relinkable, formulas, structure, wrote: plan.actions.length > 0, ...lastRead.get(key) };
}

// Cellules à compléter en même temps que la recopie. Pièces jointes : la recopie écrit les fichiers que le document a déjà ; ceux qui
// arrivent ensuite complètent les cellules (fillActions). Pas en Échange : une version n'y est écrite qu'avec tous ses fichiers (voir
// `waiting`), une cellule complétée repartirait comme une modification d'ici.
function fillWrites(ctx, entry, { tableRows, rows, destRows, fileCols, present, links, lookups, created }) {
  const presentKeys = new Set([...present.keys()].map(short));
  return [
    ...(ctx.exchange ? [] : fillActions({
      journalRows: tableRows, destRows, copyCols: fileCols, present, destTable: entry.dest, arrived: new Set((entry.waiting || []).filter(k => presentKeys.has(k))),
    })),
    ...fillLinks({ journalRows: tableRows, destRows, specs: links, lookups, destTable: entry.dest }),
    // Colonnes que la personne vient d'accepter (voir structure.js) : leurs valeurs, déjà reçues, y sont mises.
    ...backfillActions({ journalRows: rows, destRows, specs: created, destTable: entry.dest }),
  ];
}

// Ce que la destination montre après la recopie : numéros de ligne, retouches à la main, lignes en attente, écarts d'un refus, fichiers.
function rememberRead(ctx, key, { rows, after, copyCols, plan, files }) {
  lastRead.set(key, {
    numbers: rowNumbers(after), drift: manualEdits({ journalRows: rows, destRows: after, copyCols, exchange: ctx.exchange, except: plan.gone }),
    pending: plan.pending, gaps: ctx.review ? refusedGaps({ journalRows: rows, destRows: after, copyCols }) : [], files: files.card,
  });
}

// Pour chaque table d'ici visée par une Référence : ses lignes (voir targetRows).
async function linkLookups(specs) {
  const targets = [...new Set(specs.map(s => s.target))];
  return new Map(await Promise.all(targets.map(async target => [target, targetRows(await fetchRows(target))])));
}

// La destination n'est relue que si le journal de cette table a changé depuis le dernier passage
// resté sans effet (ou qu'un fichier est arrivé), ou pour y revoir les retouches (REREAD_MS).
function unchanged(key, signature) {
  const was = settled.get(key);
  return Boolean(was && was.signature === signature && Date.now() - was.at < REREAD_MS && lastRead.has(key));
}

// Recopie d'une table, planifiée (voir planConsolidation) : les suppressions de la SOURCE sont
// appliquées telles quelles (la CIBLE est passive), sauf en archive (rien n'y est effacé).
function planTable(ctx, entry, { rows, destRows, copyCols, waiting }) {
  return planConsolidation({
    journalRows: rows, destRows, copyCols, destTable: entry.dest, journalTable: ctx.journal, matchCol: entry.match || '',
    exchange: ctx.exchange, hub: ctx.hub, rules: ctx.rules, decisions: ctx.decisions, waiting,
    deleteCol: ctx.schema.columns(entry.dest).some(c => c.colId === DELETE_COL),
    now: nowS(), archive: ctx.archive,
  });
}

// Écrit la recopie d'une table et les cellules complétées par un fichier arrivé ; rend vrai si la
// destination a changé. Échange : la ligne 'echange' de l'export est touchée dans le même lot (voir
// syncFormulas) : les lignes reçues ne repartent pas vers l'autre document. Un refus corrigé, au
// contraire, fait repartir la ligne d'ici : à part, puis demandé au lot.
async function writeTable(ctx, entry, { actions, stats, fix }, fill) {
  const written = stats.added + stats.updated + stats.removed > 0;
  await apply([...(ctx.swap && written ? [['UpdateRecord', SYNC_TABLE, ctx.swap.id, { [RESEND_COL]: randomHex(4) }]] : []), ...actions, ...fill]);
  if (fix.actions.length) {
    await apply(fix.actions);
    await askResend(ctx.lots.get(entry.dest), entry.dest, fix.keys);
  }
  return written || fix.actions.length > 0 || fill.length > 0;
}

// Refus corrigé : le lot de la table (`lot`, ligne de Synchro) envoie les lignes corrigées, quoi
// qu'il en soit de leur heure (Synchro_Renvoi, comme un renvoi). La demande est effacée plus tard
// (voir clearFixMarks).
async function askResend(lot, dest, keys) {
  if (!lot || !keys.length) return;
  const wanted = new Set(keys);
  const ids = (await fetchRows(dest)).filter(r => wanted.has(r[KEY_COL])).map(r => r.id);
  if (ids.length) await apply([['UpdateRecord', SYNC_TABLE, lot.id, { [RESEND_COL]: resendValue(`${FIX_MARK}${Math.floor(nowS())}`, ids) }]]);
}

async function clearFixMarks(lots) {
  const now = nowS();
  const age = value => { const m = FIX_VALUE.exec(String(value || '')); return m ? now - Number(m[1]) : -1; };
  const stale = lots.filter(lot => age(lot[RESEND_COL]) > FIX_HOLD_S);
  if (stale.length) await apply(stale.map(lot => ['UpdateRecord', SYNC_TABLE, lot.id, { [RESEND_COL]: '' }]));
}

// Contexte de la recopie d'un journal. Échange : la ligne 'echange' de l'export et, côté du
// document qui a invité (`review`), les colonnes que son export envoie par table, s'il administre
// un Échange à plusieurs (`hub`), ses règles pour les changements reçus (`rules`), les décisions
// prises sur la carte (`decisions`) et les lots de l'export, par table (`lots`). Voir
// planConsolidation.
async function copyContext(schema, journal, note, groups) {
  const exchange = note.mode === 'echange';
  const review = exchange && Boolean(note.retour);
  const rows = exchange ? await syncRows(schema) : [];
  const own = review ? new Map(exportTables(rows, note.export).map(tb => [tb.table, new Set(tb.columns.map(c => c.id))])) : null;
  const swap = rows.find(r => r[EXPORT_COL] === note.export && r[TYPE_COL] === KIND.swap) || null;
  const lots = new Map(rows.filter(r => r[EXPORT_COL] === note.export && r[TYPE_COL] === KIND.lot).map(r => [r[TABLE_COL], r]));
  if (review) await clearFixMarks([...lots.values()]);
  const prefix = `${journal}|`;
  return {
    schema, journal, groups, exchange, swap, review, lots, rows, mode: note.mode, archive: Boolean(note.archive) && !exchange, ask: Boolean(note.ask) && !exchange,
    dests: new Map(note.tables.map(tb => [tb.table, tb])),
    hub: Boolean(review && swap && swap[SCHEMA_COL] === HUB),
    rules: review ? exchangeRules(readSourceNote(schema).exports.find(e => e.id === note.export)) : null,
    decisions: new Map([...choices].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [Number(k.slice(prefix.length)), v])),
    allowedFor: dest => (own ? own.get(dest) || new Set() : null),
  };
}

// Notes des tables changées (destination renommée, colonnes arrivées après coup). Échange, côté
// CIBLE : l'export de retour suit (voir followExchange).
// Fusionné dans la note relue au moment d'écrire : une table rangée ou une colonne de nom choisie
// pendant le passage (fenêtres de l'onglet) reste.
async function saveEntries(journal, updates) {
  if (!updates.size) return;
  const noted = ({ dest, map, match, refs, dropped, addedCols, waiting, own, linked, styled, sourceDoc, sends, described, laid, tabled, ack, adopted }) => JSON.parse(JSON.stringify({
    dest, map, match, refs, dropped, addedCols, waiting, own, linked, styled, sourceDoc, sends, described, laid, tabled, ack, adopted,
  }));
  const merged = n => ({ ...n, tables: n.tables.map(tb => (updates.has(tb.table) ? { ...tb, dropped: undefined, waiting: undefined, sends: undefined, ...noted(updates.get(tb.table)) } : tb)) });
  await followExchange(await updateJournalNote(journal, merged));
}

// Échange, côté CIBLE : l'export de retour envoie les destinations de la note, avec leurs colonnes.
// Seul un propriétaire peut le changer (Synchro lui est réservée, voir acl.js) : après le passage
// d'un éditeur, celui d'un propriétaire le remet d'accord (`rows` : lignes de Synchro déjà lues).
async function followExchange(note, rows = null) {
  if (note.mode !== 'echange' || note.retour || !(await isOwner().catch(() => false))) return;
  if (rows) {
    const schema = await readSchema();
    const want = returnExportTables(note, schema);
    if (exportShape(exportTables(rows, note.export)) === exportShape(want)) return;
  }
  await wireExchange(note);
}

// « Corriger » : une table reçue reprend l'état exact de la SOURCE (la dernière version reçue de
// chaque ligne), relu au moment du clic : les colonnes effacées ici sont recréées, les lignes
// effacées reviennent, les cellules retouchées reprennent leur valeur. La carte suit aussitôt.
export async function restoreSource(journal, table) {
  const key = tableKey(journal, table);
  const result = state.results.get(key);
  if (!result || !result.copyCols) return;
  const { dest, labelCol, types = {}, droppedCols = [], links = [] } = result;
  const copyCols = [...result.copyCols, ...droppedCols];
  await withLock('gristsync-consolidation', async () => {
    if (droppedCols.length) {
      const columns = droppedCols.map(([from]) => ({ id: from, type: types[from] || 'Any', label: from }));
      await apply(addDestColumnsActions(await readSchema(), dest, columns, Object.fromEntries(droppedCols)));
      await updateJournalNote(journal, n => ({ ...n, tables: n.tables.map(tb => (tb.table === table ? { ...tb, dropped: undefined } : tb)) }));
    }
    const fileCols = copyCols.filter(([from]) => types[from] === 'Attachments').map(([from]) => from);
    const schema = await readSchema();
    const { note } = receivedJournals(schema).find(r => r.journal === journal);
    const { seal } = await sealing(schema, journal, note);
    const rows = (await trusted(journal, note, await fetchRows(journal), seal)).rows;
    const journalRows = resolveLinks(resolveRows(rowsByTable(expandRows(rows)).get(table) || [], fileCols, fileCols.length ? await attachments() : new Map()), links, await linkLookups(links));
    await apply(restoreActions(manualEdits({ journalRows, destRows: await fetchRows(dest), copyCols }), dest, copyCols));
    const after = await fetchRows(dest);
    const drift = manualEdits({ journalRows, destRows: after, copyCols });
    lastRead.set(key, { numbers: rowNumbers(after), drift });
    state.results.set(key, { ...state.results.get(key), copyCols, ...driftResult(drift, labelCol, []) });
  });
}

// Recopie de chaque table rangée (`changed` : son entrée de la note a changé). Une table dont une
// colonne garde un lien vers une autre (voir linkColumns) passe après celle-ci, qui lui donne les
// numéros des lignes visées ; rendues dans l'ordre de la note.
async function copyTables(ctx, note, owner) {
  const done = new Map();
  const locked = Boolean(note.verrou) && !ctx.exchange && !owner;
  const linking = tb => !ctx.exchange && sentColumns(ctx.groups.get(tb.table) || [], tb.columns || []).some(c => c.link);
  for (const noted of [...note.tables].sort((a, b) => linking(a) - linking(b))) {
    const copied = locked ? { entry: noted, locked: true, stats: { added: 0, updated: 0, removed: 0 } } : await copyTable(ctx, noted);
    ctx.dests.set(noted.table, copied.entry);
    done.set(noted.table, { ...copied, changed: !copied.error && JSON.stringify(copied.entry) !== JSON.stringify(noted) });
  }
  return note.tables.map(noted => done.get(noted.table));
}

// Manques signalés par table (voir tally.js) : { table: { expected, got, gap } }. Les comptes se lisent
// dans les versions du journal ; un manque n'est dit qu'après avoir duré (`tallySeen`, en mémoire de
// la page). Rien quand des envois bruts attendent encore leur dépliage, en Échange, par lien public,
// en archive, ni pour une table dont l'écart est déjà expliqué (lignes à venir, trop grosses).
const tallySeen = new Map();
function tallyReport(journal, note, groups, pending) {
  const out = {};
  const off = pending || note.mode === 'echange' || note.mode === 'public' || note.archive;
  for (const tb of note.tables) {
    const explained = (note.missing || {})[tb.table] > 0 || ((note.big || {})[tb.table] || []).length > 0;
    const gap = off ? null : tallyGap((note.tally || {})[tb.table], groups.get(tb.table) || [], explained);
    if (tallyDue(tallySeen, tableKey(journal, tb.table), gap, nowS())) out[tb.table] = gap;
  }
  return out;
}

// Un passage sur un journal : déplier, recopier chaque table rangée, noter les tables proposées,
// nettoyer. Chaque étape est un seul lot d'écritures, donc tout ou rien. Tables reçues en lecture
// seule (`verrou`, voir acl.js) : seul un propriétaire (`owner`) les recopie ; pour les autres,
// le journal est déplié et les versions attendent.
async function consolidate(schema, { journal, note: noteBefore }, owner) {
  if (noteBefore.mode === 'public' && await pull(noteBefore, journal)) lastArrival = Date.now();
  const trust = await sealing(schema, journal, noteBefore);
  const unpacked = await unpack(journal, trust);
  let { note } = unpacked;
  if (note.ended && note.mode === 'echange' && !note.retour && !stopped.has(note.export)) {
    await stopReturn(note.export).then(() => stopped.add(note.export), () => {});
  }
  // Fichiers du document, lus une fois par passage et seulement s'il en faut.
  let present = null;
  const files = async () => (present ||= await attachments());
  const cited = citedFiles(unpacked.rows, note.tables.flatMap(tb => tb.waiting || []));
  // Échange : ce que le partenaire cite, il l'a (voir noteHeldFiles).
  await noteHeldFiles(journal, note, cited);
  const { rows, rejected } = await receiveFiles(journal, note.export, unpacked.rows, files, cited, !unpacked.left);
  if (rejected) {
    const suspect = nextSuspect(note.suspect, rejected, false, nowS());
    note = { ...note, suspect };
    await updateJournalNote(journal, n => ({ ...n, suspect }));
  }
  const groups = rowsByTable(expandRows(rows));
  const { pending, offers } = offersOf(groups, note);
  state.offers.set(journal, offers);
  const ctx = { ...await copyContext(schema, journal, note, groups), files, restyle: restyles.get(journal), approve: approvals.has(journal) };
  if (ctx.exchange && !ctx.review) await followExchange(note, ctx.rows);
  const tables = await copyTables(ctx, note, owner);
  await saveEntries(journal, new Map(tables.filter(tb => tb.changed).map(tb => [tb.entry.table, tb.entry])));
  // Le journal n'est relu que si la recopie y a écrit (marques des versions) : sinon, ses lignes
  // sont celles du dépliage, et une ligne arrivée depuis attend le passage suivant.
  const after = tables.some(tb => tb.wrote) ? (await trusted(journal, note, await fetchRows(journal), trust.seal)).rows : rows;
  await apply(planPurge(after, journal, { keep: pending, drop: note.refused }));
  // Lignes reçues laissées pour le passage suivant : il vient sans attendre la minute.
  if (unpacked.left) lastArrival = Date.now();
  const afterGroups = rowsByTable(expandRows(after));
  return {
    rows: after.length, note, tables: tables.map(tb => tableResult(tb, afterGroups, Math.max(state.lastVisit || 0, note.histo || 0))),
    tally: tallyReport(journal, note, rowsByTable(after), unpacked.left > 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Un passage sur tous les journaux

const summary = s => (s.added || s.updated || s.removed ? t('recv.result', s) : t('recv.result.none'));

// Résultat d'un passage noté pour l'onglet ; rend vrai si la carte change.
function notePass(journal, pass, before, offersBefore, at) {
  // Ce que la carte montre du journal : lignes manquantes, trop grosses, arrivées suspectes, fin.
  const gaps = JSON.stringify([pass.note.missing, pass.note.big, pass.note.suspect, pass.note.ended, pass.tally]);
  state.results.set(journal, { at, rows: pass.rows, gaps, tally: pass.tally });
  const tablesChanged = pass.tables.map(tb => noteTable(journal, tb, at)).some(Boolean);
  return tablesChanged || !before || Boolean(before.error) || !before.rows !== !pass.rows || before.gaps !== gaps
    || offersBefore !== JSON.stringify(state.offers.get(journal) || []);
}

// Résultat d'une table noté pour l'onglet ; rend vrai si sa carte change.
function noteTable(journal, tb, at) {
  const key = tableKey(journal, tb.table);
  const was = state.results.get(key);
  state.results.set(key, tb.error ? { at, error: true, text: errorText(tb.error) } : { at, text: tb.locked ? t('recv.lock.waiting') : summary(tb.stats), ...tb });
  return Boolean(tb.error) !== Boolean(was?.error) || wrote(tb.stats) || cardShape(was) !== cardShape(tb);
}

async function passAll() {
  let changed = false;
  lastPass = Date.now();
  choices = new Map(decided);
  let schema = await readSchema();
  let upgraded = false;
  for (const { journal } of receivedJournals(schema)) upgraded = (await upgradeJournal(schema, journal)) || upgraded;
  if (!state.readOnly) upgraded = (await moveNotes(schema)) || upgraded;
  if (upgraded) schema = await readSchema();
  watch.tables = new Set(receivedJournals(schema).flatMap(r => [r.journal, ...r.note.tables.map(tb => tb.dest)]));
  watch.pull = receivedJournals(schema).some(r => r.note.mode === 'public');
  const owner = await isOwner().catch(() => false);
  for (const received of receivedJournals(schema).filter(r => !awaitingPartner(r.note))) {
    const { journal } = received;
    const before = state.results.get(journal);
    const offersBefore = JSON.stringify(state.offers.get(journal) || []);
    const at = nowS();
    try {
      changed = notePass(journal, await consolidate(schema, received, owner), before, offersBefore, at) || changed;
      state.readOnly = state.viewer;
      schema = await readSchema();
    } catch (e) {
      state.readOnly = state.viewer || isAccessError(e);
      state.results.set(journal, { ...before, at, text: errorText(e), error: true });
      changed ||= !(before && before.error);
    }
  }
  for (const k of choices.keys()) decided.delete(k);
  choices = new Map();
  return changed;
}

// Décision prise sur la carte pour des changements à valider (versions du journal `journal`) :
// appliquée par un passage lancé aussitôt, ou par le suivant si un passage est déjà en cours.
export const decide = (journal, ids, choice) => applyDecisions(ids.map(id => `${journal}|${id}`), choice);

// « Reprendre depuis la SOURCE » : la prochaine recopie de ce journal remet sur ceux de la SOURCE les éléments
// demandés (`elements` : `style` = style des colonnes reçues et règles conditionnelles, voir replaceOptions et
// planRules ; `notes` = descriptions des colonnes ; `table` = description de la table, voir planNotes ; `layout` = ordre et
// colonnes cachées de la page de la table, voir planLayout ; `formulas` =
// formules de colonne, voir formulaColumns : l'écran ne le propose qu'à un propriétaire, après lecture).
// Un passage est lancé aussitôt ; le journal n'est refait qu'une fois.
const restyles = new Map();
// « Refaire les références » : les colonnes que la SOURCE envoie avec leur lien et qui sont restées du texte (déjà remplies
// quand le lien est arrivé) deviennent des Références, leurs cellules reprennent le lien envoyé (voir linkColumns).
export const relink = journal => restyle(journal, { links: true });
export async function restyle(journal, elements = { style: true, notes: true, table: true }) {
  restyles.set(journal, elements);
  try {
    while ((await consolidateAll({ reread: true })) === null) await sleep(DECIDE_RETRY_MS);
  } finally {
    restyles.delete(journal);
  }
}

// « Appliquer » sur la carte d'une réception qui demande l'accord (voir structure.js) : la prochaine recopie de ce journal crée les colonnes
// que la SOURCE a ajoutées et les remplit. `auto` : la réception les applique désormais toute seule (elle ne demande plus). Un passage est
// lancé aussitôt.
const approvals = new Set();
export async function approveStructure(journal, { auto = false } = {}) {
  if (auto) await updateJournalNote(journal, ({ ask, ...rest }) => rest);
  approvals.add(journal);
  try {
    while ((await consolidateAll({ reread: true })) === null) await sleep(DECIDE_RETRY_MS);
  } finally {
    approvals.delete(journal);
  }
}

// Décisions notées, puis un passage, dès que celui en cours est fini.
async function applyDecisions(keys, choice) {
  for (const key of keys) decided.set(key, choice);
  while ((await consolidateAll({ reread: true })) === null) await sleep(DECIDE_RETRY_MS);
}

// Un passage sur tous les journaux. Deux onglets du même navigateur ne recopient pas en même
// temps (verrou du navigateur) ; entre deux navigateurs, les écritures sont idempotentes.
// L'onglet n'est redessiné que si un passage a changé quelque chose. Rend vrai si c'est le cas,
// null si un passage était déjà en cours. `reread` : relire toutes les destinations.
export async function consolidateAll({ reread = false } = {}) {
  if (busy) return null;
  busy = true;
  if (reread) settled.clear();
  let changed = false;
  try {
    await readLastVisit();
    changed = await withLock('gristsync-consolidation', passAll);
  } catch (e) {
    // Document illisible (droits, réseau) : la boucle continue, le prochain passage réessaie.
    if (isAccessError(e)) state.readOnly = true;
    console.warn(e);
    noteError(e);
  } finally {
    busy = false;
  }
  if (changed) await onChange();
  return changed;
}
