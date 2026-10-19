import { defineModule } from '../../../core/modules/define-module';

export const CALENDAR_MODULES = [
  defineModule({
    code: 'calendar.scheduling',
    name: 'Calendário e agendamentos',
    description: 'Calendário partilhado e marcação de compromissos.',
    group: 'calendar',
    icon: 'calendar',
  }),
] as const;
