import type { Observable } from 'rxjs';
import type { Page, PageRequest } from '../../../core/api/pagination.model';
import type { Plan, Subscription } from '../../../core/subscription/subscription.model';

/** Subscrição com o nome do tenant, para a listagem global. */
export interface PlatformSubscription extends Subscription {
  readonly tenantName: string;
}

/** Contrato de planos e subscrições (administração da plataforma). */
export abstract class BillingGateway {
  abstract listPlans(): Observable<readonly Plan[]>;
  abstract listSubscriptions(request: PageRequest): Observable<Page<PlatformSubscription>>;
}
