import { defineModule } from '../../../core/modules/define-module';

export const CALENDAR_MODULES = [
  defineModule({
    code: 'calendar.scheduling',
    name: 'Calendário e agendamentos',
    description: 'Calendário partilhado e marcação de compromissos.',
    group: 'calendar',
    icon: 'calendar',
    lifecycle: 'beta',
    // Módulo `calendar` do servidor (S03): funcionalidades `calendar.events|resources|business_hours`.
    backendModule: 'calendar',
    features: [
      {
        id: 'events',
        name: 'Calendários e eventos',
        description:
          'Vistas de dia, semana e mês, eventos com repetição e fusos horários, e participantes.',
      },
      {
        id: 'resources',
        name: 'Recursos e reservas',
        description:
          'Salas e equipamentos com capacidade; reservas que nunca se sobrepõem, provisórias ou definitivas.',
      },
      {
        id: 'business_hours',
        name: 'Horário útil e feriados',
        description:
          'Horário semanal e feriados por organização, para prazos que respeitam o trabalho.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Calendário e agendamentos',
        permission: 'calendar.scheduling.read',
        loadComponent: () => import('./calendar-page').then((m) => m.CalendarPage),
      },
    ],
  }),
] as const;
