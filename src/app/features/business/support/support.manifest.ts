import { defineModule } from '../../../core/modules/define-module';

export const SUPPORT_MODULES = [
  defineModule({
    code: 'support.tickets',
    name: 'Tickets e SLA',
    description: 'Pedidos de suporte e acordos de nível de serviço.',
    group: 'support',
    icon: 'chat',
    dependencies: ['crm.customers'],
  }),
  defineModule({
    code: 'support.knowledge-base',
    name: 'Base de conhecimento',
    description: 'Artigos de ajuda e respostas reutilizáveis.',
    group: 'support',
    icon: 'book',
    dependencies: ['support.tickets'],
  }),
] as const;
