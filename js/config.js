// Seul réglage du widget : les instances Grist d'où il charge l'API des widgets. Une instance qui
// héberge sa propre copie ajoute son adresse ici ET dans la politique de sécurité (balise
// Content-Security-Policy de index.html), aux mêmes endroits.
export const GRIST_ORIGINS = ['https://grist.numerique.gouv.fr', 'https://docs.getgrist.com'];

// Adresse officielle du widget, donnée dans les consignes à transmettre (jamais l'adresse d'où
// cette copie est servie : une copie piégée se ferait recommander). Une instance qui héberge sa
// propre copie, ou la publie dans sa galerie de widgets, met ici son adresse.
const WIDGET_URL = 'https://grist-factory.github.io/grist-widget-syncPlus/';

// Version de test (bêta), servie depuis sa propre adresse : ses codes ne se lisent pas par la
// version officielle, donc ses consignes donnent la sienne. Partout ailleurs, l'officielle.
const BETA_URL = 'https://lombre33.github.io/grist-widget-one-way-sync/';
export const servedAt = () => `${location.origin}${location.pathname}`.replace(/index\.html$/, '');
export const widgetUrl = () => (servedAt() === BETA_URL ? BETA_URL : WIDGET_URL);
// D'où cette copie est servie, pour le diagnostic.
export const servedFrom = () => ({ [BETA_URL]: 'bêta', [WIDGET_URL]: 'officielle' }[servedAt()] || servedAt());

export const VERSION = '0.30.4';
