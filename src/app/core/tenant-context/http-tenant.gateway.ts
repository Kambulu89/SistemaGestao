import { inject, Injectable } from '@angular/core';
import { catchError, map, type Observable, of, switchMap } from 'rxjs';
import { TENANT_HEADER } from '../api/api.constants';
import { ApiService } from '../api/api.service';
import { MODULE_MANIFESTS } from '../modules/module-manifests.token';
import type { ModuleManifest } from '../modules/module.model';
import { mapBackendPermissions } from '../permissions/backend-permissions';
import {
  SUBSCRIPTION_STATUS,
  toUsageLimit,
  type TenantSubscriptionDto,
} from '../subscription/subscription-dto';
import type { Subscription } from '../subscription/subscription.model';
import { TenantGateway } from './tenant.gateway';
import type {
  ModuleSettingValue,
  Tenant,
  TenantContext,
  TenantMembership,
  TenantModule,
  TenantStatus,
} from './tenant.model';

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
  /** Módulos do registo activos **e** licenciados (C03); o núcleo não consta. */
  readonly modules: readonly string[];
  /** Funcionalidades efectivas (licença AND módulo activo AND funcionalidade ligada). */
  readonly features: readonly string[];
}

const STATUSES: Readonly<Record<string, TenantStatus>> = {
  PROVISIONING: 'provisioning',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSING: 'closing',
  CLOSED: 'closed',
};

const statusOf = (status: string): TenantStatus => STATUSES[status] ?? 'suspended';

/**
 * Convenção de nomes (D-034): o módulo do registo é o primeiro segmento do código do manifesto
 * (`crm.customers` pertence ao módulo `crm`) e a funcionalidade `import` desse manifesto chama-se
 * `crm.customers.import` no registo.
 */
const backendModuleOf = (manifest: ModuleManifest): string => manifest.code.split('.')[0] ?? '';

/** Adapter HTTP dos tenants do utilizador e do contexto do tenant (C01/C03/C05/C06). */
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

  /**
   * O tenant ainda não está activo no cliente: o selector vai explícito nestes pedidos. Módulos e
   * funcionalidades vêm do registo do servidor; quem pode ler a assinatura vê também o plano e o consumo.
   */
  loadContext(tenantId: string): Observable<TenantContext> {
    const headers = { [TENANT_HEADER]: tenantId };
    return this.api.get<ContextDto>('context', { headers }).pipe(
      switchMap((dto) => {
        const permissions = mapBackendPermissions(dto.permissions.map((p) => p.code));
        const subscription$: Observable<TenantSubscriptionDto | null> = permissions.includes(
          'tenant.plan.read',
        )
          ? this.api
              .get<TenantSubscriptionDto>('tenant/subscription', { headers })
              // Sem assinatura (404) ou sem acesso: o contexto continua válido, sem os detalhes do plano.
              .pipe(catchError(() => of(null)))
          : of(null);
        return subscription$.pipe(map((detail) => this.toContext(dto, permissions, detail)));
      }),
    );
  }

  private toContext(
    dto: ContextDto,
    permissions: readonly string[],
    detail: TenantSubscriptionDto | null,
  ): TenantContext {
    const enabled = new Set(dto.modules);
    const features = new Set(dto.features);
    const contractable = this.manifests.filter(
      (m) => m.kind === 'module' && enabled.has(backendModuleOf(m)),
    );

    const modules = contractable.map<TenantModule>((m) => ({
      moduleId: m.id,
      active: true,
      features: m.features.filter((f) => features.has(`${m.code}.${f.id}`)).map((f) => f.id),
      settings: Object.fromEntries(
        m.settings.map((s): [string, ModuleSettingValue] => [s.key, s.defaultValue]),
      ),
    }));

    const subscription: Subscription = {
      id: detail ? `${dto.tenant.id}:${detail.plan.code}` : dto.tenant.id,
      tenantId: dto.tenant.id,
      planCode: detail?.plan.code ?? '',
      status: detail ? SUBSCRIPTION_STATUS[detail.subscription.status] : 'active',
      startedAt: detail?.subscription.startsAt ?? '',
      renewsAt: detail?.subscription.periodEnd ?? null,
      moduleIds: contractable.map((m) => m.id),
      limits: detail?.usage.map(toUsageLimit) ?? [],
    };

    return {
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
      permissions,
      authorizationVersion: dto.authorizationVersion,
      subscription,
      modules,
      featureFlags: {},
    };
  }
}
