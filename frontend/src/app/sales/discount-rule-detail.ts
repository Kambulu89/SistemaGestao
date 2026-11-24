import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type DiscountRule,
  percent,
  period,
  PRICING_EVENT,
  PRICING_STATUS,
  type PricingStatus,
  pricingTone,
  ruleScope,
  targetLabel,
} from './pricing-model';

/** Regra de desconto: estado, submissão, aprovação por outra pessoa, devolução/inactivação com motivo e histórico. */
@Component({
  selector: 'app-discount-rule-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="x() ? x()!.code + ' — ' + x()!.name : 'Regra de desconto'"
      [subtitle]="
        x() ? percent(x()!.discountPct) + ' · ' + period(x()!.validFrom, x()!.validTo) : ''
      "
      formId="discount-rule-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as r) {
        <section class="card space-y-3" aria-label="Estado">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(r.status)" data-testid="rd-status">{{
              status(r.status)
            }}</span>
            @if (r.inactiveReason) {
              <span class="text-sm text-muted">{{ r.inactiveReason }}</span>
            }
          </div>
          <dl class="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-muted">Clientes</dt>
              <dd>{{ target(r) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Produtos</dt>
              <dd>{{ scope(r) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Desconto</dt>
              <dd>{{ percent(r.discountPct) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Prioridade</dt>
              <dd>{{ r.priority }}</dd>
            </div>
          </dl>
          @if (r.notes) {
            <p class="whitespace-pre-line text-sm">{{ r.notes }}</p>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (r.can?.edit) {
              <a class="btn-secondary" [routerLink]="['/vendas/descontos', r.id, 'editar']"
                >Editar</a
              >
            }
            @if (r.can?.submit) {
              <button type="button" class="btn-primary" data-testid="rd-submit" (click)="submit()">
                Submeter para aprovação
              </button>
            }
            @if (r.can?.approve) {
              <button
                type="button"
                class="btn-primary"
                data-testid="rd-approve"
                (click)="approve()"
              >
                Aprovar
              </button>
            }
            @if (r.can?.reject) {
              <button type="button" class="btn-secondary" (click)="open('reject')">Devolver</button>
            }
            @if (r.can?.deactivate) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-deactivate"
                (click)="open('deactivate')"
              >
                Inactivar
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="rd-h-title">
          <h2 id="rd-h-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm">
            @for (h of r.history ?? []; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind) }}
                @if (h.by) {
                  · {{ h.by }}
                }
                @if (h.reason) {
                  · <em>{{ h.reason }}</em>
                }
              </li>
            }
          </ul>
        </section>

        <app-audit-history entityType="discount_rule" [entityId]="r.id" [refreshKey]="r.version" />
      }
    </app-entity-form-page>

    <app-modal
      [title]="dialog() === 'reject' ? 'Devolver a regra' : 'Inactivar a regra'"
      [open]="dialog() !== null"
      (closed)="dialog.set(null)"
    >
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="rd-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rd-ok"
          [disabled]="act.busy()"
          (click)="decide()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class DiscountRuleDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<DiscountRule | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<'reject' | 'deactivate' | null>(null);
  protected readonly act = new Action();
  protected readonly when = formatDateTime;
  protected readonly period = period;
  protected readonly percent = percent;
  protected readonly tone = pricingTone;
  protected readonly target = targetLabel;
  protected readonly scope = ruleScope;
  protected readonly status = (s: PricingStatus) => PRICING_STATUS[s] ?? s;
  protected readonly event = (k: string) => PRICING_EVENT[k] ?? k;
  protected reason = '';

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<DiscountRule>(`sales/discount-rules/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(r: DiscountRule) {
    this.x.set(r);
    this.breadcrumbs.setCurrent(r.code);
  }
  protected back() {
    void this.router.navigate(['/vendas/descontos']);
  }
  protected open(d: 'reject' | 'deactivate') {
    this.act.error.set(null);
    this.reason = '';
    this.dialog.set(d);
  }

  private async post(action: string, body: Record<string, unknown>, done: string) {
    const r = this.x()!;
    const res = await this.act.run(() =>
      this.api.post<DiscountRule>(`sales/discount-rules/${r.id}/${action}`, {
        expectedVersion: r.version,
        ...body,
      }),
    );
    if (!res) return;
    this.set(res);
    this.dialog.set(null);
    this.toasts.show(done);
  }
  protected submit() {
    void this.post('submit', {}, 'Regra submetida para aprovação.');
  }
  protected async approve() {
    const ok = await this.confirm.ask({
      title: 'Aprovar a regra',
      message: 'A regra fica activa e passa a aplicar-se aos preços; deixa de poder ser alterada.',
      confirmLabel: 'Aprovar',
    });
    if (ok) await this.post('approve', {}, 'Regra aprovada e activa.');
  }
  protected decide() {
    const d = this.dialog()!;
    void this.post(
      d,
      { reason: this.reason },
      d === 'reject' ? 'Regra devolvida.' : 'Regra inactivada.',
    );
  }
}
