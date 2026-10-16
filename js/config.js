// Seul réglage du widget : les instances Grist d'où il charge l'API des widgets. Une instance qui
// héberge sa propre copie ajoute son adresse ici ET dans la politique de sécurité (balise
// Content-Security-Policy de index.html), aux mêmes endroits.
export const GRIST_ORIGINS = ['https://grist.numerique.gouv.fr', 'https://docs.getgrist.com'];

export const VERSION = '0.5.2';
