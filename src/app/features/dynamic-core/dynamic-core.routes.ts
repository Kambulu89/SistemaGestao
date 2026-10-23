import type { ModuleRouteDef } from '../../core/modules/module.model';

/**
 * Páginas de administração do Core Dinâmico (definição de entidades e campos). Cada uma exige a sua
 * permissão (`configuration.forms.*`, traduzida das permissões `entity.*` do servidor).
 */
export const DYNAMIC_CORE_ROUTES: readonly ModuleRouteDef[] = [
  {
    path: '',
    title: 'Core Dinâmico',
    permission: 'configuration.forms.read',
    loadComponent: () =>
      import('./entity-admin/entity-admin-list-page').then((m) => m.EntityAdminListPage),
  },
  {
    path: 'novo',
    title: 'Nova entidade',
    permission: 'configuration.forms.manage',
    loadComponent: () =>
      import('./entity-designer/entity-designer-page').then((m) => m.EntityDesignerPage),
  },
  {
    path: ':entityKey/editar',
    title: 'Editar entidade',
    permission: 'configuration.forms.manage',
    loadComponent: () =>
      import('./entity-designer/entity-designer-page').then((m) => m.EntityDesignerPage),
  },
  {
    path: ':entityKey/campos',
    title: 'Campos personalizados',
    permission: 'configuration.forms.read',
    loadComponent: () =>
      import('./custom-fields/custom-fields-page').then((m) => m.CustomFieldsPage),
  },
  {
    path: ':entityKey/formularios',
    title: 'Formulários da entidade',
    permission: 'configuration.form-layouts.read',
    loadComponent: () => import('./forms/entity-forms-page').then((m) => m.EntityFormsPage),
  },
  {
    path: ':entityKey/regras',
    title: 'Regras da entidade',
    permission: 'configuration.rules.read',
    loadComponent: () => import('./rules/entity-rules-page').then((m) => m.EntityRulesPage),
  },
  {
    path: ':entityKey',
    title: 'Definição da entidade',
    permission: 'configuration.forms.read',
    loadComponent: () =>
      import('./entity-admin/entity-admin-detail-page').then((m) => m.EntityAdminDetailPage),
  },
];
