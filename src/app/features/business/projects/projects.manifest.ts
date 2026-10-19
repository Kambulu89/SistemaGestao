import { defineModule } from '../../../core/modules/define-module';

export const PROJECTS_MODULES = [
  defineModule({
    code: 'projects.tasks',
    name: 'Projectos e tarefas',
    description: 'Planeamento de projectos e gestão de tarefas.',
    group: 'projects',
    icon: 'clipboard',
  }),
  defineModule({
    code: 'projects.timesheets',
    name: 'Timesheets e custos',
    description: 'Registo de horas e custos por projecto.',
    group: 'projects',
    icon: 'clock',
    dependencies: ['projects.tasks'],
  }),
] as const;
