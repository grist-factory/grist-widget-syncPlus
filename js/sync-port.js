// Le port de syncPlus : ce que le moteur (js/engine/) attend de l'extérieur, rempli avec la page du widget.
// Grist, par `js/grist.js` (l'API des widgets, l'API REST et ses jetons) ; la langue, par `js/i18n.js` ;
// la page, par le navigateur ; deux petites valeurs par navigateur, par `js/prefs.js`. Une autre page
// (GFS) écrit le sien, avec la même forme (PORT_SHAPE, engine/port.js).
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, deleteWebhookWithNotice, docChanges, docIdentity, downloadAttachment, fetchRows, isOwner,
  journalStats, listWebhooks, postRows, postToHook, publicAccess, publicRecords, querySql, readSchema, renameWebhook, selectRows, setWebhookEnabled, shareInfo, uploadAttachment, webhookConditions, withLock,
} from './grist.js';
import { t } from './i18n.js';
import { readPref, writePref } from './prefs.js';

export const syncPort = {
  apply,
  clearWebhookQueue,
  createWebhook,
  deleteWebhook,
  deleteWebhookWithNotice,
  docChanges,
  docIdentity,
  downloadAttachment,
  fetchRows,
  isOwner,
  journalStats,
  listWebhooks,
  postRows,
  postToHook,
  publicAccess,
  publicRecords,
  querySql,
  readSchema,
  renameWebhook,
  selectRows,
  setWebhookEnabled,
  shareInfo,
  uploadAttachment,
  webhookConditions,
  withLock,
  text: t,
  page: {
    visible: () => document.visibilityState === 'visible',
    // Un assistant est ouvert (un changement de règles d'accès recharge le document, et le fermerait).
    busy: () => Boolean(document.querySelector('.scrim')),
    onShow: (callback) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') callback();
      });
    },
    onLeave: callback => window.addEventListener('pagehide', callback),
  },
  prefs: { read: readPref, write: writePref },
};
