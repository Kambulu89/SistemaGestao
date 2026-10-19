import { defineModule } from '../../../core/modules/define-module';

export const TEAMS_MODULES = [
  defineModule({
    code: 'iam.teams',
    name: 'Equipas',
    description: 'Equipas e grupos de trabalho para atribuir permissões e responsabilidades.',
    group: 'iam',
    icon: 'users',
  }),
] as const;
