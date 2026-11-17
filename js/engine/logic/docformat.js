// Langue et monnaie d'un document Grist (`documentSettings` de la table interne `_grist_DocInfo`). Ce n'est
// pas un réglage de colonne : Grist écrit les séparateurs de tous les nombres d'après la langue du document
// (`fr-FR` : 1 234,50 ; `en-US` : 1,234.50), et la monnaie d'une colonne « Devise » sans monnaie propre est
// celle du document, sinon celle de la langue. Un document neuf est en `en-US` : une table copiée dans un
// document neuf s'y écrit à l'américaine (et en dollars) quoi que dise sa colonne. La SOURCE dit donc la langue
// et la monnaie de son document (`doc`, voir exports.js) ; la CIBLE les compare aux siennes et ne les change que
// sur un geste d'un propriétaire.
import { parseJson } from './common.js';

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DEFAULT_LOCALE = 'en-US'; // celle de Grist quand le document n'en dit pas

// Monnaie de chaque pays (la langue du document la donne, voir currencyOf). Peu de pays : un pays absent
// n'est pas deviné, la monnaie reste celle que le document d'ici dira.
const COUNTRY_CURRENCY = {
  ...Object.fromEntries('AD AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MC ME MT NL PT SI SK SM VA'.split(' ').map(c => [c, 'EUR'])),
  US: 'USD', GB: 'GBP', CH: 'CHF', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK',
  HU: 'HUF', RO: 'RON', BG: 'BGN', MA: 'MAD', DZ: 'DZD', TN: 'TND', BR: 'BRL', MX: 'MXN', IN: 'INR', CN: 'CNY',
  ...Object.fromEntries('BJ BF CI GW ML NE SN TG'.split(' ').map(c => [c, 'XOF'])),
  ...Object.fromEntries('CM CF TD CG GA GQ'.split(' ').map(c => [c, 'XAF'])),
};

// Langue et monnaie lues dans `documentSettings` (texte JSON ou objet) : { locale?, currency? } ; seules des
// valeurs de la forme voulue passent. Null s'il n'y a ni l'une ni l'autre.
export function docFormat(settings) {
  const raw = typeof settings === 'string' ? parseJson(settings, null) : settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const locale = typeof raw.locale === 'string' && LOCALE.test(raw.locale) ? raw.locale : '';
  const currency = typeof raw.currency === 'string' && CURRENCY.test(raw.currency) ? raw.currency : '';
  return locale || currency ? { ...(locale ? { locale } : {}), ...(currency ? { currency } : {}) } : null;
}

// Réglages du document lus dans les lignes de `_grist_DocInfo`.
export const docFormatOf = rows => docFormat((rows && rows[0] ? rows[0].documentSettings : null));

// Monnaie effective d'un document : la sienne, sinon celle de sa langue ; '' si on ne la connaît pas.
export function currencyOf(format) {
  const have = docFormat(format);
  if (!have) return '';
  const country = (/-([A-Z]{2})$/.exec(have.locale || DEFAULT_LOCALE) || [])[1];
  return have.currency || COUNTRY_CURRENCY[country] || '';
}

// Ce qui diffère entre le document de la SOURCE (`sent`) et celui-ci (`here`) : { locale: [source, ici],
// currency: [source, ici] }, ou null s'ils s'écrivent pareil. La monnaie ne compte que si la SOURCE a une
// monnaie connue.
export function formatGap(sent, here) {
  const [a, b] = [docFormat(sent), docFormat(here)];
  if (!a) return null;
  const gap = {};
  if (a.locale && a.locale !== ((b && b.locale) || DEFAULT_LOCALE)) gap.locale = [a.locale, (b && b.locale) || DEFAULT_LOCALE];
  const [from, to] = [currencyOf(a), currencyOf(b || {})];
  if (from && from !== to) gap.currency = [from, to];
  return Object.keys(gap).length ? gap : null;
}

// L'action qui met la langue et la monnaie du document d'ici d'accord avec `wanted` (celles de la SOURCE) :
// seules ces deux clés changent, le reste des réglages (moteur de calcul…) est gardé. Une monnaie que la SOURCE
// ne fixe pas (elle suit sa langue) est retirée d'ici, pour suivre la langue de la même façon. Null s'il n'y a
// rien à changer.
export function formatAction(rows, wanted) {
  const want = docFormat(wanted);
  const row = rows && rows[0];
  if (!want || !row) return null;
  const here = parseJson(row.documentSettings, null);
  const next = { ...(here && typeof here === 'object' && !Array.isArray(here) ? here : {}) };
  if (want.locale) next.locale = want.locale;
  if (want.currency) next.currency = want.currency;
  else delete next.currency;
  return JSON.stringify(next) === JSON.stringify(here) ? null : ['UpdateRecord', '_grist_DocInfo', row.id, { documentSettings: JSON.stringify(next) }];
}
