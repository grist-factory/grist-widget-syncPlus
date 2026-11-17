// Erreurs du moteur et leur texte pour la personne. Une erreur prévue est une `failure(code, valeurs)` :
// son message est le code, et le texte vient de la clé `error.<code>` (port.text). Les dernières
// erreurs sont gardées pour le diagnostic.
import { t } from './port.js';

// Texte d'une erreur pour la personne : celui de sa clé (`error.<message>`, avec ses valeurs
// `vars`), sinon une phrase générique avec le détail technique.
export const known = e => t(`error.${e.message}`) !== `error.${e.message}`;
// Refus d'une règle d'accès de Grist (« Blocked by table update access rules ») : dit où regarder.
const RULES_REFUSAL = /Blocked by [a-z ]*access rules/i;
export const errorText = (e) => {
  if (known(e)) return t(`error.${e.message}`, e.vars || {});
  const refusal = RULES_REFUSAL.exec(e.message || '');
  return refusal ? t('error.blockedRules', { detail: refusal[0] }) : t('error.generic', { detail: e.message || String(e) });
};
export const failure = (code, vars) => Object.assign(new Error(code), { vars });

// Erreurs récentes, pour le diagnostic (Réglages) : les ERRORS_KEPT dernières, avec leur heure.
const ERRORS_KEPT = 10;
export const recentErrors = [];
export function noteError(e) {
  recentErrors.push({ at: Date.now(), text: errorText(e) });
  if (recentErrors.length > ERRORS_KEPT) recentErrors.shift();
}
