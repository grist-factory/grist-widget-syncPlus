// Logique pure de la synchro (dossier engine/logic/) : ni DOM, ni `grist`, ni réseau. Tout ce qui décide
// (quelle version gagne, quoi écrire, quelle adresse accepter) y est, testé par tests/unit. Les
// autres modules lisent Grist, appellent ces fonctions et appliquent le résultat.
// Ici : les noms partagés par la SOURCE et la CIBLE, et de petits utilitaires.

// Colonnes ajoutées aux tables envoyées, et reçues dans les destinations.
export const KEY_COL = 'id_sync'; // clé stable, UUID posé à la création de la ligne
export const ORDER_COL = 'MajLe'; // heure de la dernière modification d'une valeur envoyée
// Heure du dernier recalcul de MajLe (formule ordinaire). Une annulation (Ctrl+Z) remet MajLe à sa
// valeur d'avant, mais Grist recalcule cette colonne : c'est ainsi que le lot repère une annulation.
export const RECALC_COL = 'RecalculLe';
export const DELETE_COL = 'Supprime'; // suppression logique, prise en compte si la table l'a
// Clé de la ligne visée par une colonne Référence conservée, dans le bloc de données d'une version.
export const LINK_PREFIX = 'Synchro_Cle_';
// CIBLE, réception en archive : case cochée sur une ligne effacée à la SOURCE, gardée ici.
export const ARCHIVE_COL = 'Supprimee_a_la_source';

// SOURCE : la seule table technique du widget, quel que soit le nombre d'exports et de tables.
// Chaque table d'un export y a ses lignes (voir KIND) ; le webhook d'un destinataire n'envoie que
// celles de son export. Son nom, comme celui des journaux (JOURNAL_PREFIX), porte le préfixe
// donné au démarrage du moteur (setTablePrefix) : sans préfixe, `Synchro` et `Journal_…`. Ce sont
// des liaisons vivantes (`let`) : tout code les lit au moment de l'appel, jamais à l'import. Les
// noms de colonnes, eux, ne changent pas : ils sont le protocole entre SOURCE et CIBLE.
export let SYNC_TABLE = 'Synchro';
export const EXPORT_COL = 'Synchro_Export'; // identifiant de l'export
export const TABLE_COL = 'Synchro_Table'; // table SOURCE (et, dans le journal, table d'origine d'une ligne)
export const TYPE_COL = 'Synchro_Type'; // voir KIND
export const SCHEMA_COL = 'Synchro_Colonnes'; // colonnes envoyées : [{ id, type, label }] en JSON
export const RESEND_COL = 'Synchro_Renvoi'; // lignes à renvoyer, écrites par le widget
export const LIST_COL = 'Synchro_Ids'; // ce qu'il faut envoyer de la liste des clés
export const LOT_COL = 'Synchro_Lot'; // lot : lignes récentes avec leurs colonnes, en JSON
export const AUTHOR_COL = 'Sync_Par'; // e-mail de la personne qui a ajouté la ligne (user.Email)
export const STATE_COL = 'Sync_Etat'; // CIBLE : effet de la version recopiée (ajout, modif, suppression)
// Le webhook envoie chaque ligne de Synchro entière, et un journal refuse une colonne qu'il n'a pas :
// la marque d'envoi coupé (lignes 'lot') et le suivi des clés (lignes 'suivi') reprennent donc le nom
// d'une colonne que tous les journaux ont déjà.
export const MISSING_COL = STATE_COL;
export const TRACK_COL = STATE_COL;
// Types de ligne. Les webhooks n'envoient que les listes et les lots ('cles', 'lot') ; le suivi des
// clés, le filtre de lignes, la liste des fichiers d'une table ('fichiers') et la ligne d'un export
// en Échange restent dans la SOURCE ; 'complet' et son empreinte ne sont lus que par le lien public.
// Une seule ligne 'charge', d'aucun export, suit les renvois du document (voir resend.js). Le widget
// SOURCE envoie lui-même au journal de la CIBLE la fin d'un envoi ('fin') et les morceaux des
// fichiers ('fichier', voir files.js).
// La ligne 'signature' d'un export garde, dans Synchro_Colonnes, la clé qui signe ses envois (voir
// trust.js) ; seuls les propriétaires la lisent (voir acl.js).
export const KIND = {
  keys: 'cles', lot: 'lot', full: 'complet', mark: 'empreinte', filter: 'filtre', track: 'suivi', swap: 'echange', load: 'charge', end: 'fin',
  files: 'fichiers', part: 'fichier', sign: 'signature',
};
// Échange à plusieurs : marque de la ligne 'echange' (dans Synchro_Colonnes, que le webhook n'envoie
// pas) quand l'export a au moins deux participants. Le document qui administre renvoie alors aux
// autres ce que chacun lui envoie (voir lotFormula).
export const HUB = 'plusieurs';

// CIBLE : un journal par export reçu, où le webhook dépose les lignes de Synchro.
export let JOURNAL_PREFIX = 'Journal_';

// Préfixe des tables du moteur (celles qu'il crée : Synchro, journaux, destinations proposées), donné
// une fois au démarrage. Vide par défaut : les noms d'avant, aucun document existant ne change.
// Une lettre majuscule d'abord (Grist met la première lettre d'une table en majuscule : un autre
// nom ne se retrouverait pas), puis des lettres, chiffres ou soulignés.
export let TABLE_PREFIX = '';
export const TABLE_PREFIX_RULE = /^(?:[A-Z][A-Za-z0-9_]{0,31})?$/;
export function setTablePrefix(prefix = '') {
  if (typeof prefix !== 'string' || !TABLE_PREFIX_RULE.test(prefix)) throw new Error(`préfixe de tables invalide : ${JSON.stringify(prefix)}`);
  TABLE_PREFIX = prefix;
  SYNC_TABLE = `${prefix}Synchro`;
  JOURNAL_PREFIX = `${prefix}Journal_`;
}

// Tables de la personne, que l'on peut envoyer ou choisir comme destination : pas celles du widget.
export const isUserTable = id => id !== SYNC_TABLE && !id.startsWith(`${SYNC_TABLE}_`) && !id.startsWith(JOURNAL_PREFIX);
export const APPLIED_COL = 'Sync_Applique'; // version déjà recopiée dans la destination
export const RECEIVED_COL = 'Sync_Recu'; // date d'arrivée de la ligne dans le journal (NOW())
export const DATA_COL = 'Synchro_Donnees'; // colonnes envoyées d'une ligne, en un bloc JSON
// CIBLE : ce que la recopie a remplacé, pour l'historique, en JSON : { v: valeurs d'avant des
// colonnes modifiées } pour une modification, { n: numéro de la ligne } pour une suppression.
export const BEFORE_COL = 'Sync_Avant';
// CIBLE : sceau d'une ligne dépliée par le widget (voir sealText, trust.js). Propre au journal,
// comme les colonnes ci-dessus : jamais dans Synchro.
export const SEAL_COL = 'Sync_Sceau';

// Clé de signature d'un destinataire (voir trust.js) : 32 caractères hexadécimaux. Clé publique
// ECDH P-256 d'une invitation ou d'une réponse : point non compressé de 65 octets, en base64url.
export const SIG_KEY = /^[0-9a-f]{32}$/;
export const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

// Les clés d'une table sont réparties en BUCKETS seaux selon leur CRC-32 (voir formulas.js).
export const BUCKETS = 256;
export const LIST_PREFIX = 'ids:'; // liste complète d'un seul tenant (montage 0.4, lien public)
export const RESEND_ALL = 1; // marque de renvoi : toute la table, lignes sans MajLe comprises

const CHUNK = 500; // lignes par action

// fetchTable renvoie des colonnes ({id: [...], Nom: [...]}) : on travaille en lignes.
export function toRows(columnar) {
  if (!columnar || !Array.isArray(columnar.id)) return [];
  const cols = Object.keys(columnar);
  return columnar.id.map((_, i) => Object.fromEntries(cols.map(c => [c, columnar[c][i]])));
}

export function chunk(items, size = CHUNK) {
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

// Applique `fn` à chaque élément, `limit` à la fois (sans jamais lancer tout d'un coup : 256 destinataires, 256
// requêtes en même temps vers l'instance). Rend les résultats dans l'ordre.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Éléments rangés par clé, dans leur ordre : Map(clé -> [éléments]).
export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export const isBlank = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

export const isTrue = value => value === true || value === 1
  || (typeof value === 'string' && ['true', 'oui', 'vrai', '1'].includes(value.trim().toLowerCase()));

export function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

// Notes du widget : un objet JSON porté par une colonne (métadonnées, que le webhook n'envoie pas).
// Il est dans les **options** de la colonne (`widgetOptions`, clé `NOTE_KEY`), pas dans sa
// description : pour un lecteur qui n'a pas le droit de lire la colonne, Grist vide ses options
// (`CensorshipInfo`, vérifié sur Grist 1.7.22) mais laisse sa description, que `_grist_Tables_column`
// rendait en clair au lien public. Depuis le moteur 3.0.0. Une note d'avant (dans la description)
// est encore lue tant qu'elle n'a pas été déplacée (voir legacyNoteActions, logic/note-store.js).
// `columnNote` rend la note (null si la colonne manque, ou si la note est vide ou illisible) ;
// `noteAction` est l'action qui l'écrit (null l'efface) : elle garde les autres clés des options et
// vide la description si c'était une note d'avant.
export const NOTE_KEY = 'syncNote';
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionsOf = column => {
  const options = parseJson((column && column.widgetOptions) || 'null');
  return isObject(options) ? options : {};
};
const legacyNoteOf = (column) => {
  const note = parseJson((column && column.description) || 'null');
  return isObject(note) ? note : null;
};
export function columnNote(column) {
  const note = optionsOf(column)[NOTE_KEY];
  return isObject(note) ? note : legacyNoteOf(column);
}
// Note d'avant la 3.0.0 d'une colonne (dans sa description), ou null.
export const legacyNote = legacyNoteOf;
export const hasNoteOption = column => isObject(optionsOf(column)[NOTE_KEY]);
export function noteAction(column, note) {
  const options = { ...optionsOf(column) };
  if (note == null) delete options[NOTE_KEY];
  else options[NOTE_KEY] = note;
  const fields = { widgetOptions: Object.keys(options).length ? JSON.stringify(options) : '' };
  if (legacyNoteOf(column)) fields.description = '';
  return ['UpdateRecord', '_grist_Tables_column', column.id, fields];
}

// Horloge et attente, pour les modules qui lisent ou écrivent (la logique pure reçoit l'heure en
// paramètre). Heure en secondes, comme Grist.
export const nowS = () => Date.now() / 1000;
export const sleep = ms => new Promise((resolve) => { setTimeout(resolve, ms); });

export const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const randomHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));
// Empreinte (`algo` : 'SHA-256', 'SHA-1') d'octets, en octets ; d'un texte, en hexadécimal.
export const digest = async (algo, bytes) => new Uint8Array(await crypto.subtle.digest(algo, bytes));
export const sha256 = async text => toHex(await digest('SHA-256', new TextEncoder().encode(text)));

export const COL_ID = /^[A-Za-z_][A-Za-z0-9_]*$/; // identifiant de table ou de colonne Grist
export const HEX16 = /^[0-9a-f]{16}$/; // identifiant d'export ou d'invitation
// Contrôle d'une valeur lue dans un code ou un journal : `RegExp.test` changerait un tableau ou
// `undefined` en texte.
export const is = (re, value) => typeof value === 'string' && re.test(value);

// Types de colonnes qu'un export envoie (une Référence part en texte, une pièce jointe en liste de fichiers, voir
// files.js ; un rang ou un identifiant de ligne en nombre, voir `sentType` de exports.js). Tout autre type (Blob) ne part pas.
export const SENT_TYPE = /^(Any|Attachments|Bool|Choice|ChoiceList|Date|DateTime(:[A-Za-z0-9_/+-]+)?|Int|Numeric|Text)$/;
// Identifiant reçu d'ailleurs (code, journal) : valide pour Grist, et pas un nom propre aux objets
// JavaScript (`__proto__`, `constructor`…), qui servira de clé.
export const isSafeId = value => is(COL_ID, value) && !(value in Object.prototype);

// Identifiant de table Grist valide à partir d'un nom libre.
export function toTableId(name, fallback = 'Table') {
  let id = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
  if (/^[0-9]/.test(id)) id = 'T_' + id;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Identifiant d'une table de destination que le moteur crée d'après un nom libre : le préfixe des
// tables du moteur, puis le nom. Un nom donné tel quel (une table existante) ne passe pas par ici.
export const destTableId = (name, fallback = 'Table') => TABLE_PREFIX + toTableId(name, fallback);

// Premier identifiant libre : `base`, puis `base_2`, `base_3`… Grist ne distingue pas les
// majuscules d'un identifiant à l'autre (`ANNUAIRE` prendrait la place d'`Annuaire`) : la
// comparaison non plus.
// Nom libre du journal d'un export, d'après le nom de l'export.
export const journalId = (name, taken) => freeTableId(JOURNAL_PREFIX + toTableId(name, 'Export'), taken);

export function freeTableId(base, taken) {
  const used = new Set(taken.map(id => id.toLowerCase()));
  const free = id => !used.has(id.toLowerCase());
  if (free(base)) return base;
  let n = 2;
  while (!free(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// CRC-32 d'un texte en UTF-8, comme zlib.crc32(texte.encode()) dans les formules Python.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Seau d'une clé : les premiers bits de son CRC-32.
export const bucketOf = key => Math.floor(crc32(String(key)) * BUCKETS / 2 ** 32);
