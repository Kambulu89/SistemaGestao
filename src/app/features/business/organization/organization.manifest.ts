import { defineModule } from '../../../core/modules/define-module';

export const ORGANIZATION_MODULES = [
  defineModule({
    code: 'organization.cost-centers',
    name: 'Centros de custo',
    description: 'Estrutura de centros de custo para imputação financeira.',
    group: 'organization',
    icon: 'building',
    routes: [
      {
        path: '',
        title: 'Centros de custo',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
] as const;
