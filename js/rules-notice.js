// Avis commun aux onglets Envoyer et Recevoir : Grist a refusé de poser les règles d'accès du widget (voir ruleRefusal).
// Tant qu'elles manquent, la table Synchro et les journaux se lisent comme le reste du document. Affiché aux
// propriétaires seulement (seuls eux posent des règles).
import { ruleRefusal } from './engine/acl.js';
import { message } from './ui.js';
import { t } from './i18n.js';

export function rulesRefusedNotice() {
  const why = ruleRefusal();
  return why ? message('err', t('rules.refused.body', { why }), t('rules.refused.title')) : null;
}
