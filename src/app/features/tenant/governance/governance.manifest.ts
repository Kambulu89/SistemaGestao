import { defineModule } from '../../../core/modules/define-module';

export const GOVERNANCE_MODULES = [
  defineModule({
    code: 'governance.compliance',
    name: 'Compliance, segurança e backup',
    description: 'Políticas de conformidade, segurança e cópias de segurança.',
    group: 'governance',
    icon: 'shield',
  }),
] as const;
