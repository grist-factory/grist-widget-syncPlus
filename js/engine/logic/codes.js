// Codes échangés entre SOURCE et CIBLE (préfixe + JSON en base64url, sur une ligne) et adresses
// Grist qu'ils portent. Tout ce qui vient d'un code collé est contrôlé ici : identifiants, colonnes,
// adresses réécrites à partir de leurs seuls éléments reconnus.
import { HEX16, PUBLIC_KEY, SENT_TYPE, SIG_KEY, is, isSafeId, parseJson } from './common.js';
import { columnOptions } from './options.js';
import { docFormat } from './docformat.js';
import { TABLE_NOTE_MAX, cleanNote } from './descriptions.js';
import { cleanFormula } from './column-formulas.js';
import { isPos } from './layout.js';

const CODE_PREFIX = 'GRISTSYNC2.';
const SECRET = /^[0-9a-f]{32}$/;
const MAX_COLUMNS = 400; // colonnes par table, au plus
const TEAM = '(?:/o/[A-Za-z0-9_-]+)?'; // équipe dans le chemin : /o/<équipe>

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
  } catch (e) {
    return '';
  }
}

// Forme des codes (`f`), et version du widget qui les a faits (`v`), depuis la 0.12. Une version qui
// change la forme des codes augmente CODE_FORMAT : une version plus ancienne refuse alors ses codes
// en nommant les deux versions, au lieu d'une erreur vague ou d'un envoi qui échoue plus tard. Un
// code sans forme vient d'avant la 0.12 (même forme depuis la 0.10, contrôlée plus loin).
// 1 : forme des codes jusqu'à la 0.28.1 (moteur 4.12.0 compris).
// 2 : relevée avec le moteur 5.0.0 (syncPlus 0.28.2), pour que la CIBLE d'avant les références entre tables par colonne
//     (moteur 4.11.0 : Liste de références, `list` dans la description des colonnes) ne reçoive pas d'invitation d'une
//     SOURCE plus récente : elle ferait d'une colonne `list` une Référence simple, sans rien dire. Le contenu des codes
//     n'a pas changé : le relèvement fait de l'invitation la porte d'entrée (la CIBLE trop ancienne dit `codeNewer`
//     avec les deux versions). Il joue dans les deux sens : une SOURCE d'avant refuse aussi la réponse d'une CIBLE à
//     la forme 2, avec le même message ; les codes de forme 1 déjà faits restent lus.
export const CODE_FORMAT = 2;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const encodeCode = (payload, version) => CODE_PREFIX + toBase64Url(JSON.stringify({ ...payload, f: CODE_FORMAT, ...(version ? { v: version } : {}) }));

// Un code recopié d'un courriel peut avoir été coupé en plusieurs lignes : les blancs sont ôtés.
// `version` : celle du widget qui lit le code.
export function decodeCode(text, kind, version = '') {
  const raw = String(text || '').replace(/\s+/g, '');
  if (raw.startsWith('GRISTSYNC1.')) throw new Error('codeOld');
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('codeFormat');
  const payload = parseJson(fromBase64Url(raw.slice(CODE_PREFIX.length)));
  if (!payload) throw new Error('codeFormat');
  if (Number(payload.f) > CODE_FORMAT) {
    throw Object.assign(new Error('codeNewer'), { vars: { theirs: is(VERSION, payload.v) ? payload.v : '?', mine: version || '?' } });
  }
  if (payload.kind !== kind) throw new Error(kind === 'invitation' ? 'notInvitation' : 'notReply');
  return payload;
}

// Version du widget qui a fait un code, si elle y est (depuis la 0.12) ; '' sinon.
const codeVersion = payload => (is(VERSION, payload.v) ? payload.v : '');

// Colonnes envoyées, telles qu'un code ou un journal les décrit : [{ id, type, label, as }]. Dans un
// Échange, `as` donne le nom de la colonne dans l'autre document (voir exchangeTables).
export function validColumns(cols) {
  return Array.isArray(cols) && cols.length > 0 && cols.length <= MAX_COLUMNS && new Set(cols.map(c => c && c.id)).size === cols.length &&
    cols.every(c => c && isSafeId(c.id) && is(SENT_TYPE, c.type) && (c.as === undefined || isSafeId(c.as)));
}

// `withOpts` : avec leur liste de choix et leur format (voir options.js), contrôlés. Les codes ne
// les portent pas (ils resteraient courts) : la CIBLE les lit dans la description reçue au journal.
export const exportSchema = (columns, withOpts = false) => columns.map(column => schemaColumn(column, withOpts));

// Référence conservée (voir links.js) : table visée et colonne qu'elle affichait, dans la SOURCE.
// `list` : la colonne désigne plusieurs lignes (Liste de références).
const schemaAim = ({ link, visible, list }) => (isSafeId(link) ? { link, ...(isSafeId(visible) ? { visible } : {}), ...(list === true ? { list: true } : {}) } : {});

// Descriptions de la colonne et de la table (voir descriptions.js) : du texte, nettoyé et borné ; la clé dit que l'export les envoie.
// Mise en forme (`fmt`), rang dans la page (`pos`), formules (voir column-formulas.js). L'ordre des clés est celui du texte signé.
function schemaNotes({ desc, tdesc, fmt, pos, fx, fd }) {
  return {
    ...(fmt === true ? { fmt } : {}),
    ...(typeof desc === 'string' ? { desc: cleanNote(desc) } : {}),
    ...(typeof tdesc === 'string' ? { tdesc: cleanNote(tdesc, TABLE_NOTE_MAX) } : {}),
    ...(isPos(pos) ? { pos } : {}),
    ...(typeof fx === 'string' ? { fx: cleanFormula(fx) } : {}),
    ...(typeof fd === 'string' && cleanFormula(fd) ? { fd: cleanFormula(fd) } : {}),
  };
}

function schemaColumn(column, withOpts) {
  const { id, type, label, as, opts } = column;
  const head = { id, type, ...(typeof label === 'string' ? { label: cleanLabel(label) } : {}), ...(as ? { as } : {}) };
  if (!withOpts) return head;
  const kept = opts ? columnOptions(type, opts, { extras: true }) : null;
  const docInfo = docFormat(column.doc); // langue et monnaie du document de la SOURCE (voir docformat.js)
  return { ...head, ...schemaAim(column), ...(kept ? { opts: kept } : {}), ...(docInfo ? { doc: docInfo } : {}), ...schemaNotes(column) };
}

// Un texte dit par l'autre document (courriel, identifiant, équipe, nom) : nettoyé comme `cleanLabel` (sans caractère de contrôle ni de sens d'écriture).
const text200 = (from, keys) => Object.fromEntries(keys.map(k => [k, cleanLabel(from[k])]));

// Un nom que dit un code (le document de la SOURCE) : texte seul, jamais une décision. Sans caractères de
// contrôle ni de sens d'écriture (un U+202E retournerait le texte qui suit), espaces ramenées à une, 200
// caractères au plus. Montré par textContent, comme tout ce qu'un code dit.
export const cleanLabel = text => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// Équipe et nom du document de la SOURCE, tels que l'invitation les dit (la SOURCE ne peut pas lire le nom de
// son document : elle le tient d'une saisie, voir rememberDocName). L'équipe sert à refaire l'adresse du
// document, elle n'est donc gardée que de la forme d'un identifiant d'équipe (« » : site sans équipe dans le
// chemin) ; absente, aucun lien n'est fait.
const TEAM_ID = /^[A-Za-z0-9_-]{1,120}$/;
function sourceDoc(from) {
  const team = typeof from.team === 'string' && (from.team === '' || TEAM_ID.test(from.team)) ? { team: from.team } : {};
  const name = cleanLabel(from.docName);
  return { ...team, ...(name ? { docName: name } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Invitation (SOURCE -> CIBLE) et réponse (CIBLE -> SOURCE)

// Une invitation donne accès à un export (`export`, ses tables et colonnes) pour une personne :
// `id` la désigne dans la réponse ; `secret`, tiré à la création, prouve que la réponse vient de
// quelqu'un qui l'a reçue (la SOURCE n'en garde que l'empreinte). `expire` : heure (en secondes) où
// elle ne vaut plus ; `renforce` : sécurité renforcée (code de contrôle comparé, suppressions à
// valider) ; `pub` : clé publique de la SOURCE pour cette invitation, d'où chaque côté tire les
// clés qui signent les envois (voir linkKeys, trust.js).
// Mode « lien public » (`base` : adresse REST du document SOURCE) : pas de réponse, la CIBLE lit
// les instantanés de l'export elle-même, sans identifiant. Mode « Échange » (`retour` : adresse
// d'écriture du journal de retour de la SOURCE) : la CIBLE renvoie ses modifications à cette
// adresse, par un webhook à elle. Ce code-là est donc un droit d'écriture.
export function buildInvitation({ id, exportId, name, origin, secret = '', from = {}, tables, base = '', retour = '', expire = 0, renforce = false, pub = '', version = '' }) {
  return encodeCode({
    kind: 'invitation', id, export: exportId, name, origin, secret, from,
    ...(expire ? { expire } : {}), ...(renforce ? { renforce: true } : {}), ...(pub ? { pub } : {}),
    ...(base ? { mode: 'public', base } : retour ? { mode: 'echange', retour } : {}),
    tables: tables.map(({ table, columns }) => ({ table, columns: exportSchema(columns) })),
  }, version);
}

function validInvitation(inv) {
  return is(HEX16, inv.id) && is(HEX16, inv.export) && typeof inv.name === 'string' && (!inv.secret || is(SECRET, inv.secret))
    && (inv.expire === undefined || Number.isFinite(inv.expire)) && (inv.pub === undefined || is(PUBLIC_KEY, inv.pub))
    && Array.isArray(inv.tables) && inv.tables.length > 0 && inv.tables.every(tb => tb && isSafeId(tb.table) && validColumns(tb.columns))
    && new Set(inv.tables.map(tb => tb.table)).size === inv.tables.length;
}

// Mode d'une invitation et l'adresse qu'il porte, réécrite ; null si l'adresse ne convient pas.
function invitationMode(inv) {
  if (inv.mode === 'public') {
    const base = safeDocBaseUrl(inv.base);
    return base ? { mode: 'public', base } : null;
  }
  if (inv.mode === 'echange') {
    const back = parseWebhookUrl(inv.retour);
    return back && back.flat ? { mode: 'echange', base: '', retour: back.url, retourOrigin: back.origin } : null;
  }
  return { mode: 'reponse', base: '' };
}

// Une invitation à réponse ou d'Échange porte la clé publique de la SOURCE ; avant la 0.10, elle
// portait la clé de signature de l'export (`cle`) : à refaire.
export function parseInvitation(text, version = '') {
  const inv = decodeCode(text, 'invitation', version);
  const mode = validInvitation(inv) ? invitationMode(inv) : null;
  if (!mode) throw new Error('codeInvalid');
  if (mode.mode !== 'public' && !inv.pub) throw new Error(is(SIG_KEY, inv.cle) ? 'codeOld' : 'codeInvalid');
  const from = inv.from && typeof inv.from === 'object' ? inv.from : {};
  return {
    id: inv.id, export: inv.export, name: cleanLabel(inv.name), secret: inv.secret || '', origin: String(inv.origin || ''), ...mode,
    expire: inv.expire || 0, renforce: inv.renforce === true, pub: inv.pub || '',
    from: { ...text200(from, ['email', 'docId']), ...sourceDoc(from) }, version: codeVersion(inv),
    tables: inv.tables.map(tb => ({ table: tb.table, columns: exportSchema(tb.columns) })),
  };
}

// `url` : l'adresse d'écriture du journal de l'export dans la CIBLE. Échange : `retour` dit où la
// CIBLE a rangé chaque table ([{ table: table de la CIBLE, dest: table de la SOURCE }]).
// `pub` : clé publique de la CIBLE pour cette invitation (voir linkKeys, trust.js).
export function buildReply({ id, secret = '', recipient, url, retour = null, pub = '', version = '' }) {
  return encodeCode({ kind: 'reponse', id, secret, recipient, url, pub, ...(retour ? { retour } : {}) }, version);
}

// Tables d'un Échange dans la réponse : chacune nommée, une seule fois de chaque côté.
function validRetour(back) {
  const unique = key => new Set(back.map(b => b && b[key])).size === back.length;
  return Array.isArray(back) && back.length > 0 && back.every(b => b && isSafeId(b.table) && isSafeId(b.dest)) && unique('table') && unique('dest');
}

// Champs d'une réponse : identifiant, secret, fiche du destinataire, clé publique ; en Échange,
// tables de retour.
function validReply({ id, secret, recipient, retour, pub }) {
  return is(HEX16, id) && (!secret || is(SECRET, secret)) && Boolean(recipient) && typeof recipient === 'object'
    && (retour === undefined || validRetour(retour)) && is(PUBLIC_KEY, pub);
}

// `sourceOrigin` : origine de l'instance du document SOURCE. Le webhook ne part que vers la même
// instance, à une adresse d'écriture par clé de formulaire, rien d'autre.
// Une réponse sans clé publique répond à une invitation d'avant la 0.10, à refaire.
export function parseReply(text, sourceOrigin, version = '') {
  const reply = decodeCode(text, 'reponse', version);
  if (reply.pub === undefined) throw new Error('inviteOld');
  const target = parseWebhookUrl(reply.url);
  if (!validReply(reply) || !target?.flat) throw new Error('codeInvalid');
  if (target.origin !== sourceOrigin) throw new Error('otherInstance');
  const out = {
    id: reply.id, secret: reply.secret || '', recipient: text200(reply.recipient, ['email', 'docId', 'team', 'at']), url: target.url, pub: reply.pub,
    version: codeVersion(reply),
  };
  return reply.retour === undefined ? out : { ...out, retour: reply.retour.map(({ table, dest }) => ({ table, dest })) };
}

// ---------------------------------------------------------------------------------------------
// Adresses

const parseUrl = (text) => {
  try {
    const url = new URL(String(text || '').trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch (e) {
    return null;
  }
};

// Lien « Copier le lien » d'un formulaire publié : https://<instance>[/o/<équipe>]/forms/<clé>/<n>
export function parseFormLink(link) {
  const url = parseUrl(link);
  const m = url && url.pathname.match(new RegExp(`^(${TEAM})/forms/([A-Za-z0-9]+)/\\d+/?$`));
  return m ? { origin: url.origin, prefix: m[1], key: m[2] } : null;
}

const writeUrl = ({ origin, prefix, key }, table) => `${origin}${prefix}/api/s/${key}/tables/${table}/records?flat=1`;

export function buildWebhookUrl(formLink, journalTable) {
  const form = parseFormLink(formLink);
  return form && isSafeId(journalTable) ? writeUrl(form, journalTable) : null;
}

// Adresse d'écriture d'un journal par une clé de formulaire. `url` : la même, réécrite.
export function parseWebhookUrl(text) {
  const url = parseUrl(text);
  const m = url && url.pathname.match(new RegExp(`^(${TEAM})/api/s/([A-Za-z0-9]+)/tables/([A-Za-z_][A-Za-z0-9_]*)/records$`));
  if (!m) return null;
  const parts = { origin: url.origin, prefix: m[1], key: m[2], table: m[3] };
  return { ...parts, flat: url.search === '?flat=1', url: writeUrl(parts, parts.table) };
}

// Boucles refusées à l'approbation : renvoyer une table reçue vers le document d'où elle vient
// (relais retour, ou table vers elle-même dans le même document). `received` : tables reçues ici,
// avec le document qui les envoie ({ dest, fromDocId }). Rend les tables en cause.
export function loopingTables(tables, recipientDocId, received) {
  if (!recipientDocId) return [];
  return tables.filter(table => received.some(r => r.dest === table && r.fromDocId === recipientDocId));
}

// La clé de partage est un droit d'écriture : on ne l'affiche jamais en entier, même dans un
// message d'erreur de Grist.
export const maskKey = text => String(text || '').replace(/\/(api\/s|forms)\/([A-Za-z0-9]{4})[A-Za-z0-9]*/g, '/$1/$2…');

// Le nom d'un document tel que Grist l'écrit dans son adresse (« slug ») : lettres et chiffres sans accent, séparés par
// des tirets. Grist n'en tient pas compte pour trouver le document (il ne sert qu'à lire l'adresse) : un nom un peu
// différent ouvre le même document.
export function docSlug(name) {
  return String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '');
}

// L'origine telle qu'on l'a reçue si c'est exactement une origine sûre (https, ou http pour un Grist local d'essai, sans
// chemin ni rien d'autre), sinon ''.
function safeOrigin(origin) {
  let base;
  try {
    base = new URL(String(origin || ''));
  } catch (e) {
    return '';
  }
  const secure = base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname));
  return secure && base.origin === origin ? origin : '';
}

// Adresse d'ouverture d'un document dans Grist, sous la forme que Grist écrit lui-même :
// `<instance>[/o/<équipe>]/<identifiant>/<nom>` (identifiant de 12 caractères au moins ; plus court, Grist écrit
// `/doc/<identifiant>`). Le nom est celui qu'on connaît (`name`, voir docSlug), « document » à défaut : Grist ne s'en
// sert pas pour trouver le document, et rétablit le sien. L'équipe, elle, est indispensable sur un site qui l'a dans
// son chemin : sans la bonne, Grist répond « Page non trouvée » (vérifié). Un espace personnel (`docs-<numéro>` dans la
// fiche d'un document) s'écrit `docs` dans les adresses de Grist (`normalizeOrgDomain`) : `docs-<numéro>` ne s'ouvre
// que pour son propriétaire. `origin` est celle de CE document, jamais celle d'un code : un lien ne quitte donc pas
// l'instance. https seulement (http pour un Grist local d'essai). '' si l'adresse n'est pas sûre.
export function docUrl(origin, team, docId, name = '') {
  if (!safeOrigin(origin) || !TEAM_ID.test(String(docId || '')) || (team && !TEAM_ID.test(String(team)))) return '';
  const site = /^docs-\d+$/.test(team || '') ? 'docs' : team;
  const where = `${origin}${site ? `/o/${site}` : ''}`;
  return docId.length >= 12 ? `${where}/${docId}/${docSlug(name) || 'document'}` : `${where}/doc/${docId}`;
}

// Ce que dit l'adresse d'une page de document, collée de la barre d'adresse du navigateur : `<instance>[/o/<équipe>]/<identifiant>[/<nom>[/p/<page>]]`
// ou `<instance>[/o/<équipe>]/doc/<identifiant>` (voir docUrl). Rend `{ origin, team, docId, name }`, ou null si ce n'en est pas une (ni
// http ni https, pas d'identifiant de la forme voulue). Le nom est celui que Grist écrit dans l'adresse : sans accent ni ponctuation, les mots
// séparés par des tirets (« Donnees-Ministere-2026-v2 » pour « Données Ministère 2026 (v2) »), absent pour un nom sans lettre latine
// (forme `/doc/`) ; « document » est le nom neutre de nos propres liens (docUrl), donc aucun nom.
export function parsePageAddress(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch (e) {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const found = addressParts(url.pathname.split('/').filter(Boolean).map(decoded));
  if (!TEAM_ID.test(found.docId) || (found.team && !TEAM_ID.test(found.team))) return null;
  const name = found.slug === 'document' ? '' : cleanLabel(found.slug.replace(/-+/g, ' '));
  return { origin: url.origin, team: found.team, docId: found.docId, name };
}

function decoded(part) {
  try {
    return decodeURIComponent(part);
  } catch (e) {
    return '';
  }
}

// Équipe, identifiant et nom (tel que Grist l'écrit) d'un chemin d'adresse de page ; le nom manque après `/doc/` et quand la suite
// est `/p/<page>`.
function addressParts(parts) {
  const team = parts[0] === 'o' ? parts[1] || '' : '';
  const rest = parts.slice(parts[0] === 'o' ? 2 : 0);
  const plain = rest[0] === 'doc';
  const after = rest.slice(plain ? 2 : 1);
  const page = after[0] === 'p' && /^\d+$/.test(after[1] || '');
  return { team, docId: (plain ? rest[1] : rest[0]) || '', slug: plain || page ? '' : after[0] || '' };
}

// Deux identifiants du même document : l'adresse d'une page porte l'identifiant court (au moins 12 caractères, règle de Grist) ou
// complet, l'API celui de son adresse REST ; un identifiant plus court que 12 caractères (choisi à la main) doit être identique.
const sameId = (a, b) => a === b || (a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a)));

// Le champ « Nom de ce document » de la SOURCE (un widget ne peut pas lire le nom de son document, voir rememberDocName) : un nom tapé tel
// quel, ou l'adresse de la page collée, dont on lit le nom (`parsePageAddress`). `here` : `{ origin, docId }` de CE document. Rend
// `{ kind, name }` : `typed` (le nom tapé, nettoyé), `address` (nom lu dans l'adresse), ou, sans nom (`name` vide, jamais l'adresse
// elle-même), `noName` (l'adresse ne contient pas de nom), `otherDoc` (l'identifiant n'est pas celui de ce document), `otherSite` (autre
// instance Grist), `invalid` (pas une adresse de page de document). Une adresse n'est jamais gardée ni envoyée : seul le nom en sort.
export function docNameFrom(input, here) {
  const text = String(input ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return { kind: 'typed', name: cleanLabel(text) };
  const page = parsePageAddress(text);
  if (!page) return { kind: 'invalid', name: '' };
  if (page.origin !== (here || {}).origin) return { kind: 'otherSite', name: '' };
  if (!sameId(String(here.docId || ''), page.docId)) return { kind: 'otherDoc', name: '' };
  return page.name ? { kind: 'address', name: page.name } : { kind: 'noName', name: '' };
}

// `baseUrl` renvoyé par getAccessToken : https://<instance>[/o/<équipe>]/api/docs/<docId>
export function parseDocBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const m = url.pathname.match(/^(?:\/o\/([^/]+))?\/api\/docs\/([^/]+)\/?$/);
  return { origin: url.origin, team: m ? m[1] || '' : '', docId: m ? m[2] : '' };
}

// Adresse REST d'un document, réécrite à partir de ses seuls éléments reconnus ; '' sinon.
function safeDocBaseUrl(text) {
  const url = parseUrl(text);
  if (!url || url.search) return '';
  const { team, docId } = parseDocBaseUrl(url.href);
  if (!/^[A-Za-z0-9_-]+$/.test(docId) || (team && !/^[A-Za-z0-9_-]+$/.test(team))) return '';
  return `${url.origin}${team ? `/o/${team}` : ''}/api/docs/${docId}`;
}
