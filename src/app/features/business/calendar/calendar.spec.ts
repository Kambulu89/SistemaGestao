import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { IamApi } from '../../tenant/data-access/iam.api';
import { AgendaTab } from './agenda-tab';
import { BusinessHoursTab } from './business-hours-tab';
import { CalendarPage } from './calendar-page';
import {
  CalendarApi,
  type BookingDto,
  type EventDetailDto,
  type OccurrenceDto,
  type ResourceDto,
} from './calendar.api';
import {
  calendarError,
  describeRule,
  formFromRule,
  formatMinutes,
  fromZonedInput,
  groupByDay,
  parsePeriods,
  rangeOf,
  ruleFromForm,
  shift,
  toZonedInput,
} from './calendar-model';
import { ResourcesTab } from './resources-tab';

describe('calendar model', () => {
  it('week starts on Monday, month shows six weeks, shifting follows the view', () => {
    const wed = new Date(2031, 2, 5); // quarta, 5/3/2031
    const week = rangeOf('week', wed);
    expect(week.from.getDay()).toBe(1);
    expect(week.to.getTime() - week.from.getTime()).toBe(
      7 * 86_400_000 + (week.to.getTimezoneOffset() - week.from.getTimezoneOffset()) * -60_000 ||
        7 * 86_400_000,
    );
    const month = rangeOf('month', wed);
    expect(month.from.getDay()).toBe(1);
    expect(Math.round((month.to.getTime() - month.from.getTime()) / 86_400_000)).toBe(42);
    expect(shift('month', wed, 1).getMonth()).toBe(3);
    expect(shift('week', wed, -1).getDate()).toBe(26);
    expect(shift('day', wed, 1).getDate()).toBe(6);
  });

  it('groups occurrences by day; one ending at midnight does not spill into the next day', () => {
    const occ = (startsAt: Date, endsAt: Date): OccurrenceDto => ({
      eventId: 'e',
      calendarId: 'c',
      title: 't',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      occurrenceStart: null,
      allDay: false,
      timezone: 'UTC',
      recurring: false,
      modified: false,
      status: 'CONFIRMED',
    });
    const grouped = groupByDay([
      occ(new Date(2031, 2, 5, 22), new Date(2031, 2, 6, 0)),
      occ(new Date(2031, 2, 5, 22), new Date(2031, 2, 7, 1)),
    ]);
    expect([...grouped.keys()].sort()).toEqual(['2031-03-05', '2031-03-06', '2031-03-07']);
    expect(grouped.get('2031-03-05')).toHaveLength(2);
    expect(grouped.get('2031-03-06')).toHaveLength(1);
  });

  it('converts local time in a zone to the right instant, across the clock change', () => {
    // Lisboa: UTC+0 no inverno, UTC+1 no verão (muda em 30/03/2031).
    expect(fromZonedInput('2031-01-15T10:00', 'Europe/Lisbon')).toBe('2031-01-15T10:00:00.000Z');
    expect(fromZonedInput('2031-07-15T10:00', 'Europe/Lisbon')).toBe('2031-07-15T09:00:00.000Z');
    expect(fromZonedInput('2031-07-15T10:00', 'America/New_York')).toBe('2031-07-15T14:00:00.000Z');
    // A hora que não existe (01:30 em 30/03/2031) avança.
    expect(fromZonedInput('2031-03-30T01:30', 'Europe/Lisbon')).toBe('2031-03-30T01:30:00.000Z');
    expect(fromZonedInput('lixo', 'Europe/Lisbon')).toBeNull();
    expect(fromZonedInput('2031-07-15T10:00', 'Marte/Olimpo')).toBeNull();
    expect(toZonedInput('2031-07-15T09:00:00.000Z', 'Europe/Lisbon')).toBe('2031-07-15T10:00');
  });

  it('an hour-long event keeps its duration when shown in another zone', () => {
    const start = fromZonedInput('2031-07-15T10:00', 'Europe/Lisbon') as string;
    const end = fromZonedInput('2031-07-15T11:00', 'Europe/Lisbon') as string;
    for (const zone of ['Europe/Lisbon', 'America/New_York', 'Asia/Tokyo']) {
      const a = fromZonedInput(toZonedInput(start, zone), zone) as string;
      const b = fromZonedInput(toZonedInput(end, zone), zone) as string;
      expect(a).toBe(start);
      expect(new Date(b).getTime() - new Date(a).getTime()).toBe(3_600_000);
    }
  });

  it('builds and reads repetition rules', () => {
    expect(ruleFromForm({ repeat: 'NONE', interval: 1, days: [], count: '' })).toBeNull();
    expect(ruleFromForm({ repeat: 'WEEKLY', interval: 2, days: ['MO', 'FR'], count: '6' })).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=6',
    );
    expect(ruleFromForm({ repeat: 'DAILY', interval: 1, days: ['MO'], count: 'x' })).toBe(
      'FREQ=DAILY',
    );
    expect(formFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=6')).toEqual({
      repeat: 'WEEKLY',
      interval: 2,
      days: ['MO', 'FR'],
      count: '6',
    });
    expect(describeRule(null)).toBe('Não se repete');
    expect(describeRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=6')).toBe(
      'A cada 2 semanas (Seg), 6 vezes',
    );
    expect(describeRule('FREQ=DAILY;UNTIL=20311231T235959Z')).toContain('31/12/2031');
  });

  it('parses working periods and refuses bad ones', () => {
    expect(parsePeriods('')).toEqual({ periods: [] });
    expect(parsePeriods('13:00-17:00, 09:00-12:00')).toEqual({
      periods: [
        ['09:00', '12:00'],
        ['13:00', '17:00'],
      ],
    });
    for (const bad of ['17:00-09:00', '9-17', '09:00-12:00, 11:00-13:00', '09:00']) {
      expect(parsePeriods(bad)).toHaveProperty('error');
    }
    expect(formatMinutes(450)).toBe('7 h 30 min');
    expect(formatMinutes(480)).toBe('8 h');
  });

  it('translates server error codes, also when wrapped by a resource', () => {
    expect(calendarError({ code: 'RESOURCE_UNAVAILABLE' }, 'x')).toContain('reservado');
    expect(calendarError(new Error('x', { cause: { code: 'HOLD_EXPIRED' } }), 'x')).toContain(
      'venceu',
    );
    expect(calendarError({}, 'falhou')).toBe('falhou');
  });
});

const NOW = new Date();
const at = (hours: number) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hours);
  return d.toISOString();
};

const occurrence = (over: Partial<OccurrenceDto> = {}): OccurrenceDto => ({
  eventId: 'e1',
  calendarId: 'c1',
  title: 'Reunião de equipa',
  startsAt: at(10),
  endsAt: at(11),
  occurrenceStart: null,
  allDay: false,
  timezone: 'Europe/Lisbon',
  recurring: false,
  modified: false,
  status: 'CONFIRMED',
  ...over,
});

const detail = (over: Partial<EventDetailDto> = {}): EventDetailDto => ({
  id: 'e1',
  calendarId: 'c1',
  title: 'Reunião de equipa',
  description: null,
  startsAt: at(10),
  endsAt: at(11),
  timezone: 'Europe/Lisbon',
  allDay: false,
  recurrenceRule: null,
  status: 'CONFIRMED',
  version: 1,
  exceptions: [],
  participants: [{ id: 'p1', membershipId: 'm1', partyId: null, response: 'ACCEPTED' }],
  bookings: [],
  ...over,
});

const room: ResourceDto = {
  id: 'r1',
  organizationId: 'o1',
  unitId: null,
  code: 'SALA-1',
  name: 'Sala 1',
  type: 'ROOM',
  capacity: 8,
  active: true,
  version: 1,
};

function setup(granted: string[], api: Partial<Record<keyof CalendarApi, unknown>> = {}) {
  const full = {
    calendars: vi.fn(() =>
      of([
        {
          id: 'c1',
          name: 'Equipa',
          ownerMembershipId: 'm0',
          unitId: null,
          timezone: 'Europe/Lisbon',
          visibility: 'TENANT',
          version: 1,
        },
      ]),
    ),
    events: vi.fn(() => of({ items: [occurrence()], asOf: '2031-03-05T10:20:30.000Z' })),
    event: vi.fn(() => of(detail())),
    resources: vi.fn(() => of([room])),
    availability: vi.fn(() =>
      of({
        resourceId: 'r1',
        busy: [{ id: 'b1', startsAt: at(10), endsAt: at(11), status: 'CONFIRMED', mine: true }],
        asOf: '2031-03-05T10:20:30.000Z',
      }),
    ),
    bookings: vi.fn(() =>
      of({
        items: [
          {
            id: 'b1',
            eventId: 'e1',
            resourceId: 'r1',
            occurrenceStart: null,
            startsAt: at(10),
            endsAt: at(11),
            status: 'CONFIRMED',
            expiresAt: null,
            cancelReason: null,
            eventTitle: 'Reunião de equipa',
          } satisfies BookingDto,
        ],
        asOf: '2031-03-05T10:20:30.000Z',
      }),
    ),
    organizations: vi.fn(() => of([{ id: 'o1', name: 'Empresa' }])),
    businessCalendars: vi.fn(() =>
      of([
        {
          id: 'h1',
          organizationId: 'o1',
          name: 'Horário normal',
          timezone: 'Europe/Lisbon',
          weeklyWorkingHours: {
            mon: [
              ['09:00', '12:00'],
              ['13:00', '17:00'],
            ],
          },
          holidays: [{ date: '2031-12-25', name: 'Natal' }],
          version: 1,
        },
      ]),
    ),
    workingTime: vi.fn(() =>
      of({ minutes: 420, timezone: 'Europe/Lisbon', from: '', to: '', asOf: '' }),
    ),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: CalendarApi, useValue: full },
      {
        provide: IamApi,
        useValue: {
          listMembers: () =>
            of([{ id: 'm1', status: 'ACTIVE', displayName: 'Ana Silva', email: 'ana@x.pt' }]),
        },
      },
    ],
  });
  return full as unknown as { events: Mock; workingTime: Mock; cancelEvent: Mock };
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

const host = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement;

describe('CalendarPage', () => {
  it('only shows the tabs the person may use', async () => {
    setup(['calendar.read']);
    const fixture = TestBed.createComponent(CalendarPage);
    await settle(fixture);
    expect(host(fixture).querySelector('[data-testid="tab-agenda"]')).not.toBeNull();
    expect(host(fixture).querySelector('[data-testid="tab-hours"]')).not.toBeNull();
    expect(host(fixture).querySelector('[data-testid="tab-resources"]')).toBeNull();
  });
});

describe('AgendaTab', () => {
  it('shows the week with the occurrences and the freshness of the data', async () => {
    const api = setup(['calendar.read']);
    const fixture = TestBed.createComponent(AgendaTab);
    await settle(fixture);
    const el = host(fixture);
    expect(el.querySelector('[data-testid="grid-week"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="occurrence"]')).toHaveLength(1);
    expect(el.textContent).toContain('Reunião de equipa');
    expect(el.querySelector('[data-testid="agenda-fresh"]')?.textContent).toContain('10:20:30');
    // Sem permissão de gestão não há botões de criação.
    expect(el.textContent).not.toContain('Novo evento');
    // O pedido leva um intervalo limitado de 7 dias.
    const [from, to] = api.events.mock.calls[0] as [string, string];
    expect(Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)).toBe(7);
  });

  it('switches to the month grid and asks for six weeks', async () => {
    const api = setup(['calendar.read', 'calendar.manage']);
    const fixture = TestBed.createComponent(AgendaTab);
    await settle(fixture);
    (host(fixture).querySelector('[data-testid="view-month"]') as HTMLElement).click();
    await settle(fixture);
    expect(host(fixture).querySelector('[data-testid="grid-month"]')).not.toBeNull();
    const last = api.events.mock.calls.at(-1) as [string, string];
    expect(Math.round((Date.parse(last[1]) - Date.parse(last[0])) / 86_400_000)).toBe(42);
    expect(host(fixture).textContent).toContain('Novo evento');
  });

  it('opens the event detail with participants, and a series offers cancelling by scope', async () => {
    const api = setup(['calendar.read', 'calendar.manage', 'resource.book', 'resource.read'], {
      events: vi.fn(() =>
        of({
          items: [occurrence({ recurring: true, occurrenceStart: at(10) })],
          asOf: '2031-03-05T10:20:30.000Z',
        }),
      ),
      event: vi.fn(() =>
        of(
          detail({
            recurrenceRule: 'FREQ=DAILY;COUNT=5',
            bookings: [
              {
                id: 'b1',
                eventId: 'e1',
                resourceId: 'r1',
                occurrenceStart: at(10),
                startsAt: at(10),
                endsAt: at(11),
                status: 'HELD',
                expiresAt: at(12),
                cancelReason: null,
              },
            ],
          }),
        ),
      ),
      cancelEvent: vi.fn(() => of(detail())),
    });
    const fixture = TestBed.createComponent(AgendaTab);
    await settle(fixture);
    (host(fixture).querySelector('[data-testid="occurrence"]') as HTMLElement).click();
    await settle(fixture);
    const text = host(fixture).querySelector('[data-testid="event-detail"]')?.textContent ?? '';
    expect(text).toContain('Ana Silva');
    expect(text).toContain('Aceitou');
    expect(text).toContain('Sala 1');
    expect(text).toContain('Provisória');
    expect(text).toContain('Cancelar só esta');
    expect(text).toContain('Cancelar esta e as seguintes');
    expect(text).toContain('Cancelar a série');
    const button = [...host(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Cancelar só esta'),
    );
    button?.click();
    await settle(fixture);
    expect(api.cancelEvent).toHaveBeenCalledWith('e1', {
      scope: 'THIS',
      occurrenceStart: expect.any(String),
    });
  });

  it('shows the server refusal when a booking collides', async () => {
    setup(['calendar.read', 'calendar.manage', 'resource.book', 'resource.read'], {
      book: vi.fn(() => throwError(() => ({ code: 'RESOURCE_UNAVAILABLE' }))),
    });
    const fixture = TestBed.createComponent(AgendaTab);
    await settle(fixture);
    (host(fixture).querySelector('[data-testid="occurrence"]') as HTMLElement).click();
    await settle(fixture);
    const select = host(fixture).querySelector(
      '[data-testid="book-form"] select',
    ) as HTMLSelectElement;
    select.value = 'r1';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    const reserve = [...host(fixture).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Reservar',
    );
    reserve?.click();
    await settle(fixture);
    expect(host(fixture).querySelector('[data-testid="detail-error"]')?.textContent).toContain(
      'já está reservado',
    );
  });
});

describe('ResourcesTab', () => {
  it('lists resources with capacity and shows the occupancy without the event titles of others', async () => {
    setup(['resource.read', 'resource.book']);
    const fixture = TestBed.createComponent(ResourcesTab);
    await settle(fixture);
    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Sala 1');
    expect(text).toContain('8');
    // Sem permissão de gestão não há «Novo recurso».
    expect(text).not.toContain('Novo recurso');
    const occupancy = [...host(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Ocupação'),
    );
    occupancy?.click();
    await settle(fixture);
    const busy = document.body.querySelector('[data-testid="busy"]')?.textContent ?? '';
    expect(busy).toContain('Sua');
    expect(document.body.querySelector('[data-testid="bookings"]')?.textContent).toContain(
      'Reunião de equipa',
    );
  });
});

describe('BusinessHoursTab', () => {
  it('shows weekly periods and computes working minutes in the calendar zone', async () => {
    const api = setup(['calendar.read']);
    const fixture = TestBed.createComponent(BusinessHoursTab);
    await settle(fixture);
    const list = host(fixture).querySelector('[data-testid="business-list"]')?.textContent ?? '';
    expect(list).toContain('Horário normal');
    expect(list).toContain('09:00-12:00, 13:00-17:00');
    expect(list).toContain('1 feriados');
    const calc = [...host(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Minutos úteis'),
    );
    calc?.click();
    await settle(fixture);
    const inputs = document.body.querySelectorAll<HTMLInputElement>(
      '[data-testid="calc-form"] input',
    );
    inputs[0]!.value = '2031-03-10T00:00';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[1]!.value = '2031-03-11T00:00';
    inputs[1]!.dispatchEvent(new Event('input'));
    await settle(fixture);
    const compute = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Calcular',
    );
    compute?.click();
    await settle(fixture);
    expect(api.workingTime).toHaveBeenCalledWith(
      'h1',
      '2031-03-10T00:00:00.000Z',
      '2031-03-11T00:00:00.000Z',
    );
    expect(document.body.querySelector('[data-testid="working-result"]')?.textContent).toContain(
      '7 h',
    );
  });
});
