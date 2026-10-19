import type { Observable } from 'rxjs';
import type { Page, PageRequest } from '../../../core/api/pagination.model';
import type { Tenant } from '../../../core/tenant-context/tenant.model';

/** Tenant com o nome do plano contratado, para a listagem global. */
export interface TenantSummary extends Tenant {
  readonly planName: string;
}

/** Contrato da listagem global de tenants (administração da plataforma). */
export abstract class TenantsGateway {
  abstract list(request: PageRequest): Observable<Page<TenantSummary>>;
}
