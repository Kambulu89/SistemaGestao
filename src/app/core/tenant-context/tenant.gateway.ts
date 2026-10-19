import type { Observable } from 'rxjs';
import type { TenantContext, TenantMembership } from './tenant.model';

/** Contrato com o backend para tenants do utilizador autenticado. */
export abstract class TenantGateway {
  abstract listMemberships(): Observable<readonly TenantMembership[]>;
  abstract loadContext(tenantId: string): Observable<TenantContext>;
}
