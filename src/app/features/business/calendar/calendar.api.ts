import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type CalendarVisibility = 'PRIVATE' | 'UNIT' | 'TENANT';
export type ResourceType = 'ROOM' | 'EQUIPMENT' | 'VEHICLE' | 'OTHER';
export type EventStatus = 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';
export type BookingStatus = 'HELD' | 'CONFIRMED' | 'CANCELLED';
export type EditScope = 'ALL' | 'THIS' | 'FUTURE';
export type ParticipantResponse = 'PENDING' | 'ACCEPTED' | 'DECLINED';

export interface CalendarDto {
  readonly id: string;
  readonly name: string;
  readonly ownerMembershipId: string | null;
  readonly unitId: string | null;
  readonly timezone: string;
  readonly visibility: CalendarVisibility;
  readonly version: number;
}

export interface ResourceDto {
  readonly id: string;
  readonly organizationId: string;
  readonly unitId: string | null;
  readonly code: string;
  readonly name: string;
  readonly type: ResourceType;
  readonly capacity: number;
  readonly active: boolean;
  readonly version: number;
}

export interface OccurrenceDto {
  readonly eventId: string;
  readonly calendarId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly occurrenceStart: string | null;
  readonly allDay: boolean;
  readonly timezone: string;
  readonly recurring: boolean;
  readonly modified: boolean;
  readonly status: EventStatus;
}

export interface EventListDto {
  readonly items: readonly OccurrenceDto[];
  readonly asOf: string;
}

export interface BookingDto {
  readonly id: string;
  readonly eventId: string;
  readonly resourceId: string;
  readonly occurrenceStart: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: BookingStatus;
  readonly expiresAt: string | null;
  readonly cancelReason: string | null;
  readonly eventTitle?: string | null;
}

export interface ParticipantDto {
  readonly id: string;
  readonly membershipId: string | null;
  readonly partyId: string | null;
  readonly response: ParticipantResponse;
}

export interface EventDetailDto {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly allDay: boolean;
  readonly recurrenceRule: string | null;
  readonly status: EventStatus;
  readonly version: number;
  readonly exceptions: readonly {
    occurrenceStart: string;
    kind: 'CANCELLED' | 'MODIFIED';
    title: string | null;
    startsAt: string | null;
    endsAt: string | null;
  }[];
  readonly participants: readonly ParticipantDto[];
  readonly bookings: readonly BookingDto[];
}

export interface BusyDto {
  readonly resourceId: string;
  readonly busy: readonly {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    mine: boolean;
  }[];
  readonly asOf: string;
}

export interface BusinessCalendarDto {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly timezone: string;
  readonly weeklyWorkingHours: Readonly<Record<string, readonly (readonly [string, string])[]>>;
  readonly holidays: readonly { date: string; name: string }[];
  readonly version: number;
}

export interface WorkingTimeDto {
  readonly minutes: number;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
}

export interface OrganizationDto {
  readonly id: string;
  readonly name: string;
}

export interface EventBody {
  readonly calendarId?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly timezone?: string;
  readonly allDay?: boolean;
  readonly recurrenceRule?: string | null;
  readonly status?: 'TENTATIVE' | 'CONFIRMED';
  readonly version?: number;
  readonly scope?: EditScope;
  readonly occurrenceStart?: string;
}

/** Calendário, recursos e reservas (S03) sobre a API real. */
@Injectable({ providedIn: 'root' })
export class CalendarApi {
  private readonly api = inject(ApiService);

  calendars(): Observable<readonly CalendarDto[]> {
    return this.api.get('calendars');
  }

  createCalendar(body: {
    name: string;
    timezone: string;
    visibility: CalendarVisibility;
    unitId?: string;
  }): Observable<CalendarDto> {
    return this.api.post('calendars', body);
  }

  events(from: string, to: string, calendarId?: string): Observable<EventListDto> {
    return this.api.get('calendar-events', {
      params: { from, to, ...(calendarId ? { calendarId } : {}) },
    });
  }

  event(id: string): Observable<EventDetailDto> {
    return this.api.get(`calendar-events/${id}`);
  }

  createEvent(body: EventBody): Observable<EventDetailDto> {
    return this.api.post('calendar-events', body);
  }

  updateEvent(id: string, body: EventBody): Observable<EventDetailDto> {
    return this.api.patch(`calendar-events/${id}`, body);
  }

  cancelEvent(
    id: string,
    body: { scope: EditScope; occurrenceStart?: string },
  ): Observable<EventDetailDto> {
    return this.api.post(`calendar-events/${id}/cancel`, body);
  }

  addParticipant(
    id: string,
    body: { membershipId?: string; partyId?: string },
  ): Observable<ParticipantDto> {
    return this.api.post(`calendar-events/${id}/participants`, body);
  }

  removeParticipant(id: string, participantId: string): Observable<void> {
    return this.api.delete(`calendar-events/${id}/participants/${participantId}`);
  }

  respond(id: string, response: 'ACCEPTED' | 'DECLINED'): Observable<ParticipantDto> {
    return this.api.post(`calendar-events/${id}/respond`, { response });
  }

  resources(): Observable<readonly ResourceDto[]> {
    return this.api.get('resources');
  }

  createResource(body: {
    organizationId: string;
    code: string;
    name: string;
    type: ResourceType;
    capacity: number;
    active?: boolean;
  }): Observable<ResourceDto> {
    return this.api.post('resources', body);
  }

  updateResource(
    id: string,
    body: { version: number; name: string; type: ResourceType; capacity: number; active: boolean },
  ): Observable<ResourceDto> {
    return this.api.patch(`resources/${id}`, body);
  }

  availability(id: string, from: string, to: string): Observable<BusyDto> {
    return this.api.get(`resources/${id}/availability`, { params: { from, to } });
  }

  bookings(
    from: string,
    to: string,
    filter: { resourceId?: string; eventId?: string } = {},
  ): Observable<{ items: readonly BookingDto[]; asOf: string }> {
    return this.api.get('resource-bookings', { params: { from, to, ...filter } });
  }

  book(body: {
    eventId: string;
    resourceId: string;
    occurrenceStart?: string;
    hold?: boolean;
    holdMinutes?: number;
  }): Observable<{ bookings: readonly BookingDto[]; skipped: number }> {
    return this.api.post('resource-bookings', body);
  }

  confirmBooking(id: string): Observable<BookingDto> {
    return this.api.post(`resource-bookings/${id}/confirm`, {});
  }

  cancelBooking(id: string): Observable<BookingDto> {
    return this.api.post(`resource-bookings/${id}/cancel`, {});
  }

  businessCalendars(): Observable<readonly BusinessCalendarDto[]> {
    return this.api.get('business-calendars');
  }

  createBusinessCalendar(body: {
    organizationId: string;
    name: string;
    timezone: string;
    weeklyWorkingHours: Record<string, readonly (readonly [string, string])[]>;
    holidays: readonly { date: string; name: string }[];
  }): Observable<BusinessCalendarDto> {
    return this.api.post('business-calendars', body);
  }

  updateBusinessCalendar(
    id: string,
    body: {
      version: number;
      name: string;
      timezone: string;
      weeklyWorkingHours: Record<string, readonly (readonly [string, string])[]>;
      holidays: readonly { date: string; name: string }[];
    },
  ): Observable<BusinessCalendarDto> {
    return this.api.patch(`business-calendars/${id}`, body);
  }

  deleteBusinessCalendar(id: string): Observable<void> {
    return this.api.delete(`business-calendars/${id}`);
  }

  workingTime(id: string, from: string, to: string): Observable<WorkingTimeDto> {
    return this.api.get(`business-calendars/${id}/working-time`, { params: { from, to } });
  }

  organizations(): Observable<readonly OrganizationDto[]> {
    return this.api.get('organizations');
  }
}
