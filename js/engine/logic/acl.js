// Règles d'accès posées par le widget, toutes reconnues à leur mémo : le widget ne touche jamais aux
// autres. Elles passent avant les règles existantes, dans l'ordre où elles sont listées ici (la
// lecture du lien public avant la réserve aux propriétaires, sur la même table).
//  - Lien public : les lecteurs (dont le lien public) ne lisent que les lignes 'complet' et
//    'empreinte' des exports publics dans Synchro, sans la colonne Synchro_Export (sa description
//    est la note de la SOURCE : noms des exports, invitations en attente ; vérifié). Le filtre sur
//    cette colonne marche encore (vérifié). Sans export public, `keepDeny` garde le refus général
//    tant que le document reste partagé publiquement.
//  - Synchro réservée aux propriétaires : ses formules lisent les tables sans les règles d'accès,
//    ses lots et ses listes montreraient à un lecteur ce que d'autres règles lui cachent, et un
//    éditeur y choisirait ce qui sort. Exception : la recopie d'un Échange par un éditeur lit les
//    lignes 'echange' et 'lot' (sans leur lot ni leurs listes) et écrit leur Synchro_Renvoi.
//  - Journaux réservés aux éditeurs : un journal garde les versions reçues et ce qu'elles ont
//    remplacé, quelles que soient les règles des tables de destination. La clé du formulaire y
//    écrit toujours (vérifié).
//  - Clé de signature cachée aux lecteurs : la colonne id_sync d'une table reçue porte la clé qui signe les
//    envois de son export (dans ses options, voir columnNote). Pour un lecteur qui ne la lit pas, Grist
//    en vide les options : la clé ne se lit plus dans `_grist_Tables_column` (vérifié). Les lecteurs
//    n'ont rien d'autre à faire d'id_sync, que la page de la table ne montre pas.
//  - Tables reçues en lecture seule (option d'une réception) : seuls les propriétaires y écrivent.
//    La recopie écrit avec les droits de la personne qui a la page ouverte : elle attend donc un
//    propriétaire (voir consolidate dans target/loop.js). Seul un propriétaire peut lever la règle :
//    une note de journal réécrite par un éditeur ne la retire pas (voir lockedTables).
import { EXPORT_COL, HEX16, KEY_COL, KIND, LIST_COL, LOT_COL, AUTHOR_COL, MISSING_COL, RESEND_COL, SYNC_TABLE, TYPE_COL } from './common.js';

export const PUBLIC_MEMO = 'Synchro : lecture limitée aux exports publics';
export const OWNER_MEMO = 'Synchro : réservée aux propriétaires';
export const JOURNAL_MEMO = 'Synchro : journaux réservés aux éditeurs';
export const LOCK_MEMO = 'Synchro : table reçue en lecture seule';
export const KEY_MEMO = 'Synchro : clé de signature cachée aux lecteurs';
const MEMOS = [PUBLIC_MEMO, OWNER_MEMO, JOURNAL_MEMO, LOCK_MEMO, KEY_MEMO];

export const isWidgetRule = r => MEMOS.includes(r.memo);
export const isPublicRule = r => r.memo === PUBLIC_MEMO;

const VIEWER = 'user.Access == VIEWER';
const EDITOR = 'user.Access == EDITOR';

// Règles voulues : [{ tableId, colIds, aclFormula, permissionsText, memo }], dans l'ordre.
export function publicAclRules(exportIds, { keepDeny = false } = {}) {
  const ids = exportIds.filter(id => HEX16.test(id)).sort();
  if (!ids.length && !keepDeny) return [];
  const rule = (tableId, colIds, aclFormula, permissionsText) => ({ tableId, colIds, aclFormula, permissionsText, memo: PUBLIC_MEMO });
  return [
    ...(ids.length ? [
      rule(SYNC_TABLE, EXPORT_COL, VIEWER, '-R'),
      rule(SYNC_TABLE, '*', `${VIEWER} and rec.${EXPORT_COL} in [${ids.map(id => `"${id}"`).join(', ')}] and rec.${TYPE_COL} in ["${KIND.full}", "${KIND.mark}"]`, '+R'),
    ] : []),
    rule('*', '*', VIEWER, '-R'),
  ];
}

// `exchangeIds` : exports en Échange. Un éditeur ne lit et ne marque (renvoi) que leurs lignes
// 'echange' et 'lot', pour la recopie ; ni celles des autres exports, ni la note.
export function ownerAclRules(exchangeIds = []) {
  const ids = exchangeIds.filter(id => HEX16.test(id)).sort().map(id => `"${id}"`).join(', ');
  // Sans Échange, un éditeur n'a rien à lire dans Synchro. Un refus sans condition de ligne cache aussi ses colonnes aux
  // métadonnées du document (Grist vide les options d'une colonne illisible) : la note de la SOURCE, dont la clé privée d'une
  // invitation en attente et les fiches des destinataires, ne se lit plus par un éditeur. Avec un Échange, les règles
  // ci-dessous (conditionnelles à la ligne) laissent lire les colonnes, donc la note, par les éditeurs.
  if (!ids) return [{ tableId: SYNC_TABLE, colIds: '*', aclFormula: 'user.Access != OWNER', permissionsText: '-CRUD', memo: OWNER_MEMO }];
  const EXCHANGE_ROWS = `${EDITOR} and rec.${EXPORT_COL} in [${ids}] and rec.${TYPE_COL} in ["${KIND.swap}", "${KIND.lot}"]`;
  const rule = (colIds, aclFormula, permissionsText) => ({ tableId: SYNC_TABLE, colIds, aclFormula, permissionsText, memo: OWNER_MEMO });
  return [
    rule(EXPORT_COL, VIEWER, '-R'),
    rule([LOT_COL, LIST_COL, MISSING_COL, AUTHOR_COL].join(','), EDITOR, '-RU'),
    rule(RESEND_COL, EXCHANGE_ROWS, '+RU'),
    rule('*', EXCHANGE_ROWS, '+R'),
    rule('*', 'user.Access != OWNER', '-CRUD'),
  ];
}

export const journalAclRules = journals => [...journals].sort()
  .map(tableId => ({ tableId, colIds: '*', aclFormula: VIEWER, permissionsText: '-R', memo: JOURNAL_MEMO }));

// `tables` : tables reçues dont la colonne id_sync porte une clé de signature (voir signedTables).
export const keyAclRules = tables => [...new Set(tables)].sort()
  .map(tableId => ({ tableId, colIds: KEY_COL, aclFormula: VIEWER, permissionsText: '-R', memo: KEY_MEMO }));

export const lockAclRules = tables => [...new Set(tables)].sort()
  .map(tableId => ({ tableId, colIds: '*', aclFormula: 'user.Access != OWNER', permissionsText: '-CUD', memo: LOCK_MEMO }));

// Tables en lecture seule voulues. La règle déjà posée fait foi : la note d'un journal, qu'un éditeur
// peut réécrire, peut en demander (`asked`) mais pas en retirer, tant que la table est reçue
// (`received`). Seul un propriétaire lève la lecture seule (`released`, par l'option de la carte). Une
// table qui n'est plus reçue perd sa règle.
export function lockedTables({ asked, current, received, released = [] }) {
  const lifted = new Set(released);
  return [...new Set([...asked, ...current.filter(table => received.has(table))])].filter(table => !lifted.has(table)).sort();
}

// Journaux dont la note ne demande plus la lecture seule alors que la règle de l'une de leurs
// destinations est en place (note réécrite par un éditeur) : la note est remise d'accord.
export const lockMirrors = (journals, locked) => journals.filter(({ note }) => !note.verrou && note.tables.some(tb => locked.includes(tb.dest))).map(r => r.journal);

// Une règle, telle que la compare syncRules (sa ressource lue dans `resources` si besoin).
export const ruleText = ({ tableId, colIds, aclFormula, permissionsText, memo }) => `${tableId}|${colIds}|${aclFormula}|${permissionsText}|${memo || ''}`;
export const currentRules = (resources, rules) => rules.filter(isWidgetRule).sort((a, b) => (a.rulePos || 0) - (b.rulePos || 0))
  .map(r => ({ ...(resources.find(x => x.id === r.resource) || {}), ...r }));

// Actions qui remplacent les règles du widget par `wanted`, dans cet ordre, avant toutes les autres.
// `resources`, `rules` : lignes de _grist_ACLResources et _grist_ACLRules. Rien si elles sont déjà
// là, dans le même ordre (changer une règle fait recharger le document). Les ressources d'une table
// effacée (`missing`) dont plus aucune règle ne se sert partent aussi : Grist refuse tout changement
// de règle tant qu'une ressource nomme une table absente (vérifié). Les règles partent en un seul
// BulkAddRecord : Grist range chaque ajout avant la première position plus grande que la sienne, et
// ses positions sont positives, donc des AddRecord successifs à positions négatives s'inversaient
// (vérifié : le document se rechargeait à chaque affichage).
export function aclActions(resources, rules, wanted, missing = () => false) {
  if (currentRules(resources, rules).map(ruleText).join('\n') === wanted.map(ruleText).join('\n')) return [];
  const mine = rules.filter(isWidgetRule);
  const others = new Set(rules.filter(r => !isWidgetRule(r)).map(r => r.resource));
  const free = resources.filter(r => r.tableId !== '*' && missing(r.tableId) && !others.has(r.id)).map(r => r.id);
  const actions = [['BulkRemoveRecord', '_grist_ACLRules', mine.map(r => r.id)], ['BulkRemoveRecord', '_grist_ACLResources', free]].filter(a => a[2].length);
  const kept = resources.filter(r => !free.includes(r.id));
  let pos = Math.min(0, ...rules.filter(r => !isWidgetRule(r)).map(r => r.rulePos || 0)) - wanted.length - 1;
  let newRef = 0;
  const added = [];
  const resourceFor = (tableId, colIds) => {
    const found = kept.find(r => r.tableId === tableId && r.colIds === colIds) || added.find(r => r.tableId === tableId && r.colIds === colIds);
    if (found) return found.id;
    added.push({ id: --newRef, tableId, colIds });
    actions.push(['AddRecord', '_grist_ACLResources', newRef, { tableId, colIds }]);
    return newRef;
  };
  const resource = wanted.map(w => resourceFor(w.tableId, w.colIds));
  if (wanted.length) {
    actions.push(['BulkAddRecord', '_grist_ACLRules', wanted.map(() => null), {
      resource, aclFormula: wanted.map(w => w.aclFormula), permissionsText: wanted.map(w => w.permissionsText),
      rulePos: wanted.map(() => ++pos), memo: wanted.map(w => w.memo),
    }]);
  }
  return actions;
}

// Lien public : tables de `tables` dont une règle d'accès (hors règles du widget) cache des lignes ou
// des colonnes, à quelqu'un ou à tous ; une telle règle sur toutes les tables (`*`) les vise
// toutes. Les formules de Synchro lisent sans les règles : le lien public montrerait à tous ce
// qu'elles cachent.
const deniesRead = p => p === 'none' || /-[A-Z]*R/.test(p || '');
export function hiddenTables(resources, rules, tables) {
  const tableOf = id => (resources.find(r => r.id === id) || {}).tableId;
  const denied = new Set(rules.filter(r => !isWidgetRule(r) && deniesRead(r.permissionsText)).map(r => tableOf(r.resource)));
  return tables.filter(table => denied.has(table) || denied.has('*'));
}

// Les éditeurs peuvent-ils modifier la structure du document, donc les formules de Synchro (ce qui
// part) ? C'est le réglage par défaut de Grist ; la case « Permettre aux éditeurs de modifier la
// structure », décochée, ajoute à la ressource `*` une règle `user.Access != OWNER` → `-S`. La
// première règle de cette ressource qui vise les éditeurs et dit quelque chose du droit S décide ;
// une formule que Grist n'écrit pas lui-même ne dit rien.
const EDITOR_FORMULAS = ['', 'user.Access != OWNER', 'user.Access == EDITOR', 'user.Access in [EDITOR]', 'user.Access in [EDITOR, OWNER]', 'user.Access in [OWNER, EDITOR]'];
const structureSign = p => (p === 'all' ? '+' : p === 'none' ? '-' : (/([+-])[A-Z]*S/.exec(p || '') || [])[1]);
export function editorsEditStructure(resources, rules) {
  const defaults = new Set(resources.filter(r => r.tableId === '*' && r.colIds === '*').map(r => r.id));
  const decisive = rules.filter(r => defaults.has(r.resource) && structureSign(r.permissionsText)
    && EDITOR_FORMULAS.includes(String(r.aclFormula || '').replace(/\s+/g, ' ').trim()))
    .sort((a, b) => (a.rulePos || 0) - (b.rulePos || 0))[0];
  return !decisive || structureSign(decisive.permissionsText) === '+';
}
