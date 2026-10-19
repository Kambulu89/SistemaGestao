import { defineModule } from '../../../core/modules/define-module';

export const ORGANIZATION_MODULES = [
  defineModule({
    code: 'organization.cost-centers',
    name: 'Centros de custo',
    description: 'Estrutura de centros de custo para imputação financeira.',
    group: 'organization',
    icon: 'building',
  }),
] as const;
