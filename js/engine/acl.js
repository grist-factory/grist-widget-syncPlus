// Règles d'accès du widget (voir logic/acl.js), remises d'accord avec le document par un
// propriétaire : seul un propriétaire peut les changer, et chaque changement fait recharger le
// document (donc le widget). Elles ne sont donc réécrites que si elles diffèrent, et jamais pendant
// un assistant (un rechargement le fermerait). Rend vrai si elles ont changé : l'onglet attend
// alors le rechargement (voir reloading dans ui.js).
import { KEY_COL, isUserTable } from './logic/common.js';
import { foreignSync, ownsSync } from './logic/strays.js';
import { LOCK_MEMO, OWNER_MEMO, aclActions, currentRules, isPublicRule, journalAclRules, keyAclRules, lockAclRules, lockMirrors, lockedTables, ownerAclRules, publicAclRules } from './logic/acl.js';
import { failure } from './errors.js';
import { apply, fetchRows, page, readSchema } from './port.js';
import { updateJournalNote } from './target/journals.js';
import { receivedJournals, signedTables } from './logic/received.js';
import { createSyncTable, readSourceNote } from './source/synchro.js';

// `publicIds` : exports partagés par lien public, et `open` : le document est-il public (vrai,
// faux, ou null si on ne sait pas). Sans eux (onglet Recevoir), les règles du lien public restent
// telles quelles. Les journaux dont la note le demande (`reserve`) sont cachés aux lecteurs, et les
// tables reçues d'une réception verrouillée (`verrou`, jamais en Échange) en lecture seule pour
// tous sauf les propriétaires. La colonne id_sync des tables qui portent une clé de signature est
// cachée aux lecteurs, pour que la clé ne se lise pas dans les métadonnées du document.
// `force` : poser les règles même pendant un assistant (voir protectSync, seul à le demander) ; `strict` : lever
// l'erreur de Grist au lieu de la garder (voir ruleRefusal).
export async function syncRules({ publicIds = null, open = null, release = [], force = false, strict = false } = {}) {
  if (page.busy() && !force) return false;
  const [schema, resources, rules] = await Promise.all([readSchema(), fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const current = currentRules(resources, rules);
  const publicPart = publicIds === null || open === null
    ? current.filter(isPublicRule).filter(r => r.tableId === '*' || schema.has(r.tableId))
    : publicAclRules(publicIds, { keepDeny: Boolean(open) && current.some(isPublicRule) });
  const journals = receivedJournals(schema).filter(r => r.note.reserve).map(r => r.journal);
  const exchanges = readSourceNote(schema).exports.filter(e => e.echange).map(e => e.id);
  const lockable = receivedJournals(schema).filter(r => r.note.mode !== 'echange');
  const eligible = d => isUserTable(d) && schema.has(d) && schema.columns(d).some(c => c.colId === KEY_COL);
  const destsOf = list => list.flatMap(r => r.note.tables.map(tb => tb.dest)).filter(eligible);
  const locked = lockedTables({
    asked: destsOf(lockable.filter(r => r.note.verrou)), current: current.filter(r => r.memo === LOCK_MEMO).map(r => r.tableId),
    received: new Set(destsOf(lockable)), released: release,
  });
  const wanted = [...publicPart, ...(ownsSync(schema) ? ownerAclRules(exchanges) : []), ...journalAclRules(journals), ...keyAclRules(signedTables(schema)), ...lockAclRules(locked)];
  const actions = aclActions(resources, rules, wanted, id => !schema.has(id));
  if (!actions.length) {
    refusal = null;
    // Règles en place : chaque journal réservé le note, pour l'onglet d'un éditeur (qui ne lit pas
    // les règles d'accès, voir receivedGroups).
    for (const { journal } of receivedJournals(schema).filter(r => r.note.reserve && !r.note.reserved)) {
      await updateJournalNote(journal, n => ({ ...n, reserved: true }));
    }
    // La lecture seule se lit aussi dans la note (la carte d'un éditeur ne lit pas les règles) : une
    // note réécrite par un éditeur est remise d'accord avec la règle.
    for (const journal of lockMirrors(lockable, locked)) await updateJournalNote(journal, n => ({ ...n, verrou: true }));
    return false;
  }
  try {
    await apply(actions);
  } catch (e) {
    // Une règle d'autrui nomme une colonne absente, par exemple : Grist refuse tout changement, et les
    // tables du widget restent sans leurs règles. Le refus est gardé (ruleRefusal) pour que l'onglet le dise.
    console.warn(e);
    refusal = refusalText(e);
    if (strict) throw failure('rulesRefused', { why: refusal });
    return false;
  }
  refusal = null;
  return true;
}

// Texte du dernier refus de Grist à poser les règles du widget (« Invalid columns in rules for table Contacts: Prenom »),
// ou null si les dernières ont été posées (ou n'avaient pas à l'être). Les onglets le montrent aux propriétaires.
let refusal = null;
export const ruleRefusal = () => refusal;
function refusalText(e) {
  const text = String((e && e.message) || e || '');
  const found = /"error":"([^"]+)"/.exec(text);
  return (found ? found[1] : text).replace(/\s+/g, ' ').slice(0, 300);
}

// Avant la première donnée d'un export : la table Synchro est créée vide si elle manque, et ses règles d'accès sont
// posées tout de suite, assistant ou non. Sans cela, la première ligne d'export (copie des colonnes envoyées, y compris
// celles qu'une règle cache aux lecteurs) restait lisible par toute personne qui a accès au document, lien public compris,
// jusqu'à la fermeture du premier assistant. Grist recharge alors le document, donc le widget : l'écran appelle protectSync
// AVANT d'ouvrir l'assistant. Rend vrai si des règles viennent d'être posées (le document se recharge) ; lève
// `rulesRefused` si Grist les refuse, ou `syncTableForeign` si la table Synchro n'est pas celle du widget : aucun export
// ne s'écrit alors sans règles.
export async function protectSync() {
  const schema = await readSchema();
  if (foreignSync(schema)) throw new Error('syncTableForeign');
  const created = await createSyncTable([], schema);
  const posted = await syncRules({ force: true, strict: true });
  return created || posted;
}

// Les règles des propriétaires sur Synchro manquent-elles (table absente, ou règle pas encore posée) ? Rien n'est écrit. Pour
// un écran qui doit prévenir avant d'écrire une première ligne dans Synchro sans passer par un export de cette SOURCE (voir
// protectSync) : un Échange reçu renvoie à la SOURCE des tables de ce document, par Synchro.
export async function syncUnprotected() {
  const [schema, resources, rules] = await Promise.all([readSchema(), fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  if (foreignSync(schema)) return false; // refusé ailleurs (syncTableForeign)
  return !ownsSync(schema) || !currentRules(resources, rules).some(r => r.memo === OWNER_MEMO);
}
