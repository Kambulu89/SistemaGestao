import { defineModule } from '../../../core/modules/define-module';

export const CRM_MODULES = [
  defineModule({
    code: 'crm.customers',
    name: 'Clientes e contactos',
    description: 'Registo e histórico de clientes e contactos.',
    group: 'crm',
    icon: 'users',
    lifecycle: 'beta',
    // Módulo `customers` do servidor (M01): funcionalidades `customers.accounts` e `customers.interactions`.
    backendModule: 'customers',
    routes: [
      {
        path: '',
        title: 'Clientes',
        permission: 'crm.customers.read',
        loadComponent: () => import('./customers/customers-page').then((m) => m.CustomersPage),
      },
    ],
    features: [
      {
        id: 'accounts',
        name: 'Clientes e segmentos',
        description: 'Clientes sobre a Party, segmentos, crédito e bloqueio.',
      },
      {
        id: 'interactions',
        name: 'Interacções comerciais',
        description: 'Chamadas, emails, reuniões e notas sobre uma Party.',
      },
      {
        id: 'import',
        name: 'Importação de contactos',
        description: 'Importar clientes a partir de ficheiros.',
        flag: 'crm.import',
        permission: 'crm.customers.manage',
      },
      {
        id: 'dedupe',
        name: 'Detecção de duplicados',
        description: 'Sugere a fusão de registos duplicados.',
      },
    ],
    settings: [{ key: 'requireTaxId', label: 'Exigir NIF', type: 'boolean', defaultValue: false }],
  }),
  defineModule({
    code: 'crm.pipeline',
    name: 'Leads e oportunidades',
    description: 'Funil comercial, leads, oportunidades e campanhas.',
    group: 'crm',
    icon: 'bolt',
    lifecycle: 'beta',
    dependencies: ['crm.customers'],
    // Módulo `prospecting` do servidor (M02): funcionalidades `prospecting.leads|opportunities|campaigns`.
    backendModule: 'prospecting',
    features: [
      { id: 'leads', name: 'Leads', description: 'Qualificar, desqualificar e converter leads.' },
      {
        id: 'opportunities',
        name: 'Pipeline e oportunidades',
        description: 'Quadro e lista por etapas, histórico de transições e actividades.',
      },
      {
        id: 'campaigns',
        name: 'Campanhas',
        description: 'Público, envio com consentimento e lista de exclusão.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Leads e oportunidades',
        permission: 'crm.pipeline.read',
        loadComponent: () =>
          import('./prospecting/prospecting-page').then((m) => m.ProspectingPage),
      },
    ],
  }),
  defineModule({
    code: 'crm.campaigns',
    name: 'Campanhas e interações',
    description: 'Campanhas de marketing e registo de interações.',
    group: 'crm',
    icon: 'chat',
    dependencies: ['crm.customers'],
    backendModule: 'prospecting',
    // As campanhas vivem na página «Leads e oportunidades» do módulo anterior, que tem o mesmo acesso.
    routes: [
      {
        path: '',
        title: 'Campanhas e interações',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
] as const;
