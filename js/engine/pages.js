// Pages du document : formulaires de réception (un par journal, chacun sur sa page) et ménage des
// pages que laissent les tables techniques.
import { apply, fetchRows, readSchema, withLock } from './port.js';
import { parseJson, randomHex } from './logic/common.js';
import { receptionMark } from './logic/lost.js';
import { destPageViews, placeBelow } from './logic/page-order.js';
import { customOptions, sectionUrl, widgetSpot } from './logic/page-widget.js';

const published = section => (parseJson(section.shareOptions) || {}).publish === true;

// ---------------------------------------------------------------------------------------------
// Formulaires de réception

// Formulaire d'un journal, sur sa propre page. Grist donne une clé
// d'écriture par page partagée, et cette clé lit aussi les colonnes (descriptions comprises, donc
// la note) des tables de tous les formulaires de la page (vérifié) : une page par journal, et
// chaque expéditeur n'atteint que le sien. Mêmes actions que le bouton « Publier » de Grist ; le
// serveur crée alors la clé, que le widget ne peut pas lire : la personne copie le lien depuis la
// carte du formulaire. Idempotent. La page, nommée comme le journal, reste à la racine de la liste
// des pages, là où Grist la crée (en fin de liste) : on la trouve sans déplier la page du widget.
// Options : `below`, les tables qui reçoivent : la page se range, quand elle vient d'être créée (jamais
// après : une page rangée à la main n'est pas déplacée), juste sous la plus basse de leurs pages (voir
// placeBelow) ; `note`, la note de la réception : le partage, quand il vient d'être créé, garde de quoi
// reconnaître la réception si son journal est supprimé (voir lost.js et markReceptions).
export async function ensureForm(tableId, { below = [], note = null } = {}) {
  const table = (await readSchema()).table(tableId);
  let section = (await fetchRows('_grist_Views_section')).find(s => s.parentKey === 'form' && s.tableRef === table.id);
  if (!section) {
    const created = (await apply([['CreateViewSection', table.id, 0, 'form', null, null]])).retValues[0];
    section = { id: created.sectionRef, parentId: created.viewRef, shareOptions: '' };
    await apply([['UpdateRecord', '_grist_Views', created.viewRef, { name: tableId }]]);
    if (below.length) await placeForm(created.viewRef, below);
  }
  const page = (await fetchRows('_grist_Pages')).find(p => p.viewRef === section.parentId);
  if (!page.shareRef) {
    const description = note ? { description: receptionMark(tableId, note) } : {};
    const shareRef = (await apply([['AddRecord', '_grist_Shares', null, { linkId: randomHex(12), options: JSON.stringify({ publish: true }), ...description }]])).retValues[0];
    await apply([['UpdateRecord', '_grist_Pages', page.id, { shareRef }]]);
  }
  if (!published(section)) {
    await apply([['UpdateRecord', '_grist_Views_section', section.id, { shareOptions: JSON.stringify({ form: true, publish: true }) }]]);
  }
}

// Page du formulaire (sa vue) rangée sous la page des tables `dests`. Un détail de présentation : une
// erreur ne doit pas empêcher la réception.
async function placeForm(viewRef, dests) {
  try {
    const [tables, sections, pages] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section'), fetchRows('_grist_Pages')]);
    const spot = placeBelow(pages, destPageViews(dests, tables, sections, pages), viewRef);
    const mine = pages.find(p => p.viewRef === viewRef);
    if (spot && mine) await apply([['UpdateRecord', '_grist_Pages', mine.id, spot]]);
  } catch (e) {
    console.warn(e);
  }
}

// Formulaire publié de chaque table : { section, viewRef, name (de la page), shared (autres
// formulaires publiés sur la même page, donc atteints par la même clé : montage d'avant la 0.5) }.
export async function formPages() {
  const [sections, tables, views] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Tables'), fetchRows('_grist_Views')]);
  const forms = sections.filter(s => s.parentKey === 'form' && published(s));
  const pages = new Map();
  for (const section of forms) {
    const table = tables.find(tb => tb.id === section.tableRef);
    const view = views.find(v => v.id === section.parentId);
    const shared = forms.filter(s => s !== section && s.parentId === section.parentId).length;
    if (table) pages.set(table.tableId, { section: section.id, viewRef: section.parentId, name: view ? view.name : '', shared });
  }
  return pages;
}

// Couper le lien du formulaire de ce journal. Seul sur sa page : le partage de la page change
// d'identifiant, et Grist remplace sa clé (il efface celle d'un identifiant disparu, vérifié dans
// HomeDBManager.syncShares). Sur une page partagée avec d'autres formulaires : il quitte la page
// (la clé de la page ne l'atteint plus, vérifié) ; le prochain ensureForm lui en donne une à lui.
export async function renewFormLink(tableId) {
  await ensureForm(tableId);
  const form = (await formPages()).get(tableId);
  if (form.shared) {
    const [sections, views, pages] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Views'), fetchRows('_grist_Pages')]);
    const left = sections.filter(s => s.id !== form.section);
    await apply([['RemoveRecord', '_grist_Views_section', form.section], ...tidyActions(form.viewRef, left, views, pages)]);
    return;
  }
  const page = (await fetchRows('_grist_Pages')).find(p => p.viewRef === form.viewRef);
  await apply([['UpdateRecord', '_grist_Shares', page.shareRef, { linkId: randomHex(12) }]]);
}

// ---------------------------------------------------------------------------------------------
// Ménage

// Une page dont des sections ont disparu : leurs cases restent dans sa disposition, et dans sa
// barre des repliés (vérifié : les numéros de sections sont ensuite réutilisés). On les retire, et
// une page qui n'a plus de formulaire publié perd son partage : la clé d'écriture disparaît avec lui.
function tidyActions(viewRef, sections, views, pages) {
  const view = views.find(v => v.id === viewRef);
  if (!view) return [];
  const here = sections.filter(s => s.parentId === viewRef);
  const ids = new Set(here.map(s => s.id));
  const actions = [];
  const spec = parseJson(view.layoutSpec); // illisible : laissé tel quel
  if (spec) {
    const keep = box => (box.leaf !== undefined ? (ids.has(box.leaf) ? box : null) : { ...box, children: (box.children || []).map(keep).filter(Boolean) });
    const { collapsed = [], ...tree } = spec;
    const tidy = { ...keep(tree), collapsed: collapsed.filter(c => ids.has(c.leaf)) };
    if (!tidy.collapsed.length) delete tidy.collapsed;
    if (JSON.stringify(tidy) !== view.layoutSpec) actions.push(['UpdateRecord', '_grist_Views', viewRef, { layoutSpec: JSON.stringify(tidy) }]);
  }
  const page = pages.find(p => p.viewRef === viewRef);
  if (page && page.shareRef && !here.some(published) && !pages.some(p => p.id !== page.id && p.shareRef === page.shareRef)) {
    actions.push(['UpdateRecord', '_grist_Pages', page.id, { shareRef: 0 }], ['RemoveRecord', '_grist_Shares', page.shareRef]);
  }
  return actions;
}

// Une page du document montre cette table (sections d'une page de la liste, hors ses données brutes) :
// le widget lui-même, posé sur la table Synchro qu'une personne avait faite à la main (voir
// foreignSync). L'effacer ferait disparaître sa page, et le widget avec elle.
export async function isOnPage(tableId) {
  const [tables, sections, pages] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section'), fetchRows('_grist_Pages')]);
  const table = tables.find(tb => tb.tableId === tableId);
  const listed = new Set(pages.map(p => p.viewRef));
  return Boolean(table) && sections.some(s => s.tableRef === table.id && listed.has(s.parentId));
}

// ---------------------------------------------------------------------------------------------
// Le widget sur la page d'une table reçue

// Pour chaque table de `dests` : la page qui la montre et si le widget d'adresse `url` y est déjà (voir widgetSpot).
// Une `Map` table -> { view, there }. Trois lectures légères des métadonnées.
export async function widgetSpots(dests, url) {
  const [tables, sections, pages] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section'), fetchRows('_grist_Pages')]);
  return new Map(dests.map(dest => [dest, widgetSpot(dest, url, tables, sections, pages)]));
}

// Ajoute le widget d'adresse `url` à la page de la table `dest` : une section « Personnalisée » sur la page qui la montre,
// sans l'accès accordé (Grist le demande à la personne, dans le panneau de droite, quand elle ouvre la page : le widget ne se
// donne jamais l'accès complet). Le widget n'a pas besoin d'y être pour recopier (une page ouverte, n'importe laquelle, suffit
// pour tout le document) : c'est là que la personne reste. Ajouter une section à une autre page que celle du widget ne recharge
// pas le widget (vérifié). Rend `{ added, view }` (`added` faux : il y était déjà). Lève `noPageForTable` si la table n'a pas de
// page, `badWidgetUrl` si `url` n'est pas une adresse http(s). Une personne qui ne peut pas changer la structure du document
// reçoit le refus de Grist.
export async function addWidgetToPage(dest, url) {
  // Sous verrou : deux onglets qui cliquent ensemble ne posent pas la section deux fois (la lecture est refaite sous le verrou).
  return withLock('gristsync-widget-page', async () => {
    const [tables, sections, pages] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section'), fetchRows('_grist_Pages')]);
    const address = sectionUrl(url, sections);
    if (!address) throw new Error('badWidgetUrl');
    const spot = widgetSpot(dest, address, tables, sections, pages);
    if (!spot.view) throw new Error('noPageForTable');
    if (spot.there) return { added: false, view: spot.view };
    const table = tables.find(tb => tb.tableId === dest);
    const created = (await apply([['CreateViewSection', table.id, spot.view, 'custom', null, null]])).retValues[0];
    await apply([['UpdateRecord', '_grist_Views_section', created.sectionRef, { options: customOptions(address) }]]);
    return { added: true, view: spot.view };
  });
}

// Efface des tables techniques et les pages qu'elles laissent vides (dont celles de leurs
// formulaires), puis range les pages où il reste des sections.
export async function removeTechnicalTables(tableIds) {
  const schema = await readSchema();
  const ids = tableIds.filter(id => schema.has(id));
  if (!ids.length) return;
  const refs = new Set(ids.map(id => schema.table(id).id));
  const [before, pagesBefore] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Pages')]);
  const touched = new Set(before.filter(s => refs.has(s.tableRef)).map(s => s.parentId));
  const shared = new Set(pagesBefore.filter(p => touched.has(p.viewRef) && p.shareRef).map(p => p.shareRef));
  await apply(ids.map(id => ['RemoveTable', id]));
  const [sections, views, pages] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Views'), fetchRows('_grist_Pages')]);
  const left = new Set(sections.map(s => s.parentId));
  const still = [...touched].filter(v => views.some(view => view.id === v));
  // Une page vide disparaît (Grist efface déjà celle qui ne portait que le formulaire d'une table
  // effacée), et son partage avec elle : Grist le garderait, clé comprise (vérifié).
  const emptied = still.filter(v => !left.has(v));
  const orphans = [...shared].filter(ref => !pages.some(p => !emptied.includes(p.viewRef) && p.shareRef === ref));
  await apply([...emptied.map(v => ['RemoveView', v]), ...orphans.map(ref => ['RemoveRecord', '_grist_Shares', ref])]);
  await apply(still.filter(v => left.has(v)).flatMap(v => tidyActions(v, sections, views, pages)));
  // Les règles du widget sur ces tables restent jusqu'au prochain affichage d'un propriétaire
  // (voir syncRules) : les retirer ici ferait recharger le document, et donc le widget, avant la
  // fin de ce qui suit (vu : un participant retiré laissait l'Échange marqué « à plusieurs »).
  // Une règle qui nomme une table absente ne gêne rien d'autre que les changements de règles
  // (vérifié), et syncRules libère sa ressource.
}

// Tables techniques sans page : elles restent dans « Données source », pas dans la liste des
// pages. Seule la page propre à la table est retirée (celle qui ne montre qu'elle).
export async function dropPages(tableIds) {
  const [tables, sections] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section')]);
  const views = tables.filter(tb => tableIds.includes(tb.tableId) && tb.primaryViewId).filter(tb =>
    sections.filter(s => s.parentId === tb.primaryViewId).every(s => s.tableRef === tb.id)).map(tb => tb.primaryViewId);
  await apply(views.map(v => ['RemoveView', v]));
}

// Retire une colonne de la page principale de sa table (elle reste dans les données brutes).
export async function hideColumn(tableId, colId) {
  const table = (await fetchRows('_grist_Tables')).find(tb => tb.tableId === tableId);
  const column = (await fetchRows('_grist_Tables_column')).find(c => c.parentId === table.id && c.colId === colId);
  const sections = new Set((await fetchRows('_grist_Views_section')).filter(s => s.parentId === table.primaryViewId).map(s => s.id));
  const fields = (await fetchRows('_grist_Views_section_field')).filter(f => f.colRef === column.id && sections.has(f.parentId));
  await apply(fields.length ? [['BulkRemoveRecord', '_grist_Views_section_field', fields.map(f => f.id)]] : []);
}
