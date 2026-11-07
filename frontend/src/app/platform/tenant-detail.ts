import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { statusLabel } from '../ui/labels';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ConfirmService } from '../ui/confirm';
import { ToastService } from '../ui/toasts';
import { Breadcrumbs } from '../core/breadcrumbs';
import type { FeatureDefinition, Plan, PlatformTenant, TenantSubscriptionAdmin } from './types';

const ACTIONS: Record<string, { label: string; from: string[]; needsReason: boolean }> = {
  ACTIVATE: { label: 'Activar', from: ['TRIALING'], needsReason: false },
  SUSPEND: { label: 'Suspender', from: ['TRIALING', 'ACTIVE'], needsReason: true },
  REACTIVATE: { label: 'Reactivar', from: ['SUSPENDED'], needsReason: false },
  CANCEL: { label: 'Cancelar', from: ['TRIALING', 'ACTIVE', 'SUSPENDED'], needsReason: true },
  CHANGE_PLAN: {
    label: 'Mudar de plano',
    from: ['TRIALING', 'ACTIVE', 'SUSPENDED'],
    needsReason: false,
  },
};

/** Empresa na plataforma: estado do tenant, subscrição (iniciar, transições, histórico) e excepções. */
@Component({
  selector: 'app-platform-tenant-detail',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, StatusBadge],
  template: `
    <app-error-alert [error]="loadError()" />
    @if (tenant(); as t) {
      <app-page-header
        [title]="t.name"
        [subtitle]="t.code + ' · ' + t.countryCode + ' / ' + t.defaultCurrency"
      >
        <a routerLink="/plataforma/empresas" class="btn-secondary">Voltar</a>
      </app-page-header>
      <app-error-alert [error]="action.error()" />

      <section class="card mb-4 flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm">Estado da empresa: <app-status-badge [status]="t.status" /></p>
        @if (t.status === 'ACTIVE') {
          <button
            type="button"
            class="btn-danger"
            [disabled]="action.busy()"
            (click)="setTenantStatus('SUSPENDED')"
          >
            Suspender empresa
          </button>
        } @else if (t.status === 'SUSPENDED') {
          <button
            type="button"
            class="btn-primary"
            [disabled]="action.busy()"
            (click)="setTenantStatus('ACTIVE')"
          >
            Reactivar empresa
          </button>
        }
      </section>

      @if (sub(); as s) {
        <section class="card mb-4 space-y-3">
          <h2 class="font-semibold">Subscrição</h2>
          @if (!s.subscription || s.subscription.status === 'CANCELLED') {
            <p class="text-sm">
              Estado: <strong>{{ label(s.effectiveStatus) }}</strong
              >. Iniciar uma subscrição:
            </p>
            <form
              class="grid gap-3 md:grid-cols-4"
              (ngSubmit)="start()"
              aria-label="Iniciar subscrição"
            >
              <div>
                <label class="label" for="plan">Plano</label>
                <select id="plan" name="plan" class="input" [(ngModel)]="planId">
                  <option [ngValue]="null">—</option>
                  @for (p of activePlans(); track p.id) {
                    <option [ngValue]="p.id">{{ p.name }} ({{ p.code }})</option>
                  }
                </select>
              </div>
              <label class="flex items-end gap-2 text-sm">
                <input type="checkbox" name="trial" [(ngModel)]="trial" /> Período experimental do
                plano
              </label>
              <div class="flex items-end">
                <button type="submit" class="btn-primary" [disabled]="action.busy() || !planId()">
                  Iniciar
                </button>
              </div>
            </form>
          } @else {
            <p class="text-sm">
              Plano <strong>{{ s.subscription.planCode }}</strong> · estado
              <app-status-badge [status]="s.effectiveStatus" /> · desde
              {{ when(s.subscription.startsAt) }}
              @if (s.subscription.trialEndsAt) {
                · experimental até {{ when(s.subscription.trialEndsAt) }}
              }
            </p>
            <form
              class="grid gap-3 md:grid-cols-4"
              (ngSubmit)="transition()"
              aria-label="Alterar subscrição"
            >
              <div>
                <label class="label" for="action">Acção</label>
                <select id="action" name="action" class="input" [(ngModel)]="transitionAction">
                  <option [ngValue]="null">—</option>
                  @for (a of availableActions(); track a) {
                    <option [ngValue]="a">{{ actions[a].label }}</option>
                  }
                </select>
              </div>
              @if (transitionAction() === 'CHANGE_PLAN') {
                <div>
                  <label class="label" for="newPlan">Novo plano</label>
                  <select id="newPlan" name="newPlan" class="input" [(ngModel)]="planId">
                    <option [ngValue]="null">—</option>
                    @for (p of activePlans(); track p.id) {
                      <option [ngValue]="p.id">{{ p.name }}</option>
                    }
                  </select>
                </div>
              }
              <div>
                <label class="label" for="reason"
                  >Motivo{{
                    transitionAction() && actions[transitionAction()!].needsReason ? ' *' : ''
                  }}</label
                >
                <input id="reason" name="reason" class="input" [(ngModel)]="reason" />
              </div>
              <div class="flex items-end">
                <button
                  type="submit"
                  class="btn-primary"
                  [disabled]="action.busy() || !transitionAction()"
                >
                  Aplicar
                </button>
              </div>
            </form>
          }
          <div class="overflow-x-auto">
            <table class="table" aria-label="Funcionalidades efectivas">
              <thead>
                <tr>
                  <th>Funcionalidade</th>
                  <th>Incluída</th>
                  <th>Limite</th>
                  <th>Origem</th>
                </tr>
              </thead>
              <tbody>
                @for (e of s.entitlements; track e.code) {
                  <tr>
                    <td class="font-mono text-xs">{{ e.code }}</td>
                    <td>{{ e.enabled ? 'Sim' : 'Não' }}</td>
                    <td>{{ e.enabled ? (e.limit ?? 'Sem limite') : '—' }}</td>
                    <td>{{ e.source }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card mb-4 space-y-3">
          <h2 class="font-semibold">Excepções</h2>
          @for (o of s.overrides; track o.featureCode) {
            <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <span class="font-mono text-xs">{{ o.featureCode }}</span> ·
                {{ o.enabled ? 'ligada' : 'desligada'
                }}{{ o.limitValue !== null ? ' · limite ' + o.limitValue : '' }} · {{ o.reason }} ·
                expira {{ when(o.expiresAt) }}
              </span>
              <button
                type="button"
                class="btn-secondary"
                [disabled]="action.busy()"
                (click)="removeOverride(o.featureCode)"
              >
                Remover
              </button>
            </div>
          }
          <form
            class="grid gap-3 border-t border-border pt-3 md:grid-cols-6"
            (ngSubmit)="setOverride()"
            aria-label="Nova excepção"
          >
            <div class="md:col-span-2">
              <label class="label" for="feature">Funcionalidade</label>
              <select id="feature" name="feature" class="input" [(ngModel)]="override.featureCode">
                @for (f of features(); track f.code) {
                  <option [ngValue]="f.code">{{ f.code }}</option>
                }
              </select>
            </div>
            <label class="flex items-end gap-2 text-sm">
              <input type="checkbox" name="enabled" [(ngModel)]="override.enabled" /> Ligada
            </label>
            <div>
              <label class="label" for="limit">Limite</label>
              <input
                id="limit"
                name="limit"
                type="number"
                min="0"
                class="input"
                [disabled]="!isLimit(override.featureCode)"
                [(ngModel)]="override.limitValue"
              />
            </div>
            <div>
              <label class="label" for="expires">Expira</label>
              <input
                id="expires"
                name="expires"
                type="date"
                class="input"
                [(ngModel)]="override.expiresOn"
              />
            </div>
            <div class="md:col-span-5">
              <label class="label" for="o-reason">Motivo *</label>
              <input id="o-reason" name="o-reason" class="input" [(ngModel)]="override.reason" />
            </div>
            <div class="flex items-end">
              <button
                type="submit"
                class="btn-primary"
                [disabled]="action.busy() || !override.featureCode || !override.reason.trim()"
              >
                Guardar
              </button>
            </div>
          </form>
        </section>

        <section class="card">
          <h2 class="font-semibold">Histórico</h2>
          <ul class="mt-2 space-y-1 text-sm">
            @for (h of s.history; track h.id) {
              <li>
                {{ when(h.createdAt) }} · {{ h.action }} · {{ label(h.fromStatus) }} →
                {{ label(h.toStatus) }} · {{ h.planCode }}{{ h.reason ? ' · ' + h.reason : '' }}
              </li>
            } @empty {
              <li class="text-muted">Sem histórico.</li>
            }
          </ul>
        </section>
      }
    }
  `,
})
export class PlatformTenantDetail {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  protected readonly actions = ACTIONS;
  protected readonly when = formatDateTime;
  protected readonly label = statusLabel;
  protected readonly tenant = signal<PlatformTenant | null>(null);
  protected readonly sub = signal<TenantSubscriptionAdmin | null>(null);
  protected readonly plans = signal<Plan[]>([]);
  protected readonly features = signal<FeatureDefinition[]>([]);
  protected readonly activePlans = computed(() =>
    this.plans().filter((p) => p.status === 'ACTIVE'),
  );
  protected readonly availableActions = computed(() => {
    const status = this.sub()?.subscription?.status;
    return Object.keys(ACTIONS).filter((a) => status && ACTIONS[a].from.includes(status));
  });
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly planId = signal<string | null>(null);
  protected readonly trial = signal(false);
  protected readonly transitionAction = signal<string | null>(null);
  protected readonly reason = signal('');
  protected override = {
    featureCode: '',
    enabled: true,
    limitValue: null as number | null,
    reason: '',
    expiresOn: '',
  };
  protected readonly action = new Action();
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    try {
      const [tenant, subscription, plans, features] = await Promise.all([
        this.api.get<PlatformTenant>(`platform/tenants/${id}`),
        this.api.get<TenantSubscriptionAdmin>(`platform/tenants/${id}/subscription`),
        this.api.get<Plan[]>('platform/plans'),
        this.api.get<FeatureDefinition[]>('platform/features'),
      ]);
      this.tenant.set(tenant);
      this.breadcrumbs.setCurrent(tenant.name);
      this.sub.set(subscription);
      this.plans.set(plans);
      this.features.set(features);
      if (!this.override.featureCode && features[0]) this.override.featureCode = features[0].code;
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async reloadSub() {
    this.sub.set(
      await this.api.get<TenantSubscriptionAdmin>(`platform/tenants/${this.id()}/subscription`),
    );
  }

  protected isLimit(code: string) {
    return this.features().find((f) => f.code === code)?.kind === 'LIMIT';
  }

  protected async setTenantStatus(status: 'ACTIVE' | 'SUSPENDED') {
    const t = this.tenant()!;
    if (
      status === 'SUSPENDED' &&
      !(await this.confirm.ask({
        title: 'Suspender empresa',
        message: 'Ninguém consegue entrar nesta empresa enquanto estiver suspensa.',
        confirmLabel: 'Suspender',
        danger: true,
      }))
    )
      return;
    const updated = await this.action.run(() =>
      this.api.patch<PlatformTenant>(`platform/tenants/${t.id}`, {
        status,
        expectedVersion: t.version,
      }),
    );
    if (updated) this.tenant.set({ ...t, ...updated });
  }

  protected async start() {
    const done = await this.action.run(() =>
      this.api.post(`platform/tenants/${this.id()}/subscription`, {
        planId: this.planId(),
        trial: this.trial(),
      }),
    );
    if (done) await this.reloadSub();
  }

  protected async transition() {
    const s = this.sub()!.subscription!;
    const done = await this.action.run(() =>
      this.api.post(`platform/subscriptions/${s.id}/transitions`, {
        action: this.transitionAction(),
        expectedVersion: s.version,
        reason: this.reason().trim() || null,
        planId: this.transitionAction() === 'CHANGE_PLAN' ? this.planId() : undefined,
      }),
    );
    if (done) {
      this.transitionAction.set(null);
      this.reason.set('');
      await this.reloadSub();
    }
  }

  protected async setOverride() {
    const o = this.override;
    const done = await this.action.run(() =>
      this.api.put(`platform/tenants/${this.id()}/entitlements/${o.featureCode}`, {
        enabled: o.enabled,
        limitValue:
          this.isLimit(o.featureCode) && o.limitValue !== null && String(o.limitValue) !== ''
            ? Number(o.limitValue)
            : null,
        reason: o.reason.trim(),
        expiresAt: o.expiresOn ? new Date(`${o.expiresOn}T23:59:59`).toISOString() : null,
      }),
    );
    if (done) {
      this.override = { ...o, reason: '', limitValue: null, expiresOn: '' };
      await this.reloadSub();
    }
  }

  protected async removeOverride(code: string) {
    await this.action.run(() =>
      this.api.delete(`platform/tenants/${this.id()}/entitlements/${code}`),
    );
    if (!this.action.error()) await this.reloadSub();
  }
}
