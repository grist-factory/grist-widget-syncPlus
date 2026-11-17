// Table ajoutée à l'export pour garder le lien d'une Référence (voir linkOffers de engine/logic/links.js) : ce qu'elle envoie.
// Trois choix, faits dans son panneau de l'étape Contenu :
//  - 'shown' (d'emblée) : la seule colonne que le lien affiche, rien de plus ;
//  - 'all' : toutes les colonnes de la table, sauf les Pièces jointes (elles ne partent que cochées : leurs fichiers partent page ouverte
//    et peuvent peser lourd), que la personne ajoute par 'pick' ;
//  - 'pick' : la colonne affichée (toujours envoyée, verrouillée) et celles que la personne coche.
// Logique pure : l'écran donne les colonnes envoyables de la table (`usable`, exportableColumns), celles que le lien exige (`required`) et
// celles que la personne a cochées en plus (`extras`) ; le moteur ne connaît que la liste finale (`saveChosenExport`).
import { isFileColumn } from '../engine/logic/exports.js';

export const PULL_MODES = ['shown', 'all', 'pick'];

// Colonnes envoyées par une table ajoutée pour un lien, dans l'ordre : celles que le lien exige, puis les autres.
export function pullColumns({ mode = 'shown', usable = [], required = [], extras = [] }) {
  const more = mode === 'all' ? usable.filter(c => !isFileColumn(c)).map(c => c.id) : mode === 'pick' ? extras : [];
  return [...new Set([...required, ...more])];
}

// Colonnes de Pièces jointes que « toute la table » laisse de côté (à dire à la personne).
export const pullLeftOut = ({ mode = 'shown', usable = [] }) => (mode === 'all' ? usable.filter(isFileColumn) : []);

// Le choix qui décrit des colonnes déjà cochées : passer de « toute la table » à « choisir » garde ce qui partait, pour pouvoir y retirer.
export const extrasFor = ({ usable = [], required = [], columns = [] }) => columns.filter(id => !required.includes(id) && usable.some(c => c.id === id));
