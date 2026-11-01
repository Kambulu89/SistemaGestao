import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export interface SessionDto {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly current: boolean;
}

export type Severity = 'INFO' | 'WARN' | 'HIGH';

export interface SecurityEventDto {
  readonly id: string;
  readonly type: string;
  readonly severity: Severity;
  readonly occurredAt: string;
}

/** Conta do utilizador autenticado: sessões, palavra-passe e actividade de segurança. Não depende do tenant. */
@Injectable({ providedIn: 'root' })
export class ProfileApi {
  private readonly api = inject(ApiService);

  sessions(): Observable<readonly SessionDto[]> {
    return this.api.get('me/sessions');
  }

  revokeSession(id: string): Observable<void> {
    return this.api.delete(`me/sessions/${id}`);
  }

  changePassword(currentPassword: string, newPassword: string): Observable<void> {
    return this.api.post('me/password', { currentPassword, newPassword });
  }

  securityEvents(limit = 30): Observable<readonly SecurityEventDto[]> {
    return this.api.get('me/security-events', { params: { limit } });
  }
}
