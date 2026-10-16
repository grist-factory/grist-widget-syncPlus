// Logique pure de la synchro (dossier logic/) : ni DOM, ni `grist`, ni réseau. Tout ce qui décide
// (quelle version gagne, quoi écrire, quelle adresse accepter) y est. Les
// autres modules lisent Grist, appellent ces fonctions et appliquent le résultat.
// Ici : les noms partagés par la SOURCE et la CIBLE, et de petits utilitaires.

// Colonnes ajoutées aux tables envoyées, et reçues dans les destinations.
export const KEY_COL = 'id_sync'; // clé stable, UUID posé à la création de la ligne
export const ORDER_COL = 'MajLe'; // heure de la dernière modification d'une valeur envoyée
// Heure du dernier recalcul de MajLe (formule ordinaire). Une annulation (Ctrl+Z) remet MajLe à sa
// valeur d'avant, mais Grist recalcule cette colonne : c'est ainsi que le lot repère une annulation.
export const RECALC_COL = 'RecalculLe';
export const DELETE_COL = 'Supprime'; // suppression logique, prise en compte si la table l'a

// SOURCE : la seule table technique du widget, quel que soit le nombre d'exports et de tables.
// Chaque table d'un export y a ses lignes (voir KIND) ; le webhook d'un destinataire n'envoie que
// celles de son export.
export const SYNC_TABLE = 'Synchro';
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
// clés, le filtre de lignes et la ligne d'un export en Échange restent dans la SOURCE ; 'complet' et
// son empreinte ne sont lus que par le lien public. Une seule ligne 'charge', d'aucun export, suit
// les renvois du document (voir resend.js).
export const KIND = { keys: 'cles', lot: 'lot', full: 'complet', mark: 'empreinte', filter: 'filtre', track: 'suivi', swap: 'echange', load: 'charge' };

// CIBLE : un journal par export reçu, où le webhook dépose les lignes de Synchro.
export const JOURNAL_PREFIX = 'Journal_';
// Tables de la personne, que l'on peut envoyer ou choisir comme destination : pas celles du widget.
export const isUserTable = id => id !== SYNC_TABLE && !id.startsWith('Synchro_') && !id.startsWith(JOURNAL_PREFIX);
export const APPLIED_COL = 'Sync_Applique'; // version déjà recopiée dans la destination
export const RECEIVED_COL = 'Sync_Recu'; // date d'arrivée de la ligne dans le journal (NOW())
export const DATA_COL = 'Synchro_Donnees'; // colonnes envoyées d'une ligne, en un bloc JSON

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

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const randomHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async text => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

export const COL_ID = /^[A-Za-z_][A-Za-z0-9_]*$/; // identifiant de table ou de colonne Grist
export const HEX16 = /^[0-9a-f]{16}$/; // identifiant d'export ou d'invitation
// Contrôle d'une valeur lue dans un code ou un journal : `RegExp.test` changerait un tableau ou
// `undefined` en texte.
export const is = (re, value) => typeof value === 'string' && re.test(value);
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

// Premier identifiant libre : `base`, puis `base_2`, `base_3`… Grist ne distingue pas les
// majuscules d'un identifiant à l'autre (`ANNUAIRE` prendrait la place d'`Annuaire`) : la
// comparaison non plus.
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
