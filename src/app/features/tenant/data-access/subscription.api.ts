import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import type { TenantSubscriptionDto } from '../../../core/subscription/subscription-dto';

/** Plano contratado do tenant activo (C02): leitura. A gestão é da plataforma. */
@Injectable({ providedIn: 'root' })
export class SubscriptionApi {
  private readonly api = inject(ApiService);

  current(): Observable<TenantSubscriptionDto> {
    return this.api.get('tenant/subscription');
  }
}
