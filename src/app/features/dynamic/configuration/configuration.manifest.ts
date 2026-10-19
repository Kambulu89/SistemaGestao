import { defineModule } from '../../../core/modules/define-module';

export const CONFIGURATION_MODULES = [
  defineModule({
    code: 'configuration.forms',
    name: 'Custom Fields e Form Builder',
    description: 'Campos personalizados e construtor de formulários.',
    group: 'configuration',
    icon: 'settings',
    featureFlag: 'configuration.form-builder',
  }),
  defineModule({
    code: 'configuration.localization',
    name: 'Numeração, idiomas, moedas e impostos',
    description: 'Séries de numeração, idiomas, moedas e impostos.',
    group: 'configuration',
    icon: 'settings',
  }),
] as const;
