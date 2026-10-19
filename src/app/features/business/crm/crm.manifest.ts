import { defineModule } from '../../../core/modules/define-module';

export const CRM_MODULES = [
  defineModule({
    code: 'crm.customers',
    name: 'Clientes e contactos',
    description: 'Registo e histórico de clientes e contactos.',
    group: 'crm',
    icon: 'users',
    lifecycle: 'beta',
    features: [
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
    description: 'Funil comercial, leads e oportunidades.',
    group: 'crm',
    icon: 'bolt',
    dependencies: ['crm.customers'],
  }),
  defineModule({
    code: 'crm.campaigns',
    name: 'Campanhas e interações',
    description: 'Campanhas de marketing e registo de interações.',
    group: 'crm',
    icon: 'chat',
    dependencies: ['crm.customers'],
  }),
] as const;
