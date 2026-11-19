import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
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
import { APPROVAL_STATUS, type ApprovalStatus } from './order-model';
import {
  AMENDMENT_STATUS,
  type Contract,
  CONTRACT_EVENT,
  CONTRACT_STATUS,
  consumedPct,
  contractTone,
  SLA_METRIC,
} from './contract-model';

type ReasonKind = 'reject' | 'suspend' | 'terminate' | 'cancel' | 'am-reject' | 'am-cancel';

/**
 * Contrato de fornecedor (9.6): estado efectivo (por iniciar/caducado pelas datas), consumo face ao máximo, preços,
 * níveis de serviço, adendas e renovações (propostas, decididas por outra pessoa), ordens que o consomem, anexos,
 * cronologia e auditoria.
 */
@Component({
  selector: 'app-contract-detail',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
    Attachments,
  ],
  template: `
    <app-entity-form-page
      [title]="'Contrato ' + (x()?.number ?? '(rascunho)')"
      [subtitle]="x() ? x()!.title + ' · ' + x()!.supplier.code + ' — ' + x()!.supplier.name : ''"
      formId="contract-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as c) {
        <section class="card space-y-3" aria-label="Estado" data-testid="cd-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(c.effectiveStatus)" data-testid="cd-status">{{
              label(c.effectiveStatus)
            }}</span>
            @if (c.renewalDue) {
              <span class="badge bg-warning-soft text-warning-text" data-testid="cd-renewal-due"
                >A renovar</span
              >
            }
            <span class="text-sm text-muted">
              {{ c.legalEntity.code }} · {{ date(c.startDate) }} –
              <strong data-testid="cd-end">{{ date(c.endDate) }}</strong>
              @if (c.amendmentCount) {
                · {{ c.amendmentCount }} adenda(s)
              }
            </span>
          </div>
          <div>
            <div class="flex flex-wrap justify-between gap-2 text-sm">
              <span
                >Consumido
                <strong data-testid="cd-consumed">{{
                  money(c.consumedAmount, c.currency)
                }}</strong></span
              >
              <span
                >Disponível
                <strong data-testid="cd-remaining">{{
                  money(c.remainingAmount, c.currency)
                }}</strong></span
              >
              <span
                >Máximo
                <strong data-testid="cd-max">{{ money(c.maxAmount, c.currency) }}</strong></span
              >
            </div>
            <div
              class="mt-1 h-2 rounded-full bg-surface-2"
              role="progressbar"
              aria-label="Consumido do máximo"
              [attr.aria-valuenow]="pct(c)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="h-2 rounded-full bg-primary" [style.width.%]="pct(c)"></div>
            </div>
          </div>
          @for (m of messages(c); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (c.can.decideBlockedBy) {
            <p class="text-sm text-warning-text" data-testid="cd-blocked">
              Submeteu este contrato: não o pode aprovar.
            </p>
          }
          @if (kind() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" />
          }
          <div class="flex flex-wrap gap-2">
            @if (c.can.edit) {
              <a
                class="btn-secondary"
                data-testid="cd-edit"
                [routerLink]="['/compras/contratos', c.id, 'editar']"
                >Editar</a
              >
            }
            @if (c.can.submit) {
              <button
                type="button"
                class="btn-primary"
                data-testid="cd-submit"
                (click)="simple('submit', 'Pedir aprovação', 'Aprovação pedida.')"
              >
                Pedir aprovação
              </button>
            }
            @if (c.can.decide) {
              <button
                type="button"
                class="btn-primary"
                data-testid="cd-approve"
                (click)="simple('approve', 'Aprovar', 'Contrato aprovado.')"
              >
                Aprovar
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-reject"
                (click)="ask('reject')"
              >
                Recusar
              </button>
            }
            @if (c.can.amend) {
              <a
                class="btn-secondary"
                data-testid="cd-amend"
                [routerLink]="['/compras/contratos', c.id, 'adenda']"
                >Propor adenda</a
              >
              <a
                class="btn-secondary"
                data-testid="cd-renew"
                [routerLink]="['/compras/contratos', c.id, 'adenda']"
                [queryParams]="{ kind: 'RENEWAL' }"
                >Renovar</a
              >
            }
            @if (c.can.suspend) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-suspend"
                (click)="ask('suspend')"
              >
                Suspender
              </button>
            }
            @if (c.can.reactivate) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-reactivate"
                (click)="simple('reactivate', 'Reactivar', 'Contrato reactivado.')"
              >
                Reactivar
              </button>
            }
            @if (c.can.terminate) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-terminate"
                (click)="ask('terminate')"
              >
                Terminar
              </button>
            }
            @if (c.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="cd-cancel"
                (click)="ask('cancel')"
              >
                Anular
              </button>
            }
          </div>
        </section>

        <section class="card space-y-1 text-sm" aria-labelledby="cd-obj-title">
          <h2 id="cd-obj-title" class="mb-1 font-semibold">Objecto e condições</h2>
          <p class="whitespace-pre-line">{{ c.object }}</p>
          <p>
            <span class="text-muted">Pagamento:</span>
            {{ c.paymentTermsDays === null ? '—' : c.paymentTermsDays + ' dias' }} ·
            <span class="text-muted">Renovação:</span>
            {{ c.autoRenew ? 'automática' : 'manual'
            }}{{ c.renewalMonths ? ', ' + c.renewalMonths + ' meses' : '' }}, aviso
            {{ c.renewalNoticeDays }} dias
          </p>
          @if (c.notes) {
            <p class="whitespace-pre-line text-muted">{{ c.notes }}</p>
          }
        </section>

        <section class="card" aria-labelledby="cd-prices-title">
          <h2 id="cd-prices-title" class="mb-2 font-semibold">Tabela de preços</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="cd-prices">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Artigo</th>
                  <th class="px-2 py-1">Unidade</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Preço ({{ c.currency }})</th>
                </tr>
              </thead>
              <tbody>
                @for (p of c.prices; track p.id) {
                  <tr class="border-t border-border">
                    <td class="px-2 py-1">
                      {{ p.product ? p.product.sku + ' — ' : '' }}{{ p.description }}
                    </td>
                    <td class="px-2 py-1">{{ p.uom?.code ?? '—' }}</td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(p.unitPrice) }}
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="3" class="px-2 py-2 text-muted">Sem preços acordados.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card" aria-labelledby="cd-sla-title">
          <h2 id="cd-sla-title" class="mb-2 font-semibold">Níveis de serviço</h2>
          <ul class="space-y-1 text-sm" data-testid="cd-slas">
            @for (s of c.slas; track s.lineNo) {
              <li>
                <strong>{{ metric(s.metric) }}</strong
                >: {{ q(s.target) }}
                @if (s.description) {
                  · {{ s.description }}
                }
                @if (s.penalty) {
                  · <span class="text-muted">penalização: {{ s.penalty }}</span>
                }
              </li>
            } @empty {
              <li class="text-muted">Sem níveis de serviço.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="cd-am-title">
          <h2 id="cd-am-title" class="mb-2 font-semibold">Adendas e renovações</h2>
          <ul class="space-y-3 text-sm" data-testid="cd-amendments">
            @for (a of c.amendments; track a.id) {
              <li class="rounded border border-border p-2">
                <div class="flex flex-wrap items-center gap-2">
                  <strong
                    >{{ a.kind === 'RENEWAL' ? 'Renovação' : 'Adenda' }} n.º
                    {{ a.amendmentNo }}</strong
                  >
                  <span class="badge" [class]="amTone(a.status)">{{ amLabel(a.status) }}</span>
                  <span class="text-muted"
                    >{{ a.requestedBy }} · efeito {{ date(a.effectiveDate) }}</span
                  >
                </div>
                <p>
                  <em>{{ a.reason }}</em>
                </p>
                <p class="text-muted" data-testid="cd-am-summary">{{ summary(a) }}</p>
                @if (a.decisionReason) {
                  <p class="text-muted">Decisão: {{ a.decisionReason }}</p>
                }
                @if (a.decideBlockedBy) {
                  <p class="text-warning-text">Propôs esta adenda: não a pode aprovar.</p>
                }
                <div class="mt-1 flex flex-wrap gap-2">
                  @if (a.canDecide) {
                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="cd-am-approve"
                      (click)="approveAmendment(a.id, a.version)"
                    >
                      Aprovar e aplicar
                    </button>
                    <button
                      type="button"
                      class="btn-secondary"
                      data-testid="cd-am-reject"
                      (click)="ask('am-reject', a.id, a.version)"
                    >
                      Recusar
                    </button>
                  }
                  @if (a.canCancel) {
                    <button type="button" class="link" (click)="ask('am-cancel', a.id, a.version)">
                      Anular a proposta
                    </button>
                  }
                </div>
              </li>
            } @empty {
              <li class="text-muted">Sem adendas.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="cd-orders-title">
          <h2 id="cd-orders-title" class="mb-2 font-semibold">Ordens de compra</h2>
          <ul class="space-y-1 text-sm" data-testid="cd-orders">
            @for (o of c.orders; track o.id) {
              <li>
                <a class="link" [routerLink]="['/compras/ordens', o.id]">{{
                  o.number ?? 'Rascunho'
                }}</a>
                · {{ orderStatus(o.approvalStatus) }} · líquido
                {{ money(o.totalNet, c.currency) }} · consumido
                {{ money(o.consumed, c.currency) }}
              </li>
            } @empty {
              <li class="text-muted">Nenhuma ordem usa este contrato.</li>
            }
          </ul>
        </section>

        <app-attachments
          subjectType="purchase_contract"
          [subjectId]="c.id"
          [canWrite]="c.can.edit || c.can.amend"
        />

        <section class="card" aria-labelledby="cd-history-title">
          <h2 id="cd-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="cd-history">
            @for (h of c.history; track $index) {
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
          entityType="purchase_contract"
          [entityId]="c.id"
          [refreshKey]="c.version"
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
          data-testid="cd-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="cd-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class ContractDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Contract | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  private target: { id: string; version: number } | null = null;
  protected reason = '';
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = contractTone;
  protected readonly label = (s: Contract['effectiveStatus']) => CONTRACT_STATUS[s];
  protected readonly metric = (m: Contract['slas'][number]['metric']) => SLA_METRIC[m];
  protected readonly amLabel = (s: Contract['amendments'][number]['status']) => AMENDMENT_STATUS[s];
  protected readonly event = (k: string) => CONTRACT_EVENT[k] ?? k;
  protected readonly orderStatus = (s: string) => APPROVAL_STATUS[s as ApprovalStatus] ?? s;
  protected readonly pct = (c: Contract) => consumedPct(c.consumedAmount, c.maxAmount);
  protected readonly modalTitle = computed(
    () =>
      ({
        reject: 'Recusar o contrato',
        suspend: 'Suspender o contrato',
        terminate: 'Terminar o contrato',
        cancel: 'Anular o contrato',
        'am-reject': 'Recusar a adenda',
        'am-cancel': 'Anular a proposta de adenda',
      })[this.kind() ?? 'reject'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected amTone(s: string) {
    if (s === 'APPROVED') return 'bg-success-soft text-success-text';
    if (s === 'PENDING') return 'bg-warning-soft text-warning-text';
    if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
    return 'bg-surface-2 text-muted';
  }

  /** O que a adenda muda no cabeçalho (fim, máximo) e se traz nova tabela de preços ou SLA. */
  protected summary(a: Contract['amendments'][number]) {
    const c = this.x()!;
    const base =
      a.previous?.header ??
      (a.status === 'PENDING' ? { endDate: c.endDate, maxAmount: c.maxAmount } : null);
    const out: string[] = [];
    if (base && a.proposed.header.endDate !== base.endDate)
      out.push(`fim ${formatDate(base.endDate)} → ${formatDate(a.proposed.header.endDate)}`);
    if (base && a.proposed.header.maxAmount !== base.maxAmount)
      out.push(
        `máximo ${money(base.maxAmount, null)} → ${money(a.proposed.header.maxAmount, c.currency)}`,
      );
    if (a.proposed.prices) out.push(`nova tabela de preços (${a.proposed.prices.length})`);
    if (a.proposed.slas) out.push(`novos níveis de serviço (${a.proposed.slas.length})`);
    return out.length ? out.join(' · ') : 'Outras condições.';
  }

  protected messages(c: Contract) {
    const out: string[] = [];
    if (c.approvedAt)
      out.push(`Aprovado por ${c.approvedBy ?? '—'} em ${formatDateTime(c.approvedAt)}.`);
    else if (c.submittedAt)
      out.push(`Aprovação pedida por ${c.submittedBy ?? '—'} em ${formatDateTime(c.submittedAt)}.`);
    if (c.rejectReason) out.push(`Recusado: ${c.rejectReason}`);
    if (c.suspendReason) out.push(`Suspenso: ${c.suspendReason}`);
    if (c.terminationReason) out.push(`Terminado: ${c.terminationReason}`);
    if (c.cancelReason) out.push(`Anulado: ${c.cancelReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Contract>(`procurement/contracts/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(c: Contract) {
    this.x.set(c);
    this.breadcrumbs.setCurrent(c.number ?? 'Rascunho');
  }
  protected back() {
    void this.router.navigate(['/compras/contratos']);
  }

  private async post(url: string, body: Record<string, unknown>, message: string) {
    const r = await this.act.run(() => this.api.post<Contract>(url, body));
    if (!r) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return null;
    }
    this.set(r);
    this.toasts.show(message);
    return r;
  }

  protected async simple(
    action: 'submit' | 'approve' | 'reactivate',
    label: string,
    message: string,
  ) {
    const c = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: label,
      message:
        action === 'approve'
          ? `O contrato recebe número e fica activo de ${formatDate(c.startDate)} a ${formatDate(c.endDate)}, até ${money(c.maxAmount, c.currency)}.`
          : action === 'submit'
            ? 'O contrato deixa de se alterar e vai para aprovação de outra pessoa.'
            : 'O contrato volta a aceitar ordens de compra.',
      confirmLabel: label,
    });
    if (ok)
      await this.post(
        `procurement/contracts/${c.id}/${action}`,
        { expectedVersion: c.version },
        message,
      );
  }

  protected async approveAmendment(id: string, version: number) {
    const ok = await this.confirmSvc.ask({
      title: 'Aprovar a adenda',
      message: 'A adenda aplica-se já ao contrato (a versão anterior fica guardada na adenda).',
      confirmLabel: 'Aprovar e aplicar',
    });
    if (ok)
      await this.post(
        `procurement/contract-amendments/${id}/approve`,
        { expectedVersion: version },
        'Adenda aplicada.',
      );
  }

  protected ask(k: ReasonKind, id?: string, version?: number) {
    this.act.error.set(null);
    this.reason = '';
    this.target = id ? { id, version: version! } : null;
    this.kind.set(k);
  }

  protected async confirmReason() {
    const c = this.x()!;
    const k = this.kind()!;
    const r = k.startsWith('am-')
      ? await this.post(
          `procurement/contract-amendments/${this.target!.id}/${k === 'am-reject' ? 'reject' : 'cancel'}`,
          { expectedVersion: this.target!.version, reason: this.reason },
          k === 'am-reject' ? 'Adenda recusada.' : 'Proposta anulada.',
        )
      : await this.post(
          `procurement/contracts/${c.id}/${k}`,
          { expectedVersion: c.version, reason: this.reason },
          {
            reject: 'Contrato recusado.',
            suspend: 'Contrato suspenso.',
            terminate: 'Contrato terminado.',
            cancel: 'Contrato anulado.',
          }[k as 'reject'],
        );
    if (r) this.kind.set(null);
  }
}
