// Codes échangés entre SOURCE et CIBLE (préfixe + JSON en base64url, sur une ligne) et adresses
// Grist qu'ils portent. Tout ce qui vient d'un code collé est contrôlé ici : identifiants, colonnes,
// adresses réécrites à partir de leurs seuls éléments reconnus.
import { HEX16, is, isSafeId, parseJson } from './common.js';

const CODE_PREFIX = 'GRISTSYNC2.';
const SECRET = /^[0-9a-f]{32}$/;
// Types de colonnes qu'un export envoie (une Référence part en texte, une pièce jointe ne part pas).
const SENT_TYPE = /^(Any|Bool|Choice|ChoiceList|Date|DateTime(:[A-Za-z0-9_/+-]+)?|Int|Numeric|Text)$/;
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

const encodeCode = payload => CODE_PREFIX + toBase64Url(JSON.stringify(payload));

// Un code recopié d'un courriel peut avoir été coupé en plusieurs lignes : les blancs sont ôtés.
export function decodeCode(text, kind) {
  const raw = String(text || '').replace(/\s+/g, '');
  if (raw.startsWith('GRISTSYNC1.')) throw new Error('codeOld');
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('codeFormat');
  const payload = parseJson(fromBase64Url(raw.slice(CODE_PREFIX.length)));
  if (!payload) throw new Error('codeFormat');
  if (payload.kind !== kind) throw new Error(kind === 'invitation' ? 'notInvitation' : 'notReply');
  return payload;
}

// Colonnes envoyées, telles qu'un code ou un journal les décrit : [{ id, type, label, as }]. Dans un
// Échange, `as` donne le nom de la colonne dans l'autre document (voir exchangeTables).
export function validColumns(cols) {
  return Array.isArray(cols) && cols.length > 0 && cols.length <= MAX_COLUMNS && new Set(cols.map(c => c && c.id)).size === cols.length &&
    cols.every(c => c && isSafeId(c.id) && is(SENT_TYPE, c.type) && (c.as === undefined || isSafeId(c.as)));
}

export const exportSchema = columns => columns.map(({ id, type, label, as }) => ({
  id, type, ...(typeof label === 'string' ? { label: label.slice(0, 200) } : {}), ...(as ? { as } : {}),
}));

const text200 = (from, keys) => Object.fromEntries(keys.map(k => [k, String(from[k] ?? '').slice(0, 200)]));

// ---------------------------------------------------------------------------------------------
// Invitation (SOURCE -> CIBLE) et réponse (CIBLE -> SOURCE)

// Une invitation donne accès à un export (`export`, ses tables et colonnes) pour une personne :
// `id` la désigne dans la réponse ; `secret`, facultatif et choisi à la création, prouve que la
// réponse vient de quelqu'un qui l'a reçue (la SOURCE n'en garde que l'empreinte).
// Mode « lien public » (`base` : adresse REST du document SOURCE) : pas de réponse, la CIBLE lit
// les instantanés de l'export elle-même, sans identifiant. Mode « Échange » (`retour` : adresse
// d'écriture du journal de retour de la SOURCE) : la CIBLE renvoie ses modifications à cette
// adresse, par un webhook à elle. Ce code-là est donc un droit d'écriture.
export function buildInvitation({ id, exportId, name, origin, secret = '', from = {}, tables, base = '', retour = '' }) {
  return encodeCode({
    kind: 'invitation', id, export: exportId, name, origin, secret, from,
    ...(base ? { mode: 'public', base } : retour ? { mode: 'echange', retour } : {}),
    tables: tables.map(({ table, columns }) => ({ table, columns: exportSchema(columns) })),
  });
}

function validInvitation(inv) {
  return is(HEX16, inv.id) && is(HEX16, inv.export) && typeof inv.name === 'string' && (!inv.secret || is(SECRET, inv.secret))
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

export function parseInvitation(text) {
  const inv = decodeCode(text, 'invitation');
  const mode = validInvitation(inv) ? invitationMode(inv) : null;
  if (!mode) throw new Error('codeInvalid');
  const from = inv.from && typeof inv.from === 'object' ? inv.from : {};
  return {
    id: inv.id, export: inv.export, name: inv.name.slice(0, 200), secret: inv.secret || '', origin: String(inv.origin || ''), ...mode,
    from: text200(from, ['email', 'docId']),
    tables: inv.tables.map(tb => ({ table: tb.table, columns: exportSchema(tb.columns) })),
  };
}

// `url` : l'adresse d'écriture du journal de l'export dans la CIBLE. Échange : `retour` dit où la
// CIBLE a rangé chaque table ([{ table: table de la CIBLE, dest: table de la SOURCE }]).
export function buildReply({ id, secret = '', recipient, url, retour = null }) {
  return encodeCode({ kind: 'reponse', id, secret, recipient, url, ...(retour ? { retour } : {}) });
}

// Tables d'un Échange dans la réponse : chacune nommée, une seule fois de chaque côté.
function validRetour(back) {
  const unique = key => new Set(back.map(b => b && b[key])).size === back.length;
  return Array.isArray(back) && back.length > 0 && back.every(b => b && isSafeId(b.table) && isSafeId(b.dest)) && unique('table') && unique('dest');
}

// `sourceOrigin` : origine de l'instance du document SOURCE. Le webhook ne part que vers la même
// instance, à une adresse d'écriture par clé de formulaire, rien d'autre.
export function parseReply(text, sourceOrigin) {
  const reply = decodeCode(text, 'reponse');
  const target = parseWebhookUrl(reply.url);
  const ok = is(HEX16, reply.id) && (!reply.secret || is(SECRET, reply.secret)) && target && target.flat
    && reply.recipient && typeof reply.recipient === 'object' && (reply.retour === undefined || validRetour(reply.retour));
  if (!ok) throw new Error('codeInvalid');
  if (target.origin !== sourceOrigin) throw new Error('otherInstance');
  const out = { id: reply.id, secret: reply.secret || '', recipient: text200(reply.recipient, ['email', 'docId', 'team', 'at']), url: target.url };
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
