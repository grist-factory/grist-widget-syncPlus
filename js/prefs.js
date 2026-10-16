// Préférences de la personne dans le stockage local du navigateur : langue, thème, l'heure de sa
// dernière visite par document CIBLE (`visit.<docId>`, pour l'historique) et un identifiant
// tiré au hasard pour ce navigateur (`browser`, voir chargeBusy). Aucune donnée du document n'y est
// écrite.
const PREFIX = 'gristsync.';

export function readPref(name) {
  try { return localStorage.getItem(PREFIX + name); } catch (e) { return null; }
}

export function writePref(name, value) {
  try { localStorage.setItem(PREFIX + name, value); return true; } catch (e) { return false; }
}

export function applyTheme() {
  const theme = readPref('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
