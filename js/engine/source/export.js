// SOURCE : créer ou modifier un export, sans fenêtre. L'écran (js/source/export-wizard.js) recueille les
// choix de la personne (tables, colonnes, filtres, nom, règles) et appelle ceci ; GFS fait de même avec
// son écran. Ce fichier écrit dans le document (colonnes du widget dans les tables envoyées, table
// Synchro, note) et rend des données, jamais un nœud ni un texte d'écran.
import { nowS, randomHex } from '../logic/common.js';
import { exportEmail, exportableColumns, hookName, pruneRules, readTables, withDoc } from '../logic/exports.js';
import { tableNoteOf, withTableNote } from '../logic/descriptions.js';
import { withLayout } from '../logic/layout.js';
import { withFormulas } from '../logic/column-formulas.js';
import { docFormatOf } from '../logic/docformat.js';
import { linkTables } from '../logic/links.js';
import { hiddenTables } from '../logic/acl.js';
import { putExport } from '../logic/notes.js';
import { knownColumns } from '../logic/new-columns.js';
import { exchangeRules } from '../logic/consolidation.js';
import { STATES } from '../logic/journal.js';
import { fillKeyActions, missingSyncColumns, prepareSourceActions } from '../logic/formulas.js';
import { receivedDests } from '../logic/received.js';
import { apply, fetchRows, readSchema, renameWebhook } from '../port.js';
import { failure } from '../errors.js';
import { recordEvent, saveExport, syncRows, updateSourceNote } from './synchro.js';
import { resendTables } from './resend.js';

// Tables prêtes à partir (id_sync, MajLe…) et leurs colonnes choisies. Une table reçue (relais)
// garde la clé de son document d'origine : une ligne ajoutée ici à la main reste sans clé, donc
// locale (avec une clé, la prochaine liste de l'origine, qui ne la connaît pas, l'effacerait).
// Un seul instantané suffit : chaque étape ne touche que sa table, et les colonnes que le widget
// ajoute ne sont pas envoyables. `selection` : [{ table, columns: [identifiants cochés], filter }].
async function prepareTables(selection, links, { style = false, notes = false, tableNote = false, layout = false, formulas = false } = {}) {
  const schema = await readSchema();
  // Avec « la mise en forme des colonnes » : langue et monnaie du document, dites à la CIBLE (voir docformat.js).
  const doc = style ? docFormatOf(await fetchRows('_grist_DocInfo')) : null;
  // La description d'une table est celle de sa section de données brutes (voir descriptions.js).
  const sections = tableNote || layout ? await fetchRows('_grist_Views_section') : [];
  // La mise en page (ordre et colonnes cachées) est celle de la section de la page de chaque table (voir layout.js).
  const fields = layout ? await fetchRows('_grist_Views_section_field') : [];
  const relays = receivedDests(schema).map(d => d.dest);
  const tables = [];
  for (const { table, columns: picked, filter } of selection) {
    await apply(prepareSourceActions(table, missingSyncColumns(schema.columns(table))));
    if (!relays.includes(table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
    const columns = exportableColumns(schema.columns(table), { extras: style, doc, notes }).filter(c => picked.includes(c.id));
    const styled = style ? withDoc(pruneRules(columns), doc) : columns;
    const noted = tableNote ? withTableNote(styled, tableNoteOf(schema.table(table), sections)) : styled;
    const calculated = formulas ? withFormulas(noted, schema.columns(table)) : noted;
    tables.push({ table, columns: layout ? withLayout(calculated, schema.columns(table), schema.table(table), sections, fields) : calculated, filter: filter || null });
  }
  // `links` : un ensemble de refKey (le choix par colonne), ou vrai (toutes les Références, comme avant la 0.27).
  return linkTables(tables, links instanceof Set || Array.isArray(links) ? links : Boolean(links));
}

// Export partagé par lien public : rien de ce qu'une règle d'accès cache ne doit s'y ajouter.
async function refuseHidden(tables) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const hidden = hiddenTables(resources, rules, readTables(tables));
  if (hidden.length) throw failure('publicHiddenEdit', { tables: hidden.join(', ') });
}

// Nom et date de l'export dans la note SOURCE. Règles d'un Échange administré ici : notées
// seulement si elles ne sont pas toutes « Accepter ».
async function noteExport(rules, id, name, extra = {}) {
  const kept = rules ? exchangeRules({ regles: rules, refus: rules.refus }) : undefined;
  await updateSourceNote((note) => {
    const entry = { at: nowS(), ...note.exports.find(e => e.id === id), id, name, ...extra };
    if (rules) Object.assign(entry, { regles: kept ? Object.fromEntries(STATES.map(st => [st, kept[st]])) : undefined, refus: kept?.refus });
    return putExport(note, JSON.parse(JSON.stringify(entry)));
  });
}

// Crée l'export (`exp` absent) ou enregistre la modification de `exp`. `selection` : voir
// prepareTables (les tables ajoutées pour un lien y sont, avec leur seule colonne affichée, voir linkOffers) ;
// `links` : les colonnes Référence ou Liste de références qui gardent leur lien (ensemble de `refKey`, choix de
// l'étape Colonnes) ou `true` (toutes les Références qui visent une table de l'export) ; `style` : envoyer la
// mise en forme des colonnes (en-têtes, règles conditionnelles, monnaie, langue du document), `notes` : leurs
// descriptions, `autoCols` : envoyer seul les colonnes ajoutées ensuite aux tables (voir new-columns.js), `tableNote` : celle de chaque table, `layout` : l'ordre et les colonnes cachées de la page de chaque table (voir layout.js), `formulas` : leurs formules de colonne, que la CIBLE ne pose que
// sur le clic d'un propriétaire (cases de l'étape Colonnes, jamais en Échange ; voir column-formulas.js) ; `rules` : règles d'un Échange administré ici ({ ajout, modif,
// suppression, refus }), ou rien. Rend
// `{ id, name, tables, changed, created }` : `changed` = les tables qu'il faut renvoyer (modification),
// `created` = l'export tel que l'écran de ses destinataires l'attend (création).
export async function saveChosenExport({ exp = null, name, selection, links = false, style = false, notes = false, tableNote = false, layout = false, formulas = false, rules = null, autoCols = false }) {
  const sends = !exp?.echange;
  const tables = await prepareTables(selection, links, { style: style && sends, notes: notes && sends, tableNote: tableNote && sends, layout: layout && sends, formulas: formulas && sends });
  if (exp?.public) await refuseHidden(tables);
  const id = exp ? exp.id : randomHex(8);
  const changed = await saveExport(id, tables, { isPublic: Boolean(exp?.public), swap: Boolean(exp?.echange) });
  // `known` : les colonnes envoyables de ces tables à cet instant, envoyées ou non (voir new-columns.js) ; `autoCols` : l'export envoie seul
  // celles qui viendront (jamais en Échange).
  await noteExport(rules, id, name, { known: knownColumns(await readSchema(), tables), autoCols: autoCols && sends ? true : undefined });
  const created = exp ? null : { id, name, tables, recipients: [], invitations: [], public: false, email: exportEmail(await syncRows(), id) };
  return { id, name, tables, changed, created };
}

// Après l'enregistrement d'un export modifié : l'événement de l'historique, les webhooks renommés si le
// nom a changé, les tables changées renvoyées (par tranches : `progress` en reçoit l'avancement, voir
// resendTables). Rend le nombre de lignes renvoyées, ou null si le renvoi attend son tour.
export async function finishEdit(exp, { name, changed }, progress) {
  await recordEvent(exp.id, changed.length ? 'editSent' : 'edit', { n: changed.length });
  if (name !== exp.name) for (const h of exp.recipients) await renameWebhook(h.id, hookName(name, exp.id));
  return changed.length ? resendTables(exp.id, changed, progress) : 0;
}
