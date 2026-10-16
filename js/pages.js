// Pages du document : formulaires de réception (un par journal, chacun sur sa page) et ménage des
// pages que laissent les tables techniques.
import { apply, fetchRows, readSchema } from './grist.js';
import { randomHex } from './logic/common.js';

const published = section => JSON.parse(section.shareOptions || '{}').publish === true;

// ---------------------------------------------------------------------------------------------
// Formulaires de réception

// Formulaire d'un journal, sur sa propre page. Grist donne une clé
// d'écriture par page partagée, et cette clé lit aussi les colonnes (descriptions comprises, donc
// la note) des tables de tous les formulaires de la page (vérifié) : une page par journal, et
// chaque expéditeur n'atteint que le sien. Mêmes actions que le bouton « Publier » de Grist ; le
// serveur crée alors la clé, que le widget ne peut pas lire : la personne copie le lien depuis la
// carte du formulaire. Idempotent. La page, nommée comme le journal, reste à la racine de la liste
// des pages, là où Grist la crée (en fin de liste) : on la trouve sans déplier la page du widget.
export async function ensureForm(tableId) {
  const table = (await readSchema()).table(tableId);
  let section = (await fetchRows('_grist_Views_section')).find(s => s.parentKey === 'form' && s.tableRef === table.id);
  if (!section) {
    const created = (await apply([['CreateViewSection', table.id, 0, 'form', null, null]])).retValues[0];
    section = { id: created.sectionRef, parentId: created.viewRef, shareOptions: '' };
    await apply([['UpdateRecord', '_grist_Views', created.viewRef, { name: tableId }]]);
  }
  const page = (await fetchRows('_grist_Pages')).find(p => p.viewRef === section.parentId);
  if (!page.shareRef) {
    const shareRef = (await apply([['AddRecord', '_grist_Shares', null, { linkId: randomHex(12), options: JSON.stringify({ publish: true }) }]])).retValues[0];
    await apply([['UpdateRecord', '_grist_Pages', page.id, { shareRef }]]);
  }
  if (!published(section)) {
    await apply([['UpdateRecord', '_grist_Views_section', section.id, { shareOptions: JSON.stringify({ form: true, publish: true }) }]]);
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
  if (view.layoutSpec) {
    const keep = box => (box.leaf !== undefined ? (ids.has(box.leaf) ? box : null) : { ...box, children: (box.children || []).map(keep).filter(Boolean) });
    const { collapsed = [], ...tree } = JSON.parse(view.layoutSpec);
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
}

// Tables techniques sans page : elles restent dans « Données source », pas dans la liste des
// pages. Seule la page propre à la table est retirée (celle qui ne montre qu'elle).
export async function dropPages(tableIds) {
  const [tables, sections] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section')]);
  const views = tables.filter(tb => tableIds.includes(tb.tableId) && tb.primaryViewId).filter(tb =>
    sections.filter(s => s.parentId === tb.primaryViewId).every(s => s.tableRef === tb.id)).map(tb => tb.primaryViewId);
  await apply(views.map(v => ['RemoveView', v]));
}

// Page commune aux vues d'export de la version 0.3 (SOURCE), effacée avec l'ancien montage. 0 si
// elle n'existe pas.
export async function exportsViewRef() {
  const view = (await fetchRows('_grist_Views')).find(v => v.name === 'Synchro_Exports');
  return view ? view.id : 0;
}

// Retire une colonne de la page principale de sa table (elle reste dans les données brutes).
export async function hideColumn(tableId, colId) {
  const table = (await fetchRows('_grist_Tables')).find(tb => tb.tableId === tableId);
  const column = (await fetchRows('_grist_Tables_column')).find(c => c.parentId === table.id && c.colId === colId);
  const sections = new Set((await fetchRows('_grist_Views_section')).filter(s => s.parentId === table.primaryViewId).map(s => s.id));
  const fields = (await fetchRows('_grist_Views_section_field')).filter(f => f.colRef === column.id && sections.has(f.parentId));
  await apply(fields.length ? [['BulkRemoveRecord', '_grist_Views_section_field', fields.map(f => f.id)]] : []);
}
