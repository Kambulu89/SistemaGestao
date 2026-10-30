import { defineModule } from '../../../core/modules/define-module';

export const WORKFLOW_MODULES = [
  defineModule({
    code: 'workflow.flows',
    name: 'Fluxos e aprovações',
    description: 'Fluxos configuráveis e circuitos de aprovação.',
    group: 'workflow',
    icon: 'bolt',
    lifecycle: 'beta',
    routes: [
      {
        path: '',
        title: 'Fluxos e aprovações',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
    features: [
      {
        id: 'multi-level-approvals',
        name: 'Aprovações multinível',
        description: 'Cadeias de aprovação com vários níveis.',
      },
    ],
  }),
  defineModule({
    code: 'workflow.rules',
    name: 'Regras e automações',
    description: 'Regras e automações declarativas.',
    group: 'workflow',
    icon: 'bolt',
    dependencies: ['workflow.flows'],
    featureFlag: 'workflow.automations',
    routes: [
      {
        path: '',
        title: 'Regras e automações',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
] as const;
