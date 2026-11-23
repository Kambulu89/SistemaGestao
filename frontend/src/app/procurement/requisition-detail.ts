import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import {
  BLOCKED_BY,
  PRIORITY,
  REQ_EVENT,
  type Requisition,
  REQUISITION_STATUS,
  requisitionTone,
} from './requisition-model';

type ReasonKind = 'reject' | 'cancel' | 'close';

/**
 * Requisição de compra (9.2): estado, cadeia de aprovação (etapa actual e quem decidiu), acções que o servidor permite
 * a quem está a ver, linhas com o encomendado, fechado e em aberto, e histórico.
 */
@Component({
  selector: 'app-purchase-requisition-detail',
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
      [title]="title()"
      [subtitle]="subtitle()"
      formId="purchase-requisition-detail"
      [loading]="!r()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (r(); as x) {
        <section class="card space-y-3" aria-label="Estado" data-testid="rd-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x.status)" data-testid="rd-status">{{
              statusLabel(x.status)
            }}</span>
            <span class="text-sm text-muted"
              >Prioridade {{ priority(x) }} · necessária a {{ date(x.neededBy) }}</span
            >
          </div>
          <p class="text-sm" data-testid="rd-total">
            Total estimado {{ money(x.totalAmount, x.currency) }}
            @if (x.totalFunctional && x.currency !== 'AOA') {
              ({{ money(x.totalFunctional, null) }} em moeda funcional)
            }
          </p>
          @for (m of messages(x); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (kind() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" data-testid="rd-error" />
          }
          @if (x.can.decideBlockedBy) {
            <p class="text-sm text-warning-text" data-testid="rd-blocked">
              {{ blocked(x.can.decideBlockedBy) }}
            </p>
          }
          <div class="flex flex-wrap gap-2">
            @if (x.can.edit) {
              <a class="btn-secondary" [routerLink]="['/compras/requisicoes', x.id, 'editar']"
                >Editar</a
              >
            }
            @if (x.can.submit) {
              <button type="button" class="btn-primary" data-testid="rd-submit" (click)="submit()">
                Pedir aprovação
              </button>
            }
            @if (x.can.decide) {
              <button
                type="button"
                class="btn-primary"
                data-testid="rd-approve"
                (click)="approve()"
              >
                Aprovar etapa
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-reject"
                (click)="open('reject')"
              >
                Recusar
              </button>
            }
            @if (x.can.close) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-close"
                (click)="open('close')"
              >
                Fechar o resto
              </button>
            }
            @if (x.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="rd-cancel"
                (click)="open('cancel')"
              >
                Anular
              </button>
            }
            @if (x.can.copy) {
              <button type="button" class="btn-secondary" data-testid="rd-copy" (click)="copy()">
                Copiar
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="rd-approval-title">
          <h2 id="rd-approval-title" class="mb-2 font-semibold">Aprovação</h2>
          @if (x.approval.length === 0) {
            <p class="text-sm text-muted">
              As etapas são fixadas quando se pede a aprovação, pelo valor total.
            </p>
          } @else {
            <ol class="space-y-2 text-sm" data-testid="rd-approval">
              @for (a of x.approval; track a.sequence) {
                <li class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">{{ a.name }}</span>
                  @if (a.requiresRole) {
                    <span class="text-xs text-muted">(perfil próprio)</span>
                  }
                  @if (a.decision === 'APPROVE') {
                    <span class="badge bg-success-soft text-success-text">Aprovada</span>
                    <span class="text-muted">{{ a.decidedBy }} · {{ when(a.decidedAt) }}</span>
                  } @else if (a.decision === 'REJECT') {
                    <span class="badge bg-danger-soft text-danger-text">Recusada</span>
                    <span class="text-muted">{{ a.decidedBy }} · {{ a.reason }}</span>
                  } @else if (a.current) {
                    <span class="badge bg-warning-soft text-warning-text">Por decidir</span>
                  } @else {
                    <span class="text-muted">A seguir</span>
                  }
                </li>
              }
            </ol>
          }
        </section>

        <section class="card" aria-labelledby="rd-lines-title">
          <h2 id="rd-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="rd-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">#</th>
                  <th class="px-2 py-1">Descrição</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Preço est.</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Imposto</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Total</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Encomendado</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Em aberto</th>
                </tr>
              </thead>
              <tbody>
                @for (l of x.lines; track l.id) {
                  <tr class="border-t border-border">
                    <td class="px-2 py-1">{{ l.lineNo }}</td>
                    <td class="px-2 py-1">
                      {{ l.product?.sku ? l.product!.sku + ' — ' : '' }}{{ l.description }}
                      @if (l.suggestedSupplier) {
                        <span class="block text-xs text-muted"
                          >Sugerido: {{ l.suggestedSupplier.code }} —
                          {{ l.suggestedSupplier.name }}</span
                        >
                      }
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.quantity) }} {{ l.uom?.code ?? '' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.estimatedUnitPrice) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.taxRate) }}%
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.totalAmount, null) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.orderedQuantity) }}
                    </td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="rd-open"
                    >
                      {{ q(l.openQuantity) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card" aria-labelledby="rd-history-title">
          <h2 id="rd-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="rd-history">
            @for (h of x.history; track $index) {
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

        <app-audit-history
          entityType="purchase_requisition"
          [entityId]="x.id"
          [refreshKey]="x.version"
        />
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="kind() !== null" (closed)="kind.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
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
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rd-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class PurchaseRequisitionDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly r = signal<Requisition | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  protected reason = '';
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = requisitionTone;
  protected readonly statusLabel = (s: Requisition['status']) => REQUISITION_STATUS[s];
  protected readonly priority = (x: Requisition) => PRIORITY[x.priority];
  protected readonly event = (k: string) => REQ_EVENT[k] ?? k;
  protected readonly blocked = (k: string) => BLOCKED_BY[k] ?? k;
  protected readonly title = computed(() => {
    const x = this.r();
    return x ? `Requisição ${x.number ?? '(rascunho)'}` : 'Requisição';
  });
  protected readonly subtitle = computed(() => {
    const x = this.r();
    return x
      ? `${x.department.code} — ${x.department.name} · ${x.purpose}${x.costCenter ? ' · ' + x.costCenter.code : ''}`
      : '';
  });
  protected readonly modalTitle = computed(
    () =>
      ({
        reject: 'Recusar a requisição',
        cancel: 'Anular a requisição',
        close: 'Fechar o que fica por encomendar',
      })[this.kind() ?? 'reject'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected messages(x: Requisition) {
    const out: string[] = [];
    if (x.requestedBy.name)
      out.push(
        `Pedida por ${x.requestedBy.name}${x.budgetReference ? ' · orçamento ' + x.budgetReference : ''}.`,
      );
    if (x.rejectReason) out.push(`Recusada: ${x.rejectReason}`);
    if (x.cancelReason) out.push(`Anulada: ${x.cancelReason}`);
    if (x.closeReason) out.push(`Resto fechado: ${x.closeReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const x = await this.api.get<Requisition>(`procurement/requisitions/${this.id()}`);
      this.r.set(x);
      this.breadcrumbs.setCurrent(x.number ?? 'Rascunho');
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected back() {
    void this.router.navigate(['/compras/requisicoes']);
  }

  private done(x: Requisition | null | undefined, message: string) {
    if (!x) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return false;
    }
    this.r.set(x);
    this.breadcrumbs.setCurrent(x.number ?? 'Rascunho');
    this.toasts.show(message);
    return true;
  }

  protected async submit() {
    const x = this.r()!;
    const ok = await this.confirmSvc.ask({
      title: 'Pedir aprovação',
      message:
        'A requisição recebe número e deixa de poder ser alterada; o valor total define as etapas de aprovação.',
      confirmLabel: 'Pedir aprovação',
    });
    if (!ok) return;
    const r = await this.act.run(() =>
      this.api.post<Requisition>(`procurement/requisitions/${x.id}/submit`, {
        expectedVersion: x.version,
      }),
    );
    this.done(r, 'Aprovação pedida.');
  }

  protected async approve() {
    const x = this.r()!;
    const step = x.approval.find((a) => a.current);
    const ok = await this.confirmSvc.ask({
      title: 'Aprovar etapa',
      message: `Aprova a etapa ${step?.name ?? ''} da requisição ${x.number} (${money(x.totalAmount, x.currency)}).`,
      confirmLabel: 'Aprovar',
    });
    if (!ok) return;
    const r = await this.act.run(() =>
      this.api.post<Requisition>(`procurement/requisitions/${x.id}/approve`, {
        expectedVersion: x.version,
      }),
    );
    this.done(r, r?.status === 'APPROVED' ? 'Requisição aprovada.' : 'Etapa aprovada.');
  }

  protected async copy() {
    const x = this.r()!;
    const r = await this.act.run(() =>
      this.api.post<Requisition>(`procurement/requisitions/${x.id}/copy`, {}),
    );
    if (!r) return;
    this.toasts.show('Cópia criada em rascunho.');
    await this.router.navigate(['/compras/requisicoes', r.id]);
  }

  protected open(k: ReasonKind) {
    this.act.error.set(null);
    this.reason = '';
    this.kind.set(k);
  }

  protected async confirmReason() {
    const x = this.r()!;
    const k = this.kind()!;
    const r = await this.act.run(() =>
      this.api.post<Requisition>(`procurement/requisitions/${x.id}/${k}`, {
        expectedVersion: x.version,
        reason: this.reason,
      }),
    );
    if (!r) return;
    this.r.set(r);
    this.kind.set(null);
    this.toasts.show(
      { reject: 'Requisição recusada.', cancel: 'Requisição anulada.', close: 'Resto fechado.' }[k],
    );
  }
}
