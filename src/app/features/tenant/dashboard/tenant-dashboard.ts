import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AppConfigService } from '../../../core/config/app-config.service';
import { SUBSCRIPTION_LABELS, TENANT_STATUS_LABELS } from '../../../core/modules/module-labels';
import { TenantModulesService } from '../../../core/modules/tenant-modules.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

/** Painel do tenant: subscrição, limites do plano e resumo dos módulos. */
@Component({
  selector: 'app-tenant-dashboard',
  imports: [PageHeader, Card, Badge, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      [title]="tenant()?.name ?? ''"
      description="Área de trabalho da organização. O menu lateral só mostra o que está contratado, activado e autorizado para si."
    />

    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Resumo da organização">
      <app-card title="Subscrição">
        <p class="text-2xl font-semibold capitalize">{{ subscription()?.planCode }}</p>
        @if (subscription(); as sub) {
          <app-badge class="mt-2" [tone]="subscriptionStatus().tone">{{
            subscriptionStatus().label
          }}</app-badge>
          @if (sub.renewsAt) {
            <p class="mt-2 text-sm text-fg-muted">
              Renova a {{ sub.renewsAt | date: 'mediumDate' }}
            </p>
          }
        }
      </app-card>

      <app-card title="O meu papel">
        <p class="text-2xl font-semibold">{{ context()?.roleName }}</p>
        <p class="mt-1 text-sm text-fg-muted">
          {{ permissionSummary() }}
        </p>
      </app-card>

      <app-card title="Módulos">
        <p class="text-2xl font-semibold">
          {{ summary().accessible }} / {{ summary().contracted }}
        </p>
        <p class="mt-1 text-sm text-fg-muted">acessíveis a si / contratados</p>
      </app-card>

      <app-card title="Região">
        <p class="text-lg font-semibold">{{ config.locale() }} · {{ config.currency() }}</p>
        <p class="mt-1 text-sm text-fg-muted">{{ config.timeZone() }}</p>
        @if (tenant(); as t) {
          <app-badge class="mt-2" [tone]="tenantStatus(t.status).tone">{{
            tenantStatus(t.status).label
          }}</app-badge>
        }
      </app-card>
    </section>

    <h2 class="mb-3 mt-8 text-lg font-semibold">Limites do plano</h2>
    <app-card>
      <ul class="space-y-4">
        @for (limit of usage(); track limit.key) {
          <li>
            <div class="mb-1 flex justify-between text-sm">
              <span class="font-medium">{{ limit.label }}</span>
              <span class="text-fg-muted">
                {{ limit.used }} / {{ limit.limit === null ? 'ilimitado' : limit.limit }}
                {{ limit.unit }}
              </span>
            </div>
            @if (limit.limit !== null) {
              <div
                class="h-2 overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                [attr.aria-label]="limit.label"
                aria-valuemin="0"
                [attr.aria-valuemax]="limit.limit"
                [attr.aria-valuenow]="limit.used"
              >
                <div
                  class="h-full rounded-full"
                  [class.bg-brand-600]="limit.percent < 90"
                  [class.bg-red-500]="limit.percent >= 90"
                  [style.width.%]="limit.percent"
                ></div>
              </div>
            }
          </li>
        }
      </ul>
    </app-card>
  `,
})
export class TenantDashboard {
  private readonly tenantContext = inject(TenantContextService);
  private readonly modules = inject(TenantModulesService);
  protected readonly config = inject(AppConfigService);

  protected readonly tenant = this.tenantContext.tenant;
  protected readonly context = this.tenantContext.active;
  protected readonly subscription = computed(() => this.context()?.subscription ?? null);

  protected readonly permissionSummary = computed(() => {
    const permissions = this.context()?.permissions ?? [];
    if (permissions.includes('*')) return 'Acesso total à organização';
    return permissions.length === 1
      ? '1 regra de permissão'
      : `${permissions.length} regras de permissão`;
  });

  protected readonly subscriptionStatus = computed(
    () => SUBSCRIPTION_LABELS[this.subscription()?.status ?? 'active'],
  );

  protected readonly usage = computed(() =>
    (this.subscription()?.limits ?? []).map((l) => ({
      ...l,
      percent: l.limit ? Math.min(100, Math.round((l.used / l.limit) * 100)) : 0,
    })),
  );

  protected readonly summary = computed(() => ({
    contracted: this.modules.resolved().filter((m) => m.contracted).length,
    accessible: this.modules.accessible().length,
  }));

  protected tenantStatus(status: keyof typeof TENANT_STATUS_LABELS) {
    return TENANT_STATUS_LABELS[status];
  }
}
