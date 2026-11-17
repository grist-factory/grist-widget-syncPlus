// Ce qui prouve qui est à l'autre bout d'un lien, au-delà de ce que dit un code collé : le document
// que désigne une clé de formulaire, lu chez Grist ; un code de contrôle à comparer par téléphone ;
// la durée de vie d'une invitation ; la signature des envois (HMAC-SHA256 avec une clé propre à
// chaque destinataire, tirée d'un échange de clés publiques : seuls la SOURCE et lui la connaissent).
import {
  DATA_COL, DELETE_COL, EXPORT_COL, KEY_COL, KIND, LIST_COL, LOT_COL, ORDER_COL, SCHEMA_COL, SEAL_COL, SIG_KEY, TABLE_COL, TYPE_COL, is, isBlank,
  digest, isTrue, sha256, toHex,
} from './common.js';
import { cleanLabel, parseWebhookUrl } from './codes.js';

// ---------------------------------------------------------------------------------------------
// Document désigné par une clé de formulaire

// Réponse de Grist à GET <instance>/api/s/<clé> (anonyme) : { docId (complet), name, folder, team
// (adresse de l'équipe), teamName, personal (espace personnel : son propriétaire n'est pas
// vérifiable) } ; null si elle n'a pas la forme attendue.
export function readShare(json) {
  if (!json || typeof json !== 'object' || !is(/^[A-Za-z0-9_-]{12,}$/, json.id)) return null;
  const ws = json.workspace && typeof json.workspace === 'object' ? json.workspace : {};
  const org = ws.org && typeof ws.org === 'object' ? ws.org : {};
  const text = v => (typeof v === 'string' ? cleanLabel(v) : '');
  const team = text(org.domain);
  return {
    docId: json.id, name: text(json.name), folder: text(ws.name), team, teamName: text(org.name),
    personal: !team || /^docs(-\d+)?$/.test(team) || Boolean(org.billingAccount && org.billingAccount.individual),
  };
}

// Un code ou un mémo désigne un document par son identifiant court (urlId : au moins les 12 premiers
// caractères de l'identifiant complet, règle de Grist) ou complet.
export const sameDoc = (fullId, shown) => typeof shown === 'string' && shown.length >= 12 && fullId.startsWith(shown);

// Mémo d'un webhook (« e-mail · document · équipe ») : faux si aucune de ses parties ne désigne le
// document `fullId` alors qu'une au moins a la forme d'un identifiant (un mémo sans document ne dit
// rien).
export function memoMatches(memo, fullId) {
  const parts = String(memo || '').split(' · ').filter(p => !p.includes('@') && /^[A-Za-z0-9]{12,}$/.test(p));
  return !parts.length || parts.some(p => sameDoc(fullId, p));
}

// ---------------------------------------------------------------------------------------------
// Code de contrôle : six caractères tirés de la clé de l'adresse d'écriture, du secret et de ce
// que chaque côté a lu dans les codes (`seen`, voir codeFacts), affichés des deux côtés. Une
// adresse ou une clé publique remplacée en route, une sécurité renforcée retirée (ou une réponse
// faite par un autre) donne un autre code. Seule la clé de l'adresse compte, tirée par Grist : le
// reste de l'adresse (équipe, table) se choisit, et le faire varier jusqu'à retomber sur le même
// code serait à la portée d'un ordinateur.

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sans 0, 1, I, L, O
export async function controlCode(url, secret, seen = []) {
  const subject = (parseWebhookUrl(url) || {}).key || url;
  const text = [subject, secret || '', ...seen].join('\n');
  const bytes = await digest('SHA-256', new TextEncoder().encode(text));
  const chars = Array.from(bytes.slice(0, 6), b => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}

// Ce que chaque côté a lu dans l'invitation (sécurité renforcée, clé publique de la SOURCE) et,
// pour le code de la réponse, la clé publique de la CIBLE : ils entrent dans le code de contrôle.
export const codeFacts = ({ renforce, pub }, replyPub = null) => [renforce ? 'renforce' : 'standard', pub || '', ...(replyPub === null ? [] : [replyPub || ''])];

// ---------------------------------------------------------------------------------------------
// Invitations

export const INVITE_DAYS = 7;
export const expiresAt = at => (Number(at) || 0) + INVITE_DAYS * 86400;
export const isExpired = (at, now) => now > expiresAt(at);

// ---------------------------------------------------------------------------------------------
// Clés par destinataire. Chaque côté tire une paire de clés ECDH (P-256) : la publique part dans son
// code (l'invitation, la réponse), la privée reste chez lui le temps de la réponse. Des deux
// clés, chacun tire le même secret commun, puis deux clés de signature propres à cette invitation :
// `down` signe les envois de la SOURCE vers ce destinataire, `up` l'envoi de retour d'un Échange.
// Qui lit les deux codes (un fil de courriel) n'en tire rien ; un destinataire ne peut pas signer
// pour un autre.

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const JWK_PART = /^[A-Za-z0-9_-]{43}$/;

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));

// Paire de clés : { pub (base64url, pour le code), priv ({ x, y, d } : jamais dans un code) }.
export async function newKeyPair() {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const { x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { pub: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), priv: { x, y, d } };
}

export const isPrivateKey = priv => Boolean(priv) && typeof priv === 'object' && ['x', 'y', 'd'].every(k => is(JWK_PART, priv[k]));

// Clés de signature d'une invitation (`invitationId`, de l'export `exportId`), tirées de sa clé
// privée et de la clé publique de l'autre côté. Une clé publique qui n'est pas un point de la courbe
// rend le code invalide.
export async function linkKeys(priv, peerPub, exportId, invitationId) {
  let base;
  try {
    const mine = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...priv }, ECDH, false, ['deriveBits']);
    const peer = await crypto.subtle.importKey('raw', fromBase64Url(peerPub), ECDH, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, mine, 256);
    base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  } catch (e) {
    throw new Error('codeInvalid');
  }
  const encode = text => new TextEncoder().encode(text);
  const derive = async label => toHex(new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encode(`${exportId}|${invitationId}`), info: encode(`gristsync|${label}`) }, base, 128)));
  return { down: await derive('envoi'), up: await derive('retour') };
}

// Clés d'un export, lues dans sa ligne 'signature' de Synchro : { webhook (ou invitation, le temps
// de créer le webhook) : clé }. Une seule clé (export d'avant la 0.10, dont tous les destinataires
// ont reçu la même) vaut '*'.
export function readKeys(value) {
  const text = String(value || '');
  if (SIG_KEY.test(text)) return { '*': text };
  let keys = null;
  try {
    keys = text.startsWith('{') ? JSON.parse(text) : null;
  } catch (e) {
    keys = null;
  }
  return Object.fromEntries(Object.entries(keys && typeof keys === 'object' ? keys : {}).filter(([, k]) => SIG_KEY.test(k)));
}

// Destinataires sans clé de signature : la ligne 'signature' de Synchro (`value`) a été supprimée ou vidée, ou n'a
// jamais eu leur clé. Leurs lots partent sans signature pour eux et leur CIBLE les rejette comme suspects. La
// clé ne se refait pas : elle vient de l'invitation. Un export plus ancien que les clés (aucun destinataire
// ajouté depuis `join` dans l'historique, `hasJoin`) n'en avait pas : rien n'est dit.
export function unkeyedRecipients(value, hookIds, hasJoin) {
  const keys = readKeys(value);
  if (!hasJoin || keys['*']) return [];
  return hookIds.filter(id => !keys[id]);
}

// Clés à garder : celles des webhooks de l'export (`hookIds`) et des invitations en cours
// d'approbation (`pendingIds`) ; la clé commune d'avant la 0.10 tant qu'un webhook n'a pas la sienne.
export function keptKeys(keys, hookIds, pendingIds) {
  const kept = Object.fromEntries(Object.entries(keys).filter(([label]) => hookIds.includes(label) || pendingIds.includes(label)));
  if (keys['*'] && hookIds.some(id => !kept[id])) kept['*'] = keys['*'];
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Signature des envois. La formule de Synchro signe le texte d'un lot (Synchro_Lot des lignes
// 'lot') ou d'une liste des clés (Synchro_Ids des lignes 'cles') : sur l'export, la table, le type,
// la description des colonnes et le texte, une signature par clé de destinataire, ajoutée en dernier
// champ du JSON (`"sigs"` : { empreinte de la clé : signature }), que la CIBLE retire pour vérifier
// la sienne. Un changement de colonnes change donc la signature du lot, qui repart avec elles. Le
// widget SOURCE signe de même l'avis de fin ('fin', dans Synchro_Lot), pour un seul destinataire.
// Avant la 0.10, une seule clé par export signait (`"sig"`) : encore acceptée, avec la clé reçue.

const SIGNED = { [KIND.lot]: LOT_COL, [KIND.keys]: LIST_COL, [KIND.end]: LOT_COL };
const SIG_TAIL = /, "sig": "([0-9a-f]{64})"\}$/;
const SIGS_TAIL = /, "sigs": (\{[^{}]*\})\}$/;

const message = (row, text) => [row[EXPORT_COL], row[TABLE_COL] || '', row[TYPE_COL], row[SCHEMA_COL] || '', text].join('|');

export async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))));
}

// Empreinte d'une clé (qui désigne sa signature dans `"sigs"`) et signature d'un message avec elle
// (sur l'empreinte SHA-256 du message : un lot de 250 ko n'est haché qu'une fois, quel que soit le
// nombre de destinataires).
const keyMark = async key => (await sha256(key)).slice(0, 8);
const keySig = async (key, digest) => (await hmac(key, digest)).slice(0, 32);

// Texte JSON d'objet `text` signé pour la ligne `row` avec la clé `key` (comme la formule le fait
// pour un seul destinataire).
export async function signText(key, row, text) {
  const sig = await keySig(key, await sha256(message(row, text)));
  return `${text.slice(0, -1)}, "sigs": {"${await keyMark(key)}": "${sig}"}}`;
}

// Ligne brute d'un journal, au regard de la clé `key` : 'ok' (signée, ou d'un type qui ne l'est
// pas : morceau de fichier, protégé par son empreinte), 'bare' (liste des clés vide : elle ne dit
// rien, mais sa description des colonnes n'est pas prouvée, donc pas lue) ou 'bad'.
export async function signature(row, key) {
  const col = SIGNED[row[TYPE_COL]];
  if (!col) return 'ok';
  const text = typeof row[col] === 'string' ? row[col] : '';
  if (!text) return row[TYPE_COL] === KIND.keys ? 'bare' : 'bad';
  const legacy = SIG_TAIL.exec(text);
  if (legacy) return (await hmac(key, message(row, `${text.slice(0, legacy.index)}}`))) === legacy[1] ? 'ok' : 'bad';
  const m = SIGS_TAIL.exec(text);
  const sigs = m ? parseSigs(m[1]) : null;
  const sig = sigs && sigs[await keyMark(key)];
  if (!sig) return 'bad';
  return (await keySig(key, await sha256(message(row, `${text.slice(0, m.index)}}`)))) === sig ? 'ok' : 'bad';
}

function parseSigs(text) {
  try {
    const sigs = JSON.parse(text);
    return sigs && typeof sigs === 'object' ? sigs : null;
  } catch (e) {
    return null;
  }
}

// Ligne d'un type signé qui ne porte aucune signature (ni `"sigs"` ni `"sig"`) : un envoi d'avant la clé, tel que l'ancien
// webhook d'un partage en cours de renforcement l'envoie encore (voir reinforce.js). L'avis de fin est exclu : il ne coupe
// une réception que signé.
export function isUnsigned(row) {
  const col = SIGNED[row[TYPE_COL]];
  if (!col || row[TYPE_COL] === KIND.end) return false;
  const text = typeof row[col] === 'string' ? row[col] : '';
  return text !== '' && !SIG_TAIL.test(text) && !SIGS_TAIL.test(text);
}

// Lignes brutes de l'export `exportId` (celles d'un autre export sont laissées au contrôle du
// dépliage) : { bad (mal signées), bare (listes vides), signed (nombre de lignes signées avec cette clé), tolerated
// (nombre de lignes sans signature acceptées) }. `grace` : un partage en cours de renforcement accepte, pour un
// temps, les envois sans aucune signature (voir reinforce.js) ; une signature fausse reste rejetée.
export async function checkSigned(rows, key, exportId, { grace = false } = {}) {
  const out = { bad: new Set(), bare: new Set(), signed: 0, tolerated: 0 };
  for (const row of rows) {
    if (row[EXPORT_COL] !== exportId) continue;
    const verdict = await signature(row, key);
    if (verdict === 'ok') {
      if (SIGNED[row[TYPE_COL]]) out.signed++;
    } else if (verdict === 'bad' && grace && isUnsigned(row)) {
      out.tolerated++;
    } else {
      out[verdict].add(row.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sceau des lignes dépliées (CIBLE). La clé du formulaire d'un journal peut y créer une ligne avec
// n'importe quelles colonnes : sans type, elle n'est pas une ligne reçue et passerait pour une
// version déjà dépliée, sans contrôle de signature ni de date. Le widget scelle donc chaque ligne
// qu'il déplie (HMAC avec la clé de signature de l'export, que la clé du formulaire ne lit pas) et
// écarte toute ligne d'une table sans sceau valide. Le sceau couvre ce que le dépliage écrit, pas
// les marques que la recopie pose ensuite (Sync_Applique, Sync_Etat, Sync_Avant, et Sync_Recu, que
// la recopie récrit sur la version d'une ligne effacée d'après une liste des clés : voir
// planConsolidation).
const SEALED = [TABLE_COL, KEY_COL, ORDER_COL, DELETE_COL, DATA_COL, SCHEMA_COL, LIST_COL];
export const sealText = (exportId, row) => JSON.stringify(['sceau', exportId,
  ...SEALED.map(c => (c === DELETE_COL ? isTrue(row[c]) : isBlank(row[c]) ? '' : row[c]))]);

// Lignes dépliées, à sceller : une ligne d'une table (version ou liste des clés). Les lignes
// reçues sont contrôlées au dépliage ; une ligne sans table (test du lien) ne sert à rien.
export const isUnpacked = row => isBlank(row[TYPE_COL]) && !isBlank(row[TABLE_COL]);

// Sceau d'un texte avec la clé `key`, importée une fois : fonction asynchrone texte -> hexadécimal.
export async function sealer(key) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async text => toHex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))));
}

// Empreinte de la clé qui scelle, notée dans la note du journal (`sceau`) : quand elle change
// (première fois, nouvelle invitation), le widget rescelle ce qui est déjà là.
export const sealMark = async seal => (await seal('sceau')).slice(0, 8);

export const sealRows = async (rows, exportId, seal) => Promise.all(rows.map(async r => ({ ...r, [SEAL_COL]: await seal(sealText(exportId, r)) })));

// Lignes du journal à garder : toutes, sauf les lignes d'une table au sceau absent ou faux
// (`forged`, numéros). `seen` : sceaux déjà vérifiés, par numéro de ligne, tenu à jour ici (une
// ligne disparue en sort : un numéro réutilisé est vérifié de nouveau).
export async function checkSeals(rows, exportId, seal, seen = new Map()) {
  const present = new Set(rows.map(r => r.id));
  for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
  const forged = [];
  for (const row of rows.filter(isUnpacked)) {
    const got = row[SEAL_COL];
    if (got && seen.get(row.id) === got) continue;
    if (got && got === await seal(sealText(exportId, row))) seen.set(row.id, got);
    else forged.push(row.id);
  }
  const bad = new Set(forged);
  return { kept: rows.filter(r => !bad.has(r.id)), forged };
}
