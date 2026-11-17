// Logique pure : le widget sur la page d'une table (voir pages.js, addWidgetToPage). (Ni DOM, ni `grist`, ni réseau.)
//
// Une section « Personnalisée » de Grist (`_grist_Views_section`, `parentKey` = 'custom') garde son adresse dans ses options :
// `{"customView": "{\"mode\":\"url\",\"url\":\"…\",\"access\":\"none\"}"}` (vérifié dans Grist 1.7 : la valeur de `customView`
// est elle-même un texte JSON). `access` est le niveau que la personne a accordé à cette section ; il reste à « none » tant
// qu'elle n'a pas cliqué « Accepter » dans le panneau de droite, c'est Grist qui le demande.
import { parseJson } from './common.js';
import { destPageViews } from './page-order.js';

// Adresse d'un widget, comparée sans la requête ni le fragment, sans « index.html » ni barre finale : `https://x.github.io/repo`,
// `https://x.github.io/repo/` et `https://x.github.io/repo/index.html?a=1` sont le même widget. Vide pour tout ce qui n'est pas http(s).
export function widgetAddress(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return `${parsed.origin}${parsed.pathname}`.replace(/index\.html$/, '').replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// Adresse (telle que la section la garde) d'une section « Personnalisée », ou ''.
export function customUrl(section) {
  if (section.parentKey !== 'custom') return '';
  const options = parseJson(section.options);
  const view = options && typeof options === 'object' ? options.customView : null;
  const def = typeof view === 'string' ? parseJson(view) : view;
  return def && typeof def === 'object' && typeof def.url === 'string' ? def.url : '';
}

// Où est le widget d'adresse `url` pour la table `dest` : `{ view, there }`. `view` : la page de la liste qui montre la table
// (voir destPageViews), null si elle n'en a pas ; `there` : une section du widget est déjà sur cette page.
export function widgetSpot(dest, url, tables, sections, pages) {
  const [view] = destPageViews([dest], tables, sections, pages);
  if (!view) return { view: null, there: false };
  const want = widgetAddress(url);
  return { view, there: Boolean(want) && sections.some(s => s.parentId === view && widgetAddress(customUrl(s)) === want) };
}

// L'adresse à écrire dans la nouvelle section : celle d'une section du document qui est déjà ce widget (la personne l'a
// écrite ainsi), sinon `url`. Texte d'un lien http(s) seulement.
export function sectionUrl(url, sections) {
  const want = widgetAddress(url);
  if (!want) return '';
  const known = sections.map(customUrl).find(u => widgetAddress(u) === want);
  return known || String(url);
}

// Options d'une section « Personnalisée » sur cette adresse, sans accès accordé (Grist le demande à la personne).
export const customOptions = url => JSON.stringify({ customView: JSON.stringify({ mode: 'url', url, access: 'none', renderAfterReady: false }) });
