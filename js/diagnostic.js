// Diagnostic à copier (Réglages) : le moteur relit le document et écrit le texte (engine/diagnostic.js) ;
// cet écran ne dit que ce qu'il est seul à savoir : la version, d'où le widget est servi, si la personne
// ne fait que lire, et son navigateur.
import { diagnostic as engineDiagnostic } from './engine/diagnostic.js';
import { isReadOnly } from './grist.js';
import { VERSION, servedFrom } from './config.js';

export const diagnostic = () => engineDiagnostic({ version: VERSION, served: servedFrom(), readOnly: isReadOnly(), agent: navigator.userAgent });
