import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { Page, PageRequest } from '../../../core/api/pagination.model';
import { MOCK_PLANS, MOCK_SUBSCRIPTIONS, MOCK_TENANTS } from '../../../core/mock/mock-data';
import { respond } from '../../../core/mock/mock-helpers';
import type { Plan, SubscriptionStatus } from '../../../core/subscription/subscription.model';
import { BillingGateway, type PlatformSubscription } from './billing.gateway';

const STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'active',
  'trial',
  'past_due',
  'cancelled',
];

const GENERATED: readonly PlatformSubscription[] = Array.from({ length: 12 }, (_, i) => {
  const plan = MOCK_PLANS[i % MOCK_PLANS.length] as Plan;
  return {
    id: `sub-demo-${i + 1}`,
    tenantId: `t-demo-${i + 1}`,
    tenantName: `Organização ${String(i + 1).padStart(2, '0')}`,
    planCode: plan.code,
    status: STATUSES[i % STATUSES.length] ?? 'active',
    startedAt: '2026-01-15',
    renewsAt: '2027-01-15',
    moduleIds: plan.moduleIds,
    limits: plan.limits.map((l) => ({ ...l, used: 0 })),
  };
});

@Injectable()
export class MockBillingGateway extends BillingGateway {
  listPlans(): Observable<readonly Plan[]> {
    return respond(() => MOCK_PLANS);
  }

  listSubscriptions({ page, pageSize }: PageRequest): Observable<Page<PlatformSubscription>> {
    return respond(() => {
      const real = MOCK_SUBSCRIPTIONS.map((s) => ({
        ...s,
        tenantName: MOCK_TENANTS.find((t) => t.id === s.tenantId)?.name ?? s.tenantId,
      }));
      const all = [...real, ...GENERATED];
      const start = (page - 1) * pageSize;
      return { items: all.slice(start, start + pageSize), total: all.length, page, pageSize };
    });
  }
}
