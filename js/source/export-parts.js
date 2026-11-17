// Petites pièces de l'assistant d'export, partagées par ses écrans (export-wizard.js, export-links.js).
import { el } from '../ui.js';

// Nom d'une colonne dans une liste : son libellé, et son identifiant quand il diffère.
export const columnLabel = c => (c.label === c.id ? c.id : `${c.label} (${c.id})`);

// Bouton qui ouvre ou ferme une partie de la fenêtre ; `onOpen` à chaque ouverture.
export function togglePart(part, label, open, onOpen = () => {}) {
  part.classList.toggle('hidden', !open);
  const button = el('button', { class: 'btn btn-small', type: 'button', 'aria-expanded': String(open), onclick: () => {
    const now = part.classList.toggle('hidden') === false;
    button.setAttribute('aria-expanded', String(now));
    if (now) onOpen();
  } }, label);
  return button;
}
