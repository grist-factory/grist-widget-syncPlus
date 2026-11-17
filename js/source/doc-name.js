// SOURCE : le champ « Nom de ce document » de l'assistant de destinataire. Un widget ne peut pas lire le nom de son document (voir
// rememberDocName) : la personne le tape, ou colle l'adresse de la page (barre d'adresse du navigateur) d'où le nom est lu
// (docNameFrom, engine/logic/codes.js : sans accent ni ponctuation, comme Grist l'écrit dans l'adresse, à corriger au besoin).
// Une adresse collée est remplacée à l'instant par le nom lu, ou par rien avec la raison : l'adresse elle-même n'est jamais gardée.
import { docNameFrom } from '../engine/logic/codes.js';
import { docIdentity } from '../grist.js';
import { el, withHelp } from '../ui.js';
import { t } from '../i18n.js';

const NOTES = {
  address: ['info', 'send.docName.fromAddress'],
  noName: ['warn', 'send.docName.noName'],
  otherDoc: ['err', 'send.docName.otherDoc'],
  otherSite: ['err', 'send.docName.otherSite'],
  invalid: ['err', 'send.docName.invalid'],
};

// `initial` : le nom retenu. Rend `{ node, value }` : le bloc du champ, et le nom à retenir (jamais une adresse).
export async function docNameField(initial) {
  const here = await docIdentity().catch(() => null);
  const note = el('p', { role: 'status', hidden: true });
  const input = el('input', { type: 'text', class: 'input', id: 'gristsync-doc-name', maxlength: 2000, autocomplete: 'off', value: initial });
  const read = () => {
    const { kind, name } = docNameFrom(input.value, here);
    if (kind === 'typed') return name;
    const [tone, key] = NOTES[kind];
    input.value = name;
    note.className = `msg msg-${tone}`;
    note.setAttribute('role', tone === 'err' ? 'alert' : 'status');
    note.textContent = t(key);
    note.hidden = false;
    return name;
  };
  input.addEventListener('input', () => {
    if (docNameFrom(input.value, here).kind !== 'typed') read();
    else note.hidden = true;
  });
  const node = el('div', { class: 'form' }, withHelp(el('label', { for: 'gristsync-doc-name' }, t('send.docName')), t('send.docName.help')), input, note);
  return { node, value: () => docNameFrom(input.value, here).name };
}
