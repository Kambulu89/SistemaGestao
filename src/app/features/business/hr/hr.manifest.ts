import { defineModule } from '../../../core/modules/define-module';

export const HR_MODULES = [
  defineModule({
    code: 'hr.employees',
    name: 'Colaboradores e contratos',
    description: 'Ficha do colaborador e contratos.',
    group: 'hr',
    icon: 'users',
  }),
  defineModule({
    code: 'hr.attendance',
    name: 'Assiduidade, férias e ausências',
    description: 'Registo de presenças, férias e ausências.',
    group: 'hr',
    icon: 'clock',
    dependencies: ['hr.employees'],
    features: [
      {
        id: 'biometric-clock',
        name: 'Relógio de ponto biométrico',
        description: 'Integração com terminais biométricos.',
      },
    ],
  }),
  defineModule({
    code: 'hr.talent',
    name: 'Avaliação, formação e recrutamento',
    description: 'Avaliação de desempenho, formação e recrutamento.',
    group: 'hr',
    icon: 'academic',
    dependencies: ['hr.employees'],
  }),
] as const;
