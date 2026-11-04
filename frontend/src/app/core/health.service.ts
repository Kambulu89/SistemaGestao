import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

export interface Health {
  readonly status: 'ok' | 'degraded';
  readonly database: 'up' | 'down';
}

/** Estado da API (`GET /api/v1/health`); em desenvolvimento o proxy do `ng serve` encaminha para o AdonisJS. */
@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly http = inject(HttpClient);

  check(): Observable<Health> {
    return this.http.get<Health>('/api/v1/health');
  }
}
