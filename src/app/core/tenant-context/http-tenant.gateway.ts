import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { TENANT_HEADER } from '../api/api.constants';
import { ApiService } from '../api/api.service';
import { MODULE_MANIFESTS } from '../modules/module-manifests.token';
import { mapBackendPermissions } from '../permissions/backend-permissions';
import { provisionalEntitlements } from './provisional-entitlements';
import { TenantGateway } from './tenant.gateway';
import type { Tenant, TenantContext, TenantMembership, TenantStatus } from './tenant.model';

interface MyTenantDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
}

interface ContextDto {
  readonly tenant: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: string;
    readonly defaultLocale: string;
    readonly timezone: string;
  };
  readonly locale: string;
  readonly authorizationVersion: number;
  readonly permissions: readonly { readonly code: string }[];
}

const STATUSES: Readonly<Record<string, TenantStatus>> = {
  PROVISIONING: 'provisioning',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSING: 'closing',
  CLOSED: 'closed',
};

const statusOf = (status: string): TenantStatus => STATUSES[status] ?? 'suspended';

/** Adapter HTTP dos tenants do utilizador e do contexto do tenant (C01/C05/C06). */
@Injectable()
export class HttpTenantGateway extends TenantGateway {
  private readonly api = inject(ApiService);
  private readonly manifests = inject(MODULE_MANIFESTS);

  listMemberships(): Observable<readonly TenantMembership[]> {
    return this.api.get<readonly MyTenantDto[]>('me/tenants').pipe(
      map((list) =>
        list.map((t) => ({
          // Os campos de formatação do tenant só vêm com o contexto; aqui basta identificar e listar.
          tenant: {
            id: t.id,
            slug: t.code,
            name: t.name,
            status: statusOf(t.status),
            locale: '',
            currency: null,
            timeZone: '',
          } satisfies Tenant,
          roleName: null,
        })),
      ),
    );
  }

  /** O tenant ainda não está activo no cliente: o selector vai explícito neste pedido. */
  loadContext(tenantId: string): Observable<TenantContext> {
    return this.api.get<ContextDto>('context', { headers: { [TENANT_HEADER]: tenantId } }).pipe(
      map((dto) => ({
        tenant: {
          id: dto.tenant.id,
          slug: dto.tenant.code,
          name: dto.tenant.name,
          status: statusOf(dto.tenant.status),
          locale: dto.locale || dto.tenant.defaultLocale,
          currency: null,
          timeZone: dto.tenant.timezone,
        },
        roleName: null,
        permissions: mapBackendPermissions(dto.permissions.map((p) => p.code)),
        authorizationVersion: dto.authorizationVersion,
        ...provisionalEntitlements(dto.tenant.id, this.manifests),
      })),
    );
  }
}
