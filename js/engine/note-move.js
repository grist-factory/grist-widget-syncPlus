// Déplace dans les options des colonnes les notes du widget qu'une version d'avant la 3.0.0 avait mises
// dans leur description (voir logic/note-store.js). Appelé par la SOURCE (ensureSyncTable) et par la
// CIBLE (chaque passage de recopie) ; une note déjà déplacée ne coûte rien : le schéma que l'appelant a
// déjà lu dit qu'il n'y a rien à faire. Avant d'écrire, le schéma est relu sous un verrou : une note que
// la page d'un autre onglet vient de déplacer, puis de changer, ne doit pas être remplacée par sa copie
// d'avant. Une personne qui ne peut pas écrire (lecteur) essaie sans bruit : le déplacement se fera à
// la prochaine ouverture par quelqu'un qui le peut. Rend vrai si le document a changé.
import { legacyNoteActions } from './logic/note-store.js';
import { apply, readSchema, withLock } from './port.js';

export async function moveNotes(schema) {
  if (!legacyNoteActions(schema).length) return false;
  try {
    return await withLock('gristsync-note-move', async () => {
      const actions = legacyNoteActions(await readSchema());
      if (actions.length) await apply(actions);
      return actions.length > 0;
    });
  } catch (e) {
    console.warn(e);
    return false;
  }
}
