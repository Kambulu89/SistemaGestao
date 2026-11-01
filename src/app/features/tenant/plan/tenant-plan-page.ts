import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  CHANGE_LABELS,
  formatLimit,
  formatPrice,
  subscriptionLabel,
} from '../../../core/subscription/subscription-labels';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { SubscriptionApi } from '../data-access/subscription.api';

const METRICS: Record<string, string> = { members: 'Membros' };

/**
 * Plano contratado (C02): preços e limites da **versão contratada**, consumo, renovação e bloqueios.
 * Mudar de plano é uma operação da plataforma; aqui só se lê.
 */
@Component({
  selector: 'app-tenant-plan-page',
  imports: [DatePipe, Alert, Badge, Card, EmptyState, LoadingState, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Plano"
      description="O plano contratado, o que consome e o que está bloqueado. Para mudar de plano contacte o fornecedor da plataforma."
    />

    @if (subscription.isLoading() && !subscription.hasValue()) {
      <app-loading-state label="A carregar o plano…" />
    } @else if (notSubscribed()) {
      <app-card>
        <app-empty-state
          icon="card"
          title="Este tenant não tem plano"
          description="Sem plano contratado não é possível adicionar novos membros nem activar módulos."
        />
      </app-card>
    } @else if (subscription.error()) {
      <app-alert tone="danger" title="Não foi possível carregar o plano">{{
        loadError()
      }}</app-alert>
    } @else if (subscription.value(); as data) {
      @if (!data.subscription.entitled) {
        <app-alert tone="warning" title="Sem direitos activos" class="mb-4 block">
          A subscrição está {{ status(data.subscription.status).label.toLowerCase() }}: os módulos e
          funcionalidades licenciados estão indisponíveis até ser regularizada.
        </app-alert>
      }
      @if (data.subscription.adequacyUntil; as until) {
        <app-alert tone="warning" title="Período de adequação" class="mb-4 block">
          Mudou para um plano com limites inferiores ao seu consumo. Até
          {{ until | date: 'dd/MM/yyyy' }} nada é eliminado, mas não pode adicionar novos membros
          enquanto o consumo exceder o limite.
        </app-alert>
      }

      <div class="grid gap-4 lg:grid-cols-2">
        <app-card title="Plano contratado">
          <p class="text-lg font-semibold">
            {{ data.plan.name }}
            <app-badge class="ms-1" [tone]="status(data.subscription.status).tone">{{
              status(data.subscription.status).label
            }}</app-badge>
          </p>
          <p class="mt-1 text-sm text-fg-muted">
            <code>{{ data.plan.code }}</code> · revisão {{ data.plan.revision }}
          </p>
          <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt class="text-fg-muted">Preço</dt>
            <dd>{{ price() }}</dd>
            <dt class="text-fg-muted">Início</dt>
            <dd>{{ data.subscription.startsAt | date: 'dd/MM/yyyy' }}</dd>
            <dt class="text-fg-muted">Renovação</dt>
            <dd>
              {{ data.subscription.periodEnd | date: 'dd/MM/yyyy' }}
              @if (data.subscription.cancelAtPeriodEnd) {
                <span class="text-fg-muted">(cancela no fim do período)</span>
              }
            </dd>
            @if (data.subscription.trialEnd; as trial) {
              <dt class="text-fg-muted">Teste até</dt>
              <dd>{{ trial | date: 'dd/MM/yyyy' }}</dd>
            }
            @if (data.subscription.graceEnd; as grace) {
              <dt class="text-fg-muted">Tolerância até</dt>
              <dd>{{ grace | date: 'dd/MM/yyyy' }}</dd>
            }
          </dl>
          <p class="mt-3 text-xs text-fg-muted">
            Os preços e limites são os da versão contratada: uma versão publicada nunca muda.
          </p>
        </app-card>

        <app-card title="Consumo e limites">
          <ul class="space-y-3" aria-label="Consumo">
            @for (u of data.usage; track u.metric) {
              <li>
                <div class="flex items-center justify-between text-sm">
                  <span class="font-medium">{{ metric(u.metric) }}</span>
                  <span>
                    {{ u.used }} / {{ limit(u.limit) }}
                    @if (u.blocked) {
                      <app-badge tone="warning">Bloqueado</app-badge>
                    }
                  </span>
                </div>
                @if (u.limit !== null) {
                  <div class="mt-1 h-2 rounded-full bg-surface-muted" aria-hidden="true">
                    <div
                      class="h-2 rounded-full"
                      [class.bg-brand-500]="!u.blocked"
                      [class.bg-amber-500]="u.blocked"
                      [style.width.%]="percent(u.used, u.limit)"
                    ></div>
                  </div>
                }
              </li>
            }
          </ul>
        </app-card>
      </div>

      <h2 class="mb-2 mt-6 text-base font-semibold">Direitos do plano</h2>
      <app-card>
        <p class="text-sm">
          <strong>Módulos:</strong>
          {{ data.plan.entitlements.modules.join(', ') || 'nenhum além do núcleo' }}
        </p>
        <p class="mt-1 text-sm">
          <strong>Funcionalidades adicionais:</strong>
          {{ data.plan.entitlements.features.join(', ') || 'nenhuma' }}
        </p>
      </app-card>

      <h2 class="mb-2 mt-6 text-base font-semibold">Histórico</h2>
      <app-card>
        <ul class="space-y-1 text-sm" aria-label="Histórico da subscrição">
          @for (h of data.history; track $index) {
            <li>
              {{ h.occurredAt | date: 'dd/MM/yyyy HH:mm' }} — {{ change(h.kind) }}
              @if (h.toStatus; as to) {
                <span class="text-fg-muted">({{ status(to).label }})</span>
              }
            </li>
          }
        </ul>
      </app-card>
    }
  `,
})
export class TenantPlanPage {
  private readonly api = inject(SubscriptionApi);
  private readonly tenantId = inject(TenantContextService).tenant;

  // Os `params` ligam o pedido ao tenant: trocar de tenant volta a pedir e cancela o anterior.
  protected readonly subscription = rxResource({
    params: () => this.tenantId()?.id,
    stream: () => this.api.current(),
  });

  protected readonly notSubscribed = computed(
    () => (this.subscription.error()?.cause as ApiError | undefined)?.status === 404,
  );
  protected readonly loadError = computed(() => errorMessage(this.subscription.error()));

  protected status = subscriptionLabel;
  protected limit = formatLimit;
  protected metric = (code: string) => METRICS[code] ?? code;
  protected change = (kind: string) => CHANGE_LABELS[kind] ?? kind;

  protected price(): string {
    const data = this.subscription.hasValue() ? this.subscription.value() : null;
    return data ? formatPrice(data.plan.price, data.plan.currency, data.plan.billingInterval) : '';
  }

  protected percent(used: number, limit: number): number {
    return limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  }
}
