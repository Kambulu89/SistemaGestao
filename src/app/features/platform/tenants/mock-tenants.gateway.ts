import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { Page, PageRequest } from '../../../core/api/pagination.model';
import { MOCK_TENANTS } from '../../../core/mock/mock-data';
import { respond } from '../../../core/mock/mock-helpers';
import type { Tenant, TenantStatus } from '../../../core/tenant-context/tenant.model';
import { TenantsGateway } from './tenants.gateway';

const STATUSES: readonly TenantStatus[] = ['active', 'active', 'trial', 'suspended'];
const PLANS = ['Starter', 'Business', 'Enterprise'] as const;

const GENERATED: readonly Tenant[] = Array.from({ length: 24 }, (_, i) => {
  const n = i + 1;
  return {
    id: `t-demo-${n}`,
    slug: `organizacao-${n}`,
    name: `Organização ${String(n).padStart(2, '0')}`,
    status: STATUSES[i % STATUSES.length] ?? 'active',
    planName: PLANS[i % PLANS.length] ?? 'Starter',
    locale: 'pt-PT',
    currency: 'EUR',
    timeZone: 'Europe/Lisbon',
  };
});

/** Ordenação e paginação em memória, a fazer no servidor quando houver backend. */
@Injectable()
export class MockTenantsGateway extends TenantsGateway {
  list({ page, pageSize, sort }: PageRequest): Observable<Page<Tenant>> {
    return respond(() => {
      const all = [...MOCK_TENANTS, ...GENERATED];
      if (sort) {
        const factor = sort.direction === 'asc' ? 1 : -1;
        all.sort(
          (a, b) =>
            factor *
            String((a as unknown as Record<string, unknown>)[sort.key] ?? '').localeCompare(
              String((b as unknown as Record<string, unknown>)[sort.key] ?? ''),
              'pt',
            ),
        );
      }
      const start = (page - 1) * pageSize;
      return { items: all.slice(start, start + pageSize), total: all.length, page, pageSize };
    });
  }
}
