import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
import { RECEIPT_STATUS as RECEIPT_DOC_STATUS, type ReceiptRow } from './receipt-model';
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
import { BLOCKED_BY } from './requisition-model';
import {
  APPROVAL_STATUS,
  approvalTone,
  INVOICE_STATUS,
  type Order,
  ORDER_EVENT,
  PAYMENT_METHOD,
  progressTone,
  RECEIPT_STATUS,
} from './order-model';

type ReasonKind = 'reject' | 'revise' | 'cancel' | 'close';

/**
 * Ordem de compra (9.5): os três estados lado a lado, cadeia de aprovação da ronda actual, acções que o servidor
 * permite a quem está a ver (pedir aprovação, decidir, emitir, rever, fechar o resto, anular), linhas com o recebido,
 * facturado, cancelado e em aberto, revisões guardadas, anexos, cronologia e auditoria.
 */
@Component({
  selector: 'app-purchase-order-detail',
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
      [title]="title()"
      [subtitle]="x() ? x()!.supplier.code + ' — ' + x()!.supplier.name : ''"
      formId="purchase-order-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as o) {
        <section class="card space-y-3" aria-label="Estado" data-testid="od-state">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-muted">Aprovação</span>
            <span class="badge" [class]="aTone(o.approvalStatus)" data-testid="od-approval">{{
              aLabel(o.approvalStatus)
            }}</span>
            <span class="text-sm text-muted">Recepção</span>
            <span class="badge" [class]="pTone(o.receiptStatus)" data-testid="od-receipt">{{
              rLabel(o.receiptStatus)
            }}</span>
            <span class="text-sm text-muted">Facturação</span>
            <span class="badge" [class]="pTone(o.invoiceStatus)" data-testid="od-invoice">{{
              iLabel(o.invoiceStatus)
            }}</span>
            @if (o.closed) {
              <span class="badge bg-surface-2 text-muted">Fechada</span>
            }
          </div>
          <p class="text-sm" data-testid="od-total">
            Total {{ money(o.totalAmount, o.currency) }}
            @if (o.totalFunctional && o.exchangeRate !== '1.0000000000') {
              ({{ money(o.totalFunctional, null) }} em moeda funcional, câmbio
              {{ q(o.exchangeRate) }} de {{ date(o.rateDate) }})
            }
          </p>
          <p class="text-sm text-muted" data-testid="od-issue">
            @if (o.issuedRevision === null) {
              Ainda não emitida.
            } @else {
              Emitida a revisão {{ o.issuedRevision }} em {{ when(o.issuedAt)
              }}{{ o.issuedBy ? ' por ' + o.issuedBy : '' }}.
              @if (o.revision > o.issuedRevision) {
                Revisão {{ o.revision }} em curso (o fornecedor tem a revisão
                {{ o.issuedRevision }}).
              }
            }
          </p>
          @for (m of messages(o); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (kind() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" data-testid="od-error" />
          }
          @if (o.can.decideBlockedBy) {
            <p class="text-sm text-warning-text" data-testid="od-blocked">
              {{ blocked(o.can.decideBlockedBy) }}
            </p>
          }
          <div class="flex flex-wrap gap-2">
            @if (o.can.edit) {
              <a
                class="btn-secondary"
                data-testid="od-edit"
                [routerLink]="['/compras/ordens', o.id, 'editar']"
                >Editar</a
              >
            }
            @if (o.can.submit) {
              <button type="button" class="btn-primary" data-testid="od-submit" (click)="submit()">
                Pedir aprovação
              </button>
            }
            @if (o.can.decide) {
              <button
                type="button"
                class="btn-primary"
                data-testid="od-approve"
                (click)="approve()"
              >
                Aprovar etapa
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-reject"
                (click)="ask('reject')"
              >
                Recusar
              </button>
            }
            @if (o.can.issue) {
              <button
                type="button"
                class="btn-primary"
                data-testid="od-issue-btn"
                (click)="issue()"
              >
                {{ o.number ? 'Emitir revisão' : 'Emitir' }}
              </button>
            }
            @if (receivable(o)) {
              <a
                class="btn-primary"
                data-testid="od-receive"
                routerLink="/compras/recepcoes/nova"
                [queryParams]="{ orderId: o.id }"
                >Receber</a
              >
            }
            @if (o.can.revise) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-revise"
                (click)="ask('revise')"
              >
                Rever
              </button>
            }
            @if (o.can.close) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-close"
                (click)="ask('close')"
              >
                Fechar o resto
              </button>
            }
            @if (o.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="od-cancel"
                (click)="ask('cancel')"
              >
                Anular
              </button>
            }
          </div>
        </section>

        <section
          class="card grid gap-2 text-sm sm:grid-cols-2"
          aria-label="Condições"
          data-testid="od-terms"
        >
          <p>
            <span class="text-muted">Entidade:</span> {{ o.legalEntity.code
            }}{{ o.branch ? ' · ' + o.branch.code : '' }}
          </p>
          <p>
            <span class="text-muted">Centro de custo:</span>
            {{ o.costCenter ? o.costCenter.code + ' — ' + o.costCenter.name : '—' }}
          </p>
          <p>
            <span class="text-muted">Armazém:</span>
            {{ o.warehouse ? o.warehouse.code + ' — ' + o.warehouse.name : '—' }}
          </p>
          <p>
            <span class="text-muted">Data / entrega:</span> {{ date(o.orderDate) }} /
            {{ date(o.expectedDate) }}
          </p>
          <p>
            <span class="text-muted">Pagamento:</span>
            {{ o.paymentTermsDays === null ? '—' : o.paymentTermsDays + ' dias' }}
            {{ o.paymentMethod ? '· ' + method(o.paymentMethod) : '' }}
          </p>
          <p>
            <span class="text-muted">Entrega:</span> {{ o.deliveryTerms ?? '—'
            }}{{ o.incoterm ? ' · ' + o.incoterm : '' }}
          </p>
          @if (o.deliveryAddress) {
            <p><span class="text-muted">Morada:</span> {{ o.deliveryAddress }}</p>
          }
          @if (o.supplierReference) {
            <p><span class="text-muted">Ref. do fornecedor:</span> {{ o.supplierReference }}</p>
          }
          @if (o.contract) {
            <p data-testid="od-contract">
              <span class="text-muted">Contrato:</span>
              <a class="link" [routerLink]="['/compras/contratos', o.contract.id]"
                >{{ o.contract.number }} — {{ o.contract.title }}</a
              >
            </p>
          }
          @if (o.award) {
            <p>
              <span class="text-muted">Adjudicação:</span>
              <a class="link" [routerLink]="['/compras/adjudicacoes', o.award.id]"
                >pedido {{ o.award.rfqNumber }}</a
              >
            </p>
          }
          @if (o.notes) {
            <p class="whitespace-pre-line sm:col-span-2">{{ o.notes }}</p>
          }
        </section>

        <section class="card" aria-labelledby="od-approval-title">
          <h2 id="od-approval-title" class="mb-2 font-semibold">Aprovação</h2>
          @if (o.approval.length === 0) {
            <p class="text-sm text-muted">
              As etapas são fixadas ao pedir a aprovação, pelo total em moeda funcional.
            </p>
          } @else {
            <ol class="space-y-2 text-sm" data-testid="od-chain">
              @for (a of o.approval; track a.sequence) {
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

        <section class="card" aria-labelledby="od-lines-title">
          <h2 id="od-lines-title" class="mb-2 font-semibold">Linhas</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="od-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">#</th>
                  <th class="px-2 py-1">Descrição</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Preço</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Desc.</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Imp.</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Total</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Recebido</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Facturado</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Em aberto</th>
                </tr>
              </thead>
              <tbody>
                @for (l of o.lines; track l.id) {
                  <tr class="border-t border-border align-top">
                    <td class="px-2 py-1">{{ l.lineNo }}</td>
                    <td class="px-2 py-1">
                      {{ l.product ? l.product.sku + ' — ' : '' }}{{ l.description }}
                      @if (l.requisition) {
                        <a
                          class="block text-xs link"
                          [routerLink]="['/compras/requisicoes', l.requisition.id]"
                          >{{ l.requisition.number }}</a
                        >
                      }
                      @if (l.cancelledQuantity !== '0.000000') {
                        <span class="block text-xs text-muted"
                          >Cancelado {{ q(l.cancelledQuantity) }}</span
                        >
                      }
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.quantity) }} {{ l.uom?.code ?? '' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.unitPrice) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.discountRate) }}%
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.taxRate) }}%
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.totalAmount, null) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.receivedQuantity) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.invoicedQuantity) }}
                    </td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="od-open"
                    >
                      {{ q(l.openQuantity) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-right text-sm">
            Bruto {{ money(o.totalGross, null) }} · desconto {{ money(o.totalDiscount, null) }} ·
            líquido {{ money(o.totalNet, null) }} · imposto {{ money(o.totalTax, null) }}
          </p>
        </section>

        @if (receipts().length) {
          <section class="card" aria-labelledby="od-rec-title">
            <h2 id="od-rec-title" class="mb-2 font-semibold">Recepções</h2>
            <ul class="space-y-1 text-sm" data-testid="od-receipts">
              @for (r of receipts(); track r.id) {
                <li>
                  <a class="link" [routerLink]="['/compras/recepcoes', r.id]">{{
                    r.number ?? 'Rascunho'
                  }}</a>
                  · {{ date(r.receiptDate) }} · {{ receiptLabel(r.status)
                  }}{{ r.deliveryNote ? ' · guia ' + r.deliveryNote : '' }}
                </li>
              }
            </ul>
          </section>
        }

        @if (o.revisions.length) {
          <section class="card" aria-labelledby="od-rev-title">
            <h2 id="od-rev-title" class="mb-2 font-semibold">Revisões</h2>
            <ul class="space-y-1 text-sm" data-testid="od-revisions">
              @for (r of o.revisions; track r.revision) {
                <li>
                  Revisão {{ r.revision }} ({{ money(r.totalAmount, o.currency) }}) substituída em
                  {{ when(r.at) }} {{ r.by ? 'por ' + r.by : '' }} · <em>{{ r.reason }}</em>
                </li>
              }
            </ul>
          </section>
        }

        <app-attachments
          subjectType="purchase_order"
          [subjectId]="o.id"
          [canWrite]="o.can.edit || o.can.revise"
        />

        <section class="card" aria-labelledby="od-history-title">
          <h2 id="od-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="od-history">
            @for (h of o.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ event(h.kind) }}
                @if (h.revision) {
                  (rev. {{ h.revision }})
                }
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

        <app-audit-history entityType="purchase_order" [entityId]="o.id" [refreshKey]="o.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="kind() !== null" (closed)="kind.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      @if (kind() === 'revise') {
        <p class="mb-3 text-sm text-muted">
          A versão emitida fica guardada; a ordem volta a rascunho na revisão seguinte e precisa de
          nova aprovação e nova emissão.
        </p>
      }
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="od-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="od-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class PurchaseOrderDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly receipts = signal<ReceiptRow[]>([]);
  protected readonly receiptLabel = (s: ReceiptRow['status']) => RECEIPT_DOC_STATUS[s];
  /** Pode receber: emitida na revisão em vigor, aprovada, não fechada, algo em falta, e quem vê regista recepções. */
  protected receivable(o: Order) {
    return (
      this.workspace.canAny('procurement.receipts.manage') &&
      o.approvalStatus === 'APPROVED' &&
      o.issuedRevision === o.revision &&
      !o.closed &&
      o.receiptStatus !== 'RECEIVED'
    );
  }
  protected readonly x = signal<Order | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  protected reason = '';
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly aTone = approvalTone;
  protected readonly pTone = progressTone;
  protected readonly aLabel = (s: Order['approvalStatus']) => APPROVAL_STATUS[s];
  protected readonly rLabel = (s: Order['receiptStatus']) => RECEIPT_STATUS[s];
  protected readonly iLabel = (s: Order['invoiceStatus']) => INVOICE_STATUS[s];
  protected readonly method = (m: string) => PAYMENT_METHOD[m] ?? m;
  protected readonly event = (k: string) => ORDER_EVENT[k] ?? k;
  protected readonly blocked = (k: string) =>
    k === 'SELF_APPROVAL'
      ? 'Pediu a aprovação desta ordem: não a pode aprovar.'
      : (BLOCKED_BY[k] ?? k);
  protected readonly title = computed(() => {
    const o = this.x();
    if (!o) return 'Ordem de compra';
    return `Ordem de compra ${o.number ?? '(rascunho)'}${o.revision ? ' · rev. ' + o.revision : ''}`;
  });
  protected readonly modalTitle = computed(
    () =>
      ({
        reject: 'Recusar a ordem',
        revise: 'Rever a ordem emitida',
        cancel: 'Anular a ordem',
        close: 'Fechar o que fica por receber',
      })[this.kind() ?? 'reject'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected messages(o: Order) {
    const out: string[] = [];
    if (o.submittedAt)
      out.push(`Aprovação pedida por ${o.submittedBy ?? '—'} em ${formatDateTime(o.submittedAt)}.`);
    if (o.rejectReason) out.push(`Recusada: ${o.rejectReason}`);
    if (o.cancelReason) out.push(`Anulada: ${o.cancelReason}`);
    if (o.closeReason) out.push(`Resto fechado: ${o.closeReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Order>(`procurement/orders/${this.id()}`));
      // As recepções só para quem as pode ver (sem permissão, a secção não aparece).
      this.receipts.set(
        await this.api
          .page<ReceiptRow>('procurement/receipts', { orderId: this.id()!, limit: 50 })
          .then((p) => p.items)
          .catch(() => []),
      );
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  private set(o: Order) {
    this.x.set(o);
    this.breadcrumbs.setCurrent(o.number ?? 'Rascunho');
  }

  protected back() {
    void this.router.navigate(['/compras/ordens']);
  }

  private async run(path: string, message: string, body: Record<string, unknown> = {}) {
    const o = this.x()!;
    const r = await this.act.run(() =>
      this.api.post<Order>(`procurement/orders/${o.id}/${path}`, {
        expectedVersion: o.version,
        ...body,
      }),
    );
    if (!r) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return null;
    }
    this.set(r);
    this.toasts.show(message);
    return r;
  }

  protected async submit() {
    const ok = await this.confirmSvc.ask({
      title: 'Pedir aprovação',
      message:
        'O câmbio do dia e as etapas pelo total em moeda funcional ficam fixados; a ordem deixa de se alterar.',
      confirmLabel: 'Pedir aprovação',
    });
    if (ok) await this.run('submit', 'Aprovação pedida.');
  }

  protected async approve() {
    const o = this.x()!;
    const step = o.approval.find((a) => a.current);
    const ok = await this.confirmSvc.ask({
      title: 'Aprovar etapa',
      message: `Aprova a etapa ${step?.name ?? ''} (${money(o.totalAmount, o.currency)}).`,
      confirmLabel: 'Aprovar',
    });
    if (!ok) return;
    const r = await this.run('approve', 'Etapa aprovada.');
    if (r?.approvalStatus === 'APPROVED') this.toasts.show('Ordem aprovada.');
  }

  protected async issue() {
    const o = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: o.number ? 'Emitir a revisão' : 'Emitir a ordem',
      message: o.number
        ? `A revisão ${o.revision} substitui a emitida, com o mesmo número ${o.number}.`
        : 'A ordem recebe o número da série e as requisições ligadas ficam encomendadas.',
      confirmLabel: 'Emitir',
    });
    if (ok) await this.run('issue', 'Ordem emitida.');
  }

  protected ask(k: ReasonKind) {
    this.act.error.set(null);
    this.reason = '';
    this.kind.set(k);
  }

  protected async confirmReason() {
    const k = this.kind()!;
    const r = await this.run(
      k,
      {
        reject: 'Ordem recusada.',
        revise: 'Revisão aberta.',
        cancel: 'Ordem anulada.',
        close: 'Resto fechado.',
      }[k],
      { reason: this.reason },
    );
    if (!r) return;
    this.kind.set(null);
    if (k === 'revise') await this.router.navigate(['/compras/ordens', r.id, 'editar']);
  }
}
