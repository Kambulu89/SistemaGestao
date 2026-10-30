import { defineModule } from '../../core/modules/define-module';

/**
 * "Custom Fields e Form Builder": o módulo do catálogo a que pertencem as entidades configuráveis
 * dos tenants simulados (testes). As páginas de administração do Core Dinâmico real (C10) não dependem
 * da contratação de um módulo: estão em `dynamic-core.routes.ts`, montadas em `tenant.routes`.
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
        title: 'Custom Fields e Form Builder',
        loadComponent: () =>
          import('../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
    permissions: [
      { key: 'configuration.forms.read', name: 'Ver o Core Dinâmico' },
      {
        key: 'configuration.forms.manage',
        name: 'Gerir entidades e campos personalizados (rascunhos)',
      },
      {
        key: 'configuration.forms.publish',
        name: 'Publicar e arquivar entidades e campos personalizados',
      },
    ],
  }),
] as const;
