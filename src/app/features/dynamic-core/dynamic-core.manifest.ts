import { defineModule } from '../../core/modules/define-module';

/**
 * "Custom Fields e Form Builder": o módulo que oferece o Core Dinâmico. É o dono das entidades
 * configuráveis. A administração (só de leitura nesta fase) vive em Configuração → Core Dinâmico.
 */
export const DYNAMIC_CORE_MODULES = [
  defineModule({
    code: 'configuration.forms',
    name: 'Custom Fields e Form Builder',
    description: 'Campos personalizados e construtor de formulários (Core Dinâmico).',
    group: 'configuration',
    icon: 'settings',
    featureFlag: 'configuration.form-builder',
    routes: [
      {
        path: '',
        title: 'Core Dinâmico',
        permission: 'configuration.forms.read',
        loadComponent: () =>
          import('./entity-admin/entity-admin-list-page').then((m) => m.EntityAdminListPage),
      },
      {
        path: ':entityKey/campos',
        title: 'Campos personalizados',
        permission: 'configuration.forms.read',
        loadComponent: () =>
          import('./custom-fields/custom-fields-page').then((m) => m.CustomFieldsPage),
      },
      {
        path: ':entityKey',
        title: 'Definição da entidade',
        permission: 'configuration.forms.read',
        loadComponent: () =>
          import('./entity-admin/entity-admin-detail-page').then((m) => m.EntityAdminDetailPage),
      },
    ],
  }),
] as const;
