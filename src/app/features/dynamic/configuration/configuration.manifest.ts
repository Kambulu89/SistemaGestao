import { defineModule } from '../../../core/modules/define-module';

export const CONFIGURATION_MODULES = [
  defineModule({
    code: 'configuration.localization',
    name: 'Numeração, idiomas, moedas e impostos',
    description: 'Séries de numeração, idiomas, moedas e impostos.',
    group: 'configuration',
    icon: 'settings',
  }),
] as const;
