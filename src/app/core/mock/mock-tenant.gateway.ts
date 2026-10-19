import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantGateway } from '../tenant-context/tenant.gateway';
import type { TenantContext, TenantMembership } from '../tenant-context/tenant.model';
import { MOCK_MEMBERSHIPS, MOCK_TENANT_SETUP, MOCK_TENANTS } from './mock-data';
import { mockError, respond } from './mock-helpers';

/** Um backend real identifica o utilizador pelo token; o mock usa a sessão local. */
@Injectable()
export class MockTenantGateway extends TenantGateway {
  private readonly auth = inject(AuthService);

  listMemberships(): Observable<readonly TenantMembership[]> {
    return respond(() => {
      const userId = this.auth.user()?.id;
      return MOCK_MEMBERSHIPS.filter((m) => m.userId === userId).flatMap((m) => {
        const tenant = MOCK_TENANTS.find((t) => t.id === m.tenantId);
        return tenant ? [{ tenant, roleName: m.roleName }] : [];
      });
    });
  }

  loadContext(tenantId: string): Observable<TenantContext> {
    return respond(() => {
      const userId = this.auth.user()?.id;
      const membership = MOCK_MEMBERSHIPS.find(
        (m) => m.userId === userId && m.tenantId === tenantId,
      );
      const tenant = MOCK_TENANTS.find((t) => t.id === tenantId);
      const setup = MOCK_TENANT_SETUP[tenantId];
      if (!membership || !tenant || !setup) throw mockError(403, 'Sem acesso a este tenant.');
      return {
        tenant,
        roleName: membership.roleName,
        permissions: membership.permissions,
        ...setup,
      };
    });
  }
}
