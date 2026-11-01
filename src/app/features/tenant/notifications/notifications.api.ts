import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type Channel = 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH';
export type Classification = 'MANDATORY' | 'OPERATIONAL' | 'PROMOTIONAL';
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

export interface NotificationDto {
  readonly id: string;
  readonly typeCode: string;
  readonly title: string;
  readonly body: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface NotificationPage {
  readonly items: readonly NotificationDto[];
  readonly total: number;
  readonly unread: number;
}

export interface QuietHoursDto {
  readonly start: string;
  readonly end: string;
  readonly utcOffsetMinutes: number;
}

export interface PreferenceDto {
  readonly typeCode: string;
  readonly description: string;
  readonly classification: Classification;
  readonly channel: Channel;
  readonly enabled: boolean;
  /** Um aviso obrigatório não se desactiva. */
  readonly locked: boolean;
  readonly quietHours: QuietHoursDto | null;
}

/** Visão minimizada de uma entrega: sem texto nem payload, destino mascarado. */
export interface DeliveryDto {
  readonly id: string;
  readonly typeCode: string;
  readonly channel: Channel;
  readonly destinationHint: string | null;
  readonly status: DeliveryStatus;
  readonly provider: string | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
}

export interface OpenedResourceDto {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly path: string;
}

/** Notificações (S02) sobre a API real: cada pessoa só vê e só marca as suas. */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly api = inject(ApiService);

  list(filter: { unread?: boolean; limit?: number } = {}): Observable<NotificationPage> {
    const params: Record<string, string | number | boolean> = {};
    if (filter.unread) params['unread'] = true;
    if (filter.limit) params['limit'] = filter.limit;
    return this.api.getWithMeta<readonly NotificationDto[]>('notifications', { params }).pipe(
      map((r) => ({
        items: r.data,
        total: Number(r.meta['total'] ?? r.data.length),
        unread: Number(r.meta['unread'] ?? 0),
      })),
    );
  }

  markRead(id: string): Observable<NotificationDto> {
    return this.api.post(`notifications/${id}/read`, {});
  }

  markAllRead(): Observable<{ marked: number }> {
    return this.api.post('notifications/read-all', {});
  }

  open(id: string): Observable<OpenedResourceDto> {
    return this.api.post(`notifications/${id}/open`, {});
  }

  preferences(): Observable<readonly PreferenceDto[]> {
    return this.api.get('notification-preferences');
  }

  updatePreferences(
    preferences: readonly {
      typeCode: string;
      channel: Channel;
      enabled: boolean;
      quietHours?: QuietHoursDto | null;
    }[],
  ): Observable<readonly PreferenceDto[]> {
    return this.api.put('notification-preferences', { preferences });
  }

  deliveries(filter: { status?: DeliveryStatus; limit?: number } = {}) {
    const params: Record<string, string | number> = { limit: filter.limit ?? 100 };
    if (filter.status) params['status'] = filter.status;
    return this.api
      .getWithMeta<readonly DeliveryDto[]>('notification-deliveries', { params })
      .pipe(map((r) => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })));
  }

  retryDelivery(id: string): Observable<DeliveryDto> {
    return this.api.post(`notification-deliveries/${id}/retry`, {});
  }

  sendMessage(body: {
    typeCode: 'system.message' | 'system.mandatory';
    recipientMembershipIds: readonly string[];
    title: string;
    body: string;
  }): Observable<{ requested: number; duplicates: number }> {
    return this.api.post('notification-requests', body);
  }
}
