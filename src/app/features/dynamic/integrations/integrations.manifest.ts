import { defineModule } from '../../../core/modules/define-module';

export const INTEGRATIONS_MODULES = [
  defineModule({
    code: 'integrations.api-webhooks',
    name: 'API e Webhooks',
    description: 'Chaves de API e notificações para sistemas externos.',
    group: 'integrations',
    icon: 'link',
  }),
  defineModule({
    code: 'integrations.erp-import',
    name: 'Importação de ERP',
    description: 'Migração e sincronização de dados de ERP externos.',
    group: 'integrations',
    icon: 'link',
  }),
] as const;
