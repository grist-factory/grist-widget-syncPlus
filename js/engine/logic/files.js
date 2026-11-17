// Pièces jointes. Une formule ne lit pas le contenu d'un fichier : le lot porte, pour chaque cellule
// d'une colonne Pièces jointes, la liste de ses fichiers ([empreinte, nom, taille] ; l'empreinte est
// le fileIdent de Grist, SHA-1 du contenu suivi d'une extension). Le widget SOURCE envoie le
// contenu, page ouverte, par le lien du formulaire de chaque destinataire, en morceaux (lignes
// 'fichier' de son journal) ; le widget CIBLE les rassemble, dépose le fichier et remplit les
// cellules. Un fichier se reconnaît des deux côtés au SHA-1 de son contenu : un fichier que la
// CIBLE a déjà n'est pas déposé deux fois.
import { APPLIED_COL, DELETE_COL, EXPORT_COL, KEY_COL, KIND, LOT_COL, RECEIVED_COL, SCHEMA_COL, TYPE_COL, chunk, digest, groupBy, is, isTrue, parseJson, toHex } from './common.js';
import { expandRows, latestByKey } from './journal.js';

export const FILE_MAX = 25 * 1024 * 1024; // octets par fichier, au plus
// Octets d'un morceau avant base64 : environ 700 ko envoyés, sous la limite de 1 Mo d'un envoi.
export const PART_BYTES = 512 * 1024;
const MAX_PARTS = Math.ceil(FILE_MAX / PART_BYTES);
const PART_TEXT_MAX = Math.ceil(PART_BYTES / 3) * 4;
const PART_TTL = 86400; // un envoi resté incomplet un jour ne s'achèvera plus (la SOURCE en refera un)
const SHA = /^[0-9a-f]{40}$/;
const SEND = /^[0-9a-f]{8}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Empreinte (SHA-1) d'un fileIdent de Grist, ou null.
export const shaOf = ident => (typeof ident === 'string' && SHA.test(ident.slice(0, 40)) ? ident.slice(0, 40) : null);
// Empreinte abrégée, telle que les notes la gardent.
export const short = sha => sha.slice(0, 16);

// ---------------------------------------------------------------------------------------------
// SOURCE

// Fichiers d'un export, lus dans ses lignes 'fichiers' (Synchro_Lot : { fileIdent: [numéro, nom,
// taille] }) : Map(empreinte -> { id, name, size }).
export function neededFiles(rows) {
  const files = new Map();
  for (const row of rows) {
    const list = parseJson(row[LOT_COL]);
    if (!list || typeof list !== 'object' || Array.isArray(list)) continue;
    for (const [ident, info] of Object.entries(list)) {
      const sha = shaOf(ident);
      if (sha && Array.isArray(info) && Number.isInteger(info[0])) files.set(sha, { id: info[0], name: safeName(String(info[1] || '')), size: Number(info[2]) || 0 });
    }
  }
  return files;
}

// Ce que les destinataires d'un export ont reçu (note de Synchro, `fichiers` : { export: { f, h,
// p, o } }) : chaque webhook de `h` a tous les fichiers de `f` ; `p` : ce qu'a reçu un webhook qui
// n'en est pas encore là (nouveau destinataire, ou en pause quand un fichier est arrivé) ; `o` (Échange
// seulement) : ce que le partenaire d'un webhook a déjà, parce qu'une version signée qu'il a envoyée
// cite ces fichiers (HELD_MAX au plus par webhook, les plus anciens oubliés d'abord) : ils ne lui sont
// pas renvoyés. Des empreintes abrégées, séparées par une espace : la note grandit avec le nombre de
// fichiers, pas avec celui des destinataires.
export const HELD_MAX = 1000;
export function readTracking(noted) {
  const words = s => new Set(typeof s === 'string' ? s.split(' ').filter(w => /^[0-9a-f]{16}$/.test(w)) : []);
  const x = noted && typeof noted === 'object' ? noted : {};
  const map = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : []);
  return {
    f: words(x.f), h: new Set(Array.isArray(x.h) ? x.h.filter(id => typeof id === 'string') : []),
    p: new Map(map(x.p).map(([id, s]) => [id, words(s)])), o: new Map(map(x.o).map(([id, s]) => [id, words(s)])),
  };
}

const copyTracking = tracking => ({
  f: new Set(tracking.f), h: new Set(tracking.h), p: new Map([...tracking.p].map(([id, s]) => [id, new Set(s)])),
  o: new Map([...(tracking.o || [])].map(([id, s]) => [id, new Set(s)])),
});

export const trackingNote = ({ f, h, p, o = new Map() }) => {
  const held = Object.fromEntries([...o].filter(([, s]) => s.size).map(([id, s]) => [id, [...s].join(' ')]));
  return {
    f: [...f].sort().join(' '), h: [...h].sort(), p: Object.fromEntries([...p].map(([id, s]) => [id, [...s].sort().join(' ')])),
    ...(Object.keys(held).length ? { o: held } : {}),
  };
};

// Échange : les fichiers que les versions signées d'un partenaire citent (`cited`, empreintes
// abrégées, voir citedFiles) sont chez lui : ils sont notés pour ses webhooks `hookIds`. L'ordre
// d'arrivée est gardé, le plus ancien part quand la borne est dépassée.
export function holdFiles(tracking, hookIds, cited) {
  const valid = [...cited].filter(k => /^[0-9a-f]{16}$/.test(k));
  const next = copyTracking(tracking);
  for (const id of hookIds) {
    const set = next.o.get(id) || new Set();
    for (const k of valid) set.add(k);
    for (const k of [...set].slice(0, Math.max(0, set.size - HELD_MAX))) set.delete(k);
    next.o.set(id, set);
  }
  return next;
}

// Suivi `tracking` (planifié ou mis à jour par un envoi, parfois bien avant d'être écrit) avec ce que
// `o` du suivi plus récent `latest` y a ajouté entre-temps (voir holdFiles) : une page note ce que le
// partenaire a déjà pendant qu'une autre envoie, et l'écriture de l'une ne doit pas défaire l'autre.
export function mergeHeld(tracking, latest) {
  const next = copyTracking(tracking);
  for (const id of new Set([...tracking.h, ...tracking.p.keys()])) {
    const set = new Set([...(latest.o?.get(id) || []), ...(next.o.get(id) || [])]);
    for (const k of [...set].slice(0, Math.max(0, set.size - HELD_MAX))) set.delete(k);
    if (set.size) next.o.set(id, set);
  }
  return next;
}

// Un webhook de `p` qui a tous les fichiers de `f` passe dans `h`.
function promote({ f, h, p }) {
  for (const [id, have] of p) {
    if ([...f].every(k => have.has(k))) {
      h.add(id);
      p.delete(id);
    }
  }
}

// Envois de fichiers dus pour un export : `needed` (neededFiles), `hooks` (ses webhooks), `active`
// (ceux qui reçoivent : ni en pause, ni en échec). Rend le suivi nettoyé (fichiers plus utiles,
// webhooks disparus oubliés) et les envois [{ sha, hooks, held? }] : un fichier nouveau va aux
// destinataires à jour, et chacun des autres reçoit ce qui lui manque ; un fichier sans
// destinataire à servir est seulement noté (`hooks` vide). `held` : les webhooks qui l'auraient reçu
// mais ont déjà ce fichier (Échange, voir holdFiles) : rien ne leur part, ils sont notés comme l'ayant.
// Un fichier trop gros ne part pas.
export function fileSends(tracking, needed, hooks, active) {
  const live = new Set(hooks);
  const sendable = [...needed].filter(([, file]) => file.size <= FILE_MAX).map(([sha]) => sha);
  const keys = new Set(sendable.map(short));
  const kept = s => new Set([...s].filter(k => keys.has(k)));
  const next = {
    f: kept(tracking.f), h: new Set([...tracking.h].filter(id => live.has(id))),
    p: new Map([...tracking.p].filter(([id]) => live.has(id) && !tracking.h.has(id)).map(([id, s]) => [id, kept(s)])),
    o: new Map([...(tracking.o || [])].filter(([id]) => live.has(id)).map(([id, s]) => [id, new Set(s)])),
  };
  for (const id of hooks) if (!next.h.has(id) && !next.p.has(id)) next.p.set(id, new Set());
  promote(next);
  const served = [...next.h].filter(id => active.includes(id));
  const late = [...next.p].filter(([id]) => active.includes(id));
  const holds = (id, sha) => Boolean(next.o.get(id)?.has(short(sha)));
  const sends = sendable.map((sha) => {
    const due = [...(next.f.has(short(sha)) ? [] : served), ...late.filter(([, have]) => !have.has(short(sha))).map(([id]) => id)];
    const held = due.filter(id => holds(id, sha));
    return { sha, hooks: due.filter(id => !holds(id, sha)), ...(held.length ? { held } : {}) };
  }).filter(s => s.hooks.length || s.held || !next.f.has(short(s.sha)));
  return { tracking: next, sends };
}

// Suivi après l'envoi du fichier `sha` aux webhooks `hookIds`. Un fichier nouveau rejoint `f` ; un
// webhook à jour qui ne l'a pas reçu (en pause, en échec) passe dans `p`, avec tout ce qu'il avait.
export function recordSent(tracking, sha, hookIds) {
  const k = short(sha);
  const next = copyTracking(tracking);
  for (const id of hookIds) if (!next.h.has(id)) next.p.set(id, new Set([...(next.p.get(id) || []), k]));
  if (!next.f.has(k)) {
    for (const id of [...next.h]) {
      if (hookIds.includes(id)) continue;
      next.h.delete(id);
      next.p.set(id, new Set(next.f));
    }
    next.f.add(k);
  }
  promote(next);
  return next;
}

// « Tout renvoyer » : chaque destinataire reçoit de nouveau tous les fichiers, sauf ceux que son
// partenaire a lui-même envoyés (`o`).
export const forgetHooks = tracking => ({ ...copyTracking(tracking), h: new Set(), p: new Map() });

// Contenu en base64, par morceaux de PART_BYTES octets (un fichier vide : un morceau vide).
export function encodeParts(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length || !parts.length; i += PART_BYTES) parts.push(toBase64(bytes.subarray(i, i + PART_BYTES)));
  return parts;
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

// Morceau `n` (sur `parts`) d'un fichier, tel que le webhook l'aurait déposé dans le journal : son
// export, sa description (Synchro_Colonnes : empreinte, nom, taille, rang, nombre de morceaux, envoi)
// et son contenu (Synchro_Lot). Tous les journaux ont ces colonnes.
export const partRow = (exportId, { sha, name, size }, send, n, parts, data) => ({
  [EXPORT_COL]: exportId, [TYPE_COL]: KIND.part, [SCHEMA_COL]: JSON.stringify({ sha, nom: name, taille: size, n, parts, envoi: send }), [LOT_COL]: data,
});

// ---------------------------------------------------------------------------------------------
// CIBLE

// Annonce d'un morceau (Synchro_Colonnes) : empreinte, nom, taille, rang et nombre de morceaux,
// envoi, chacun dans ses bornes.
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const validMeta = meta => Boolean(meta) && typeof meta === 'object' && is(SHA, meta.sha) && typeof meta.nom === 'string'
  && inRange(meta.taille, 0, FILE_MAX) && inRange(meta.parts, 1, MAX_PARTS) && inRange(meta.n, 0, meta.parts - 1) && is(SEND, meta.envoi);
const validChunk = text => typeof text === 'string' && text.length <= PART_TEXT_MAX && BASE64.test(text);

// Nom d'un fichier reçu, sans séparateurs de chemin, caractères de contrôle, ni caractères
// invisibles ou de sens d'écriture (« facture\u202Efdp.exe » s'afficherait « facture exe.pdf »).
const safeName = name => name.replace(/[\\/\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '_').slice(0, 255) || 'fichier';

// Morceau reçu : { sha, name, size, n, parts, send, data } ; null s'il ne peut pas venir de la
// SOURCE de cet export.
export function readPart(row, exportId) {
  const meta = parseJson(row[SCHEMA_COL]);
  const encoded = row[LOT_COL];
  if (row[EXPORT_COL] !== exportId || row[TYPE_COL] !== KIND.part || !validMeta(meta) || !validChunk(encoded)) return null;
  return { sha: meta.sha, name: safeName(meta.nom), size: meta.taille, n: meta.n, parts: meta.parts, send: meta.envoi, data: encoded };
}

// Fichiers arrivés : pour chaque empreinte, l'envoi le plus récent (celui de la dernière ligne
// arrivée), s'il a tous ses morceaux (`ready` : { sha, name, size, data: [base64, dans l'ordre],
// ids, old, bytes }). Les morceaux d'un envoi plus ancien ou resté incomplet plus de PART_TTL
// secondes (`stale`) et les lignes illisibles (`rejected`) sont à effacer ; ceux d'un envoi en
// cours attendent (`partial` : { ids, bytes }). `old` : arrivé il y a plus de PART_TTL secondes.
// `bytes` : octets reçus. `now` : secondes.
export function fileArrivals(rows, exportId, now) {
  const ready = [];
  const stale = [];
  const rejected = [];
  const partial = [];
  const parts = [];
  for (const row of rows.filter(r => r[TYPE_COL] === KIND.part)) {
    const part = readPart(row, exportId);
    if (part) parts.push({ row, part });
    else rejected.push(row.id);
  }
  for (const list of groupBy(parts, p => p.part.sha).values()) {
    const last = list.reduce((a, b) => (b.row.id > a.row.id ? b : a)).part.send;
    for (const [send, items] of groupBy(list, p => p.part.send)) {
      const ids = items.map(p => p.row.id);
      const { sha, name, size, parts: count } = items[items.length - 1].part;
      const byN = new Map(items.filter(p => p.part.parts === count).map(p => [p.part.n, p.part.data]));
      const arrived = Math.max(...items.map(p => (typeof p.row[RECEIVED_COL] === 'number' ? p.row[RECEIVED_COL] : now)));
      const bytes = items.reduce((n, p) => n + Math.floor(p.part.data.length * 3 / 4), 0);
      if (send === last && byN.size === count) ready.push({ sha, name, size, data: Array.from({ length: count }, (_, n) => byN.get(n)), ids, old: now - arrived > PART_TTL, bytes });
      else if (send !== last || now - arrived > PART_TTL) stale.push(...ids);
      else partial.push({ ids, bytes });
    }
  }
  return { ready, stale, rejected, partial };
}

// Morceaux gardés en attente dans un journal, au plus (envois en cours, fichiers qu'aucune version
// ne cite encore) : la place de deux fichiers de la plus grande taille. La SOURCE n'envoie qu'un
// fichier à la fois, et ses versions arrivent avant ses fichiers ; qui n'a que la clé du
// formulaire peut, lui, parquer des morceaux bien formés.
export const PARKED_MAX = 2 * FILE_MAX;

// Envois en attente (`groups` : { ids, bytes }) à effacer pour que les autres tiennent dans `max`
// octets : les plus anciens (dernière ligne arrivée la plus ancienne) d'abord.
export function parkedOverflow(groups, max = PARKED_MAX) {
  let total = 0;
  return [...groups].sort((a, b) => Math.max(...b.ids) - Math.max(...a.ids)).filter(g => (total += g.bytes) > max);
}

// Fichiers cités par les versions du journal (lignes brutes `rows`), et par les cellules qui en
// attendent encore (`waiting` : empreintes abrégées, notées par la recopie) : seuls ceux-là sont
// déposés. Les morceaux ne sont pas signés (voir trust.js), les versions si : qui n'a que la clé du
// formulaire ne peut pas faire déposer un fichier que la SOURCE n'a pas cité.
export function citedFiles(rows, waiting = []) {
  const cited = new Set(waiting);
  for (const row of expandRows(rows)) {
    for (const value of Object.values(row)) for (const file of fileList(value)) cited.add(short(file.sha));
  }
  return cited;
}

// Contenu d'un fichier à partir de ses morceaux.
export function joinParts(data) {
  const parts = data.map(text => Uint8Array.from(atob(text), c => c.charCodeAt(0)));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}

export const sha1 = async bytes => toHex(await digest('SHA-1', bytes));

// Fichiers d'une cellule reçue (['L', [fileIdent, nom, taille], …]) : [{ sha, name, size }].
export function fileList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(value[0] === 'L' ? 1 : 0).filter(f => Array.isArray(f) && shaOf(f[0]))
    .map(f => ({ sha: shaOf(f[0]), name: safeName(String(f[1] ?? '')), size: Number(f[2]) || 0 }));
}

// Valeur d'une cellule reçue pour la destination : les numéros des fichiers que le document a
// (`present` : empreinte -> numéro dans _grist_Attachments), ou null s'il n'en a aucun. Un fichier
// pas encore arrivé manque : la cellule sera complétée à son arrivée (voir fillActions).
export function resolveCell(value, present) {
  const ids = fileList(value).map(f => present.get(f.sha)).filter(Boolean);
  return ids.length ? ['L', ...ids] : null;
}

// Lignes du journal avec leurs cellules Pièces jointes (`cols` : colonnes du journal) résolues.
export function resolveRows(rows, cols, present) {
  if (!cols.length) return rows;
  return rows.map((row) => {
    const here = cols.filter(c => Object.hasOwn(row, c));
    return here.length ? { ...row, ...Object.fromEntries(here.map(c => [c, resolveCell(row[c], present)])) } : row;
  });
}

// Échange : fichiers que chaque version reçue cite et que le document n'a pas encore (`rows` : lignes
// du journal d'une table, `cols` : ses colonnes Pièces jointes, `present` : voir attachments). Une
// version qui en attend n'est pas recopiée (voir planConsolidation) : une cellule recopiée sans tous
// ses fichiers repartirait vers les autres participants comme la version la plus récente de la
// ligne et leur ferait perdre des fichiers. Rend Map(numéro de la ligne du journal -> [{ sha, name,
// size }]).
export function waitingVersions(rows, cols, present) {
  const waiting = new Map();
  if (!cols.length) return waiting;
  for (const row of rows) {
    const missing = cols.flatMap(c => fileList(row[c])).filter(f => !present.has(f.sha));
    if (missing.length) waiting.set(row.id, missing);
  }
  return waiting;
}

// Fichiers que la destination attend encore (`waiting` : empreintes) et ceux trop gros pour partir
// (`big` : [{ sha, name, size }]), d'après la dernière version de chaque ligne (hors suppressions).
export function filesState(rows, cols, present) {
  const waiting = new Set();
  const big = new Map();
  if (!cols.length) return { waiting: [], big: [] };
  for (const { row } of latestByKey(rows).values()) {
    if (isTrue(row[DELETE_COL])) continue;
    for (const file of cols.flatMap(c => fileList(row[c]))) {
      if (present.has(file.sha)) continue;
      if (file.size > FILE_MAX) big.set(file.sha, file);
      else waiting.add(file.sha);
    }
  }
  return { waiting: [...waiting], big: [...big.values()] };
}

// Cellules à compléter : la dernière version déjà recopiée d'une ligne cite un fichier arrivé
// depuis le passage précédent (`arrived` : empreintes abrégées). La cellule n'est complétée que si
// elle est restée telle que la recopie l'a laissée (sans ces fichiers) : une retouche reste.
// `copyCols` : [[colonne du journal, colonne d'ici]] des pièces jointes ; `journalRows` non résolues.
const idsOf = v => (Array.isArray(v) ? v.slice(v[0] === 'L' ? 1 : 0) : []);
const sameIds = (a, b) => JSON.stringify(idsOf(a)) === JSON.stringify(idsOf(b));
export function fillActions({ journalRows, destRows, copyCols, present, arrived, destTable }) {
  if (!arrived.size || !copyCols.length) return [];
  const latest = latestByKey(journalRows);
  const before = new Map([...present].filter(([sha]) => !arrived.has(short(sha))));
  const updates = new Map(); // colonne d'ici -> [[ligne, valeur]]
  for (const row of destRows) {
    const version = latest.get(row[KEY_COL]);
    if (!version || !isTrue(version.row[APPLIED_COL]) || isTrue(version.row[DELETE_COL])) continue;
    for (const [from, to] of copyCols) {
      const value = version.row[from];
      if (!fileList(value).some(f => arrived.has(short(f.sha)))) continue;
      const full = resolveCell(value, present);
      if (sameIds(row[to], resolveCell(value, before)) && !sameIds(row[to], full)) updates.set(to, [...(updates.get(to) || []), [row.id, full]]);
    }
  }
  return [...updates].flatMap(([to, list]) => chunk(list).map(part => ['BulkUpdateRecord', destTable, part.map(([id]) => id), { [to]: part.map(([, v]) => v) }]));
}
