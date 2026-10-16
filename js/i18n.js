// Textes de l'interface, français et anglais, dans i18n/fr.json et i18n/en.json (des données, pas
// du code). La langue est lue une fois au démarrage : le choix des Réglages, sinon la première des
// deux que propose le navigateur. Changer de langue recharge la page. Pluriels :
// « {n|singulier|pluriel} » (en français, 0 et 1 au singulier).
import { readPref } from './prefs.js';
import fr from '../i18n/fr.json' with { type: 'json' };
import en from '../i18n/en.json' with { type: 'json' };

const TEXTS = { fr, en };

function initialLang() {
  const stored = readPref('lang');
  if (stored === 'fr' || stored === 'en') return stored;
  for (const lang of navigator.languages || []) {
    const short = String(lang).slice(0, 2).toLowerCase();
    if (short === 'fr' || short === 'en') return short;
  }
  return navigator.languages && navigator.languages.length ? 'en' : 'fr';
}

export const LANG = initialLang();

// Typographie française : espace insécable avant « : ; ? ! » et à l'intérieur des guillemets, pour
// qu'aucun signe ne commence une ligne.
const frenchSpaces = text => text.replace(/ ([:;?!»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');

// format('fr', 'send.waiting', {n: 3}) -> « 3 envois en attente ». Les nombres s'écrivent à la
// façon de la langue (« 3 000 ») ; les autres valeurs (noms, adresses, détails d'erreur) restent
// telles quelles. Une clé absente d'une langue prend le texte français, puis la clé elle-même.
export function format(lang, key, vars = {}) {
  const text = TEXTS[lang][key] ?? TEXTS.fr[key] ?? key;
  const value = (name) => {
    const v = vars[name];
    return typeof v === 'number' ? v.toLocaleString(lang) : v;
  };
  return (lang === 'fr' ? frenchSpaces(text) : text)
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_, name, one, many) => {
      const n = Number(vars[name]);
      return (lang === 'fr' ? n <= 1 : n === 1) ? one : many;
    })
    .replace(/\{(\w+)\}/g, (_, name) => (value(name) ?? `{${name}}`));
}

export const t = (key, vars) => format(LANG, key, vars);

// Dates et heures à la façon de la langue (millisecondes, ou secondes pour timeText).
export const dateText = ms => new Date(ms).toLocaleString(LANG);
export const timeText = sec => new Date(sec * 1000).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });

// Type d'une colonne Grist, en clair : « Référence (Villes) », « Date et heure ».
export function typeName(type) {
  const [base, target] = String(type || '').split(':');
  const name = t(`type.${base}`) === `type.${base}` ? base : t(`type.${base}`);
  return /^Ref(List)?$/.test(base) && target ? `${name} (${target})` : name;
}

// Textes statiques de index.html : attributs data-i18n (contenu) et data-i18n-label (aria-label
// et title).
export function translatePage() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    el.title = t(el.dataset.i18nLabel);
  }
}
