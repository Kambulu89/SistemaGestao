import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import type {
  BackendSubscriptionStatus,
  BillingInterval,
  PlanDto,
  PlanLimitsDto,
  TenantSubscriptionDto,
} from '../../../core/subscription/subscription-dto';

export type TenantLifecycle = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSING' | 'CLOSED';
export type PlanStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type ProvisioningStep =
  'TENANT' | 'SUBSCRIPTION' | 'ADMIN_ROLE' | 'ORGANIZATION' | 'ADMIN_INVITATION' | 'ACTIVATION';

export interface PlatformTenantDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: TenantLifecycle;
  readonly plan: {
    readonly code: string;
    readonly revision: number;
    readonly status: BackendSubscriptionStatus;
  } | null;
}

export interface ProvisioningStateDto {
  readonly tenant: PlatformTenantDto;
  readonly done: readonly ProvisioningStep[];
  readonly pending?: readonly ProvisioningStep[];
  readonly organizations: number;
  readonly pendingInvitations: number;
  /** Só na resposta ao provisionamento. */
  readonly created?: boolean;
}

export interface ProvisionRequest {
  readonly code: string;
  readonly name: string;
  readonly adminEmail: string;
  readonly planCode: string;
  readonly planRevision?: number;
  readonly trialDays?: number;
}

export interface PlanVersionDto extends Omit<PlanDto, 'code'> {
  readonly planCode: string;
  readonly status: PlanStatus;
  readonly publishedAt: string | null;
}

export interface NewPlan {
  readonly planCode: string;
  readonly name: string;
  readonly currency: string;
  readonly price: string;
  readonly billingInterval: BillingInterval;
  readonly limits: PlanLimitsDto;
  readonly entitlements?: { modules?: readonly string[]; features?: readonly string[] };
}

export interface PlatformSubscriptionDto {
  readonly status: BackendSubscriptionStatus;
  readonly startsAt: string;
  readonly periodEnd: string;
  readonly trialEnd: string | null;
  readonly graceEnd: string | null;
  readonly adequacyUntil: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface PlatformSubscriptionView {
  readonly plan: PlanVersionDto;
  readonly subscription: PlatformSubscriptionDto;
  readonly entitled: boolean;
  readonly usage: TenantSubscriptionDto['usage'];
  readonly history: TenantSubscriptionDto['history'];
}

/**
 * Administração da plataforma (D-033): tenants, planos e assinaturas. As rotas exigem uma concessão
 * `platform.*` no servidor; não levam selector de tenant e não dão acesso a dados de nenhum tenant.
 */
@Injectable({ providedIn: 'root' })
export class PlatformApi {
  private readonly api = inject(ApiService);

  listTenants(): Observable<readonly PlatformTenantDto[]> {
    return this.api.get('platform/tenants');
  }

  /** Provisiona (ou retoma o provisionamento de) um tenant; repetir é seguro. */
  provision(body: ProvisionRequest): Observable<ProvisioningStateDto> {
    return this.api.post('platform/tenants', body);
  }

  tenantState(id: string): Observable<ProvisioningStateDto> {
    return this.api.get(`platform/tenants/${id}`);
  }

  suspend(id: string, reason: string): Observable<PlatformTenantDto> {
    return this.api.post(`platform/tenants/${id}/suspend`, { reason });
  }

  resume(id: string, reason: string): Observable<PlatformTenantDto> {
    return this.api.post(`platform/tenants/${id}/resume`, { reason });
  }

  listPlans(): Observable<readonly PlanVersionDto[]> {
    return this.api.get('platform/plans');
  }

  createPlan(body: NewPlan): Observable<PlanVersionDto> {
    return this.api.post('platform/plans', body);
  }

  publishPlan(code: string, revision: number): Observable<PlanVersionDto> {
    return this.api.post(
      `platform/plans/${encodeURIComponent(code)}/revisions/${revision}/publish`,
      {},
    );
  }

  retirePlan(code: string, revision: number): Observable<PlanVersionDto> {
    return this.api.post(
      `platform/plans/${encodeURIComponent(code)}/revisions/${revision}/retire`,
      {},
    );
  }

  subscription(tenantId: string): Observable<PlatformSubscriptionView> {
    return this.api.get(`platform/tenants/${tenantId}/subscription`);
  }

  assign(
    tenantId: string,
    body: { planCode: string; revision?: number; trialDays?: number },
  ): Observable<PlatformSubscriptionDto> {
    return this.api.post(`platform/tenants/${tenantId}/subscription`, body);
  }

  changePlan(
    tenantId: string,
    body: { planCode: string; revision?: number; adequacyDays?: number },
  ): Observable<PlatformSubscriptionDto> {
    return this.api.put(`platform/tenants/${tenantId}/subscription/plan`, body);
  }

  setSubscriptionStatus(
    tenantId: string,
    body: { status: Exclude<BackendSubscriptionStatus, 'TRIAL'>; graceDays?: number },
  ): Observable<PlatformSubscriptionDto> {
    return this.api.put(`platform/tenants/${tenantId}/subscription/status`, body);
  }
}
