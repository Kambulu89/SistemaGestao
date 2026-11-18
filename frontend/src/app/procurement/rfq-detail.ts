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
import {
  AWARD_STATUS,
  awardTone,
  INVITATION_STATUS,
  invitationTone,
  isoToLocal,
  localToIso,
  nextAlternative,
  plain,
  QUOTE_STATUS,
  type QuoteLineForm,
  quoteForm,
  quotePayload,
  quoteTotal,
  type Rfq,
  RFQ_EVENT,
  RFQ_STATUS,
  type RfqOptions,
  rfqTone,
} from './rfq-model';

type ReasonKind = 'cancel' | 'decline' | 'withdraw';

/**
 * Pedido de cotação (9.3): estado e prazo, convidados (convidar, retirar no rascunho, declinar), propostas por
 * fornecedor com versões (valores ocultos enquanto o envelope está fechado), registo de proposta com alternativas,
 * revisão com motivo, abertura, anulação, anexos e cronologia.
 */
@Component({
  selector: 'app-rfq-detail',
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
      [subtitle]="x()?.title ?? ''"
      formId="rfq-detail"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as r) {
        <section class="card space-y-3" aria-label="Estado" data-testid="qd-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(r.status)" data-testid="qd-status">{{
              statusLabel(r.status)
            }}</span>
            <span class="text-sm text-muted"
              >{{ r.legalEntity.code }} · {{ r.currency }} · prazo
              <strong data-testid="qd-closes">{{ when(r.closesAt) }}</strong>
              @if (r.revision > 0) {
                · revisão {{ r.revision }}
              }
              · envelope {{ r.sealed ? 'fechado' : 'aberto' }}</span
            >
          </div>
          @if (r.cancelReason) {
            <p class="text-sm text-muted">Anulado: {{ r.cancelReason }}</p>
          }
          @if (r.openedAt) {
            <p class="text-sm text-muted">Propostas abertas em {{ when(r.openedAt) }}.</p>
          }
          <div class="flex flex-wrap gap-2">
            @if (r.can.edit) {
              <a class="btn-secondary" [routerLink]="['/compras/cotacoes', r.id, 'editar']"
                >Editar</a
              >
            }
            @if (r.can.issue) {
              <button type="button" class="btn-primary" data-testid="qd-issue" (click)="issue()">
                Emitir
              </button>
            }
            @if (r.can.quote) {
              <button
                type="button"
                class="btn-primary"
                data-testid="qd-quote"
                (click)="openQuote()"
              >
                Registar proposta
              </button>
            }
            @if (r.can.amend) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-amend"
                (click)="openAmend()"
              >
                Rever pedido
              </button>
            }
            @if (r.can.open) {
              <button type="button" class="btn-primary" data-testid="qd-open" (click)="openBids()">
                Abrir propostas
              </button>
            }
            @if (r.status === 'CLOSED' || r.status === 'AWARDED') {
              <a
                [class]="r.can.award ? 'btn-primary' : 'btn-secondary'"
                data-testid="qd-compare"
                [routerLink]="['/compras/cotacoes', r.id, 'adjudicacao']"
                >{{ r.can.award ? 'Comparar e adjudicar' : 'Mapa comparativo' }}</a
              >
            }
            @if (r.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-cancel"
                (click)="ask('cancel')"
              >
                Anular
              </button>
            }
          </div>
        </section>

        @if (r.awards.length) {
          <section class="card" aria-labelledby="qd-awards-title">
            <h2 id="qd-awards-title" class="mb-2 font-semibold">Adjudicações</h2>
            <ul class="space-y-1 text-sm" data-testid="qd-awards">
              @for (w of r.awards; track w.id) {
                <li class="flex flex-wrap items-center gap-2">
                  <span class="badge" [class]="awardTone(w.status)">{{
                    awardLabel(w.status)
                  }}</span>
                  <a class="link" [routerLink]="['/compras/adjudicacoes', w.id]">{{
                    money(w.totalBase, w.baseCurrency)
                  }}</a>
                  <span class="text-muted">{{ when(w.createdAt) }}</span>
                </li>
              }
            </ul>
          </section>
        }

        <section class="card space-y-2 text-sm" aria-labelledby="qd-req-title">
          <h2 id="qd-req-title" class="font-semibold">Pedido</h2>
          @if (r.specifications) {
            <p class="whitespace-pre-line">{{ r.specifications }}</p>
          }
          <p><span class="text-muted">Entrega:</span> {{ r.deliveryTerms ?? '—' }}</p>
          <p><span class="text-muted">Pagamento:</span> {{ r.paymentTerms ?? '—' }}</p>
          <div class="overflow-x-auto">
            <table class="w-full" data-testid="qd-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">#</th>
                  <th class="px-2 py-1">Descrição</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  <th class="px-2 py-1">Entrega</th>
                  <th class="px-2 py-1">Requisição</th>
                </tr>
              </thead>
              <tbody>
                @for (l of r.lines; track l.id) {
                  <tr class="border-t border-border">
                    <td class="px-2 py-1">{{ l.lineNo }}</td>
                    <td class="px-2 py-1">
                      {{ l.product ? l.product.sku + ' — ' : '' }}{{ l.description }}
                      @if (l.specifications) {
                        <span class="block text-xs text-muted">{{ l.specifications }}</span>
                      }
                    </td>
                    <td
                      class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                      data-testid="qd-qty"
                    >
                      {{ q(l.quantity) }} {{ l.uom?.code ?? '' }}
                    </td>
                    <td class="px-2 py-1">{{ date(l.neededBy) }}</td>
                    <td class="px-2 py-1">
                      @if (l.requisition) {
                        <a class="link" [routerLink]="['/compras/requisicoes', l.requisition.id]">{{
                          l.requisition.number
                        }}</a>
                      } @else {
                        —
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card space-y-2" aria-labelledby="qd-inv-title">
          <h2 id="qd-inv-title" class="font-semibold">Fornecedores convidados</h2>
          <ul class="space-y-2 text-sm" data-testid="qd-invitations">
            @for (i of r.invitations; track i.id) {
              <li class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{{ i.supplier.code }} — {{ i.supplier.name }}</span>
                <span class="badge" [class]="invTone(i.status)">{{ invLabel(i.status) }}</span>
                @if (i.declineReason) {
                  <span class="text-muted">{{ i.declineReason }}</span>
                }
                @if (r.status === 'DRAFT' && r.can.invite) {
                  <button type="button" class="link" (click)="uninvite(i.id)">Retirar</button>
                }
                @if (r.status === 'OPEN' && i.status === 'INVITED' && r.can.amend) {
                  <button
                    type="button"
                    class="link"
                    data-testid="qd-decline"
                    (click)="ask('decline', i.id)"
                  >
                    Registar recusa
                  </button>
                }
              </li>
            } @empty {
              <li class="text-muted">Ainda ninguém convidado.</li>
            }
          </ul>
          @if (r.can.invite && candidates().length) {
            <div class="flex flex-wrap items-end gap-2">
              <app-field label="Convidar">
                <select
                  appControl
                  class="input"
                  name="invite"
                  data-testid="qd-invite-pick"
                  [(ngModel)]="invitePick"
                >
                  <option value="">Fornecedor homologado…</option>
                  @for (s of candidates(); track s.id) {
                    <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
                  }
                </select>
              </app-field>
              <button
                type="button"
                class="btn-secondary"
                data-testid="qd-invite"
                [disabled]="!invitePick || act.busy()"
                (click)="invite()"
              >
                Convidar
              </button>
            </div>
          }
        </section>

        <section class="card space-y-3" aria-labelledby="qd-quotes-title">
          <h2 id="qd-quotes-title" class="font-semibold">Propostas</h2>
          @if (r.pricesHidden) {
            <p class="rounded bg-surface-2 p-2 text-sm" data-testid="qd-sealed">
              Envelope fechado: {{ activeCount() }} proposta(s) em vigor. Os valores ficam ocultos
              para todos até à abertura.
            </p>
          }
          @for (p of r.quotes; track p.id) {
            <article
              class="rounded border border-border p-3 text-sm"
              [class.opacity-70]="p.status !== 'ACTIVE'"
              data-testid="qd-quote-card"
            >
              <div class="flex flex-wrap items-center gap-2">
                <strong>{{ p.supplier.code }} — {{ p.supplier.name }}</strong>
                <span class="text-muted">versão {{ p.quoteVersion }}</span>
                <span
                  class="badge"
                  [class]="
                    p.status === 'ACTIVE'
                      ? 'bg-success-soft text-success-text'
                      : 'bg-surface-2 text-muted'
                  "
                  >{{ quoteLabel(p.status) }}</span
                >
                @if (p.outdated && p.status === 'ACTIVE') {
                  <span class="badge bg-warning-soft text-warning-text" data-testid="qd-outdated"
                    >Feita à revisão {{ p.rfqRevision }}</span
                  >
                }
                <span class="text-muted"
                  >recebida {{ when(p.receivedAt)
                  }}{{ p.receivedBy ? ' · ' + p.receivedBy : '' }}</span
                >
                @if (p.status === 'ACTIVE' && r.status === 'OPEN' && r.can.amend) {
                  <button type="button" class="link" (click)="ask('withdraw', p.id)">
                    Retirar
                  </button>
                }
              </div>
              @if (p.withdrawReason) {
                <p class="text-muted">Retirada: {{ p.withdrawReason }}</p>
              }
              @if (p.totalAmount !== null) {
                <p class="mt-1" data-testid="qd-quote-total">
                  Total {{ money(p.totalAmount, p.currency) }} (líquido
                  {{ money(p.totalNet, null) }}, imposto {{ money(p.totalTax, null) }})
                  @if (p.deliveryDays !== null) {
                    · entrega {{ p.deliveryDays }} dias
                  }
                  @if (p.paymentTermsDays !== null) {
                    · pagamento {{ p.paymentTermsDays }} dias
                  }
                  · válida até {{ date(p.validUntil) }}
                  @if (p.supplierReference) {
                    · ref. {{ p.supplierReference }}
                  }
                </p>
                <div class="mt-2 overflow-x-auto">
                  <table class="w-full">
                    <thead>
                      <tr class="text-left text-muted">
                        <th class="px-2 py-1">Linha</th>
                        <th class="px-2 py-1">Oferta</th>
                        <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                        <th class="whitespace-nowrap px-2 py-1 text-right">Preço</th>
                        <th class="whitespace-nowrap px-2 py-1 text-right">Imposto</th>
                        <th class="whitespace-nowrap px-2 py-1 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (l of p.lines; track $index) {
                        <tr class="border-t border-border">
                          <td class="px-2 py-1">{{ l.lineNo }}</td>
                          <td class="px-2 py-1">
                            {{
                              l.alternativeNo === 0 ? 'Principal' : 'Alternativa ' + l.alternativeNo
                            }}
                            @if (l.description) {
                              <span class="block text-xs text-muted">{{ l.description }}</span>
                            }
                          </td>
                          <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                            {{ q(l.quantity) }}
                          </td>
                          <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                            {{ q(l.unitPrice) }}
                          </td>
                          <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                            {{ q(l.taxRate) }}%
                          </td>
                          <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                            {{ money(l.totalAmount, null) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </article>
          } @empty {
            <p class="text-sm text-muted">Ainda não há propostas.</p>
          }
        </section>

        <app-attachments subjectType="rfq" [subjectId]="r.id" [canWrite]="r.can.cancel" />

        <section class="card" aria-labelledby="qd-history-title">
          <h2 id="qd-history-title" class="mb-2 font-semibold">Cronologia</h2>
          <ul class="space-y-1 text-sm" data-testid="qd-history">
            @for (h of r.history; track $index) {
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

        <app-audit-history entityType="rfq" [entityId]="r.id" [refreshKey]="r.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="reasonTitle()" [open]="kind() !== null" (closed)="kind.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="qd-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="qd-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>

    <app-modal title="Registar proposta" [open]="quoting()" (closed)="quoting.set(false)">
      <app-error-alert [error]="qa.error()" [showDetails]="true" />
      <div class="grid gap-3 sm:grid-cols-2">
        <app-field label="Fornecedor" [required]="true" [error]="qa.field('supplierId')">
          <select
            appControl
            class="input"
            name="qsup"
            data-testid="qq-supplier"
            [(ngModel)]="qf.supplierId"
          >
            <option value="">Escolher…</option>
            @for (i of quotable(); track i.id) {
              <option [value]="i.supplier.id">{{ i.supplier.code }} — {{ i.supplier.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Referência do fornecedor" [error]="qa.field('supplierReference')">
          <input
            appControl
            class="input"
            name="qref"
            data-testid="qq-ref"
            [(ngModel)]="qf.supplierReference"
          />
        </app-field>
        <app-field label="Válida até" [required]="true" [error]="qa.field('validUntil')">
          <input
            appControl
            class="input"
            type="date"
            name="qvalid"
            data-testid="qq-valid"
            [(ngModel)]="qf.validUntil"
          />
        </app-field>
        <app-field label="Moeda" [error]="qa.field('currency')">
          <input
            appControl
            class="input w-24"
            name="qcur"
            maxlength="3"
            [(ngModel)]="qf.currency"
          />
        </app-field>
        <app-field label="Prazo de entrega (dias)" [error]="qa.field('deliveryDays')">
          <input
            appControl
            class="input"
            inputmode="numeric"
            name="qdel"
            data-testid="qq-delivery"
            [(ngModel)]="qf.deliveryDays"
          />
        </app-field>
        <app-field label="Prazo de pagamento (dias)" [error]="qa.field('paymentTermsDays')">
          <input
            appControl
            class="input"
            inputmode="numeric"
            name="qpay"
            [(ngModel)]="qf.paymentTermsDays"
          />
        </app-field>
      </div>
      <div class="mt-3 space-y-2">
        @for (l of qf.lines; track $index; let i = $index) {
          <fieldset class="rounded border border-border p-2" [attr.data-testid]="'qq-line-' + i">
            <legend class="px-1 text-sm">
              Linha {{ lineNo(l.rfqLineId) }} ·
              {{ l.alternativeNo === 0 ? 'principal' : 'alternativa ' + l.alternativeNo }}
            </legend>
            <div class="grid gap-2 sm:grid-cols-3">
              @if (l.alternativeNo > 0) {
                <app-field
                  label="Descrição da alternativa"
                  class="sm:col-span-3"
                  [error]="qa.field('lines.' + i + '.description')"
                >
                  <input
                    appControl
                    class="input"
                    [name]="'qdesc' + i"
                    [(ngModel)]="l.description"
                  />
                </app-field>
              }
              <app-field label="Quantidade" [error]="qa.field('lines.' + i + '.quantity')">
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'qqty' + i"
                  [(ngModel)]="l.quantity"
                />
              </app-field>
              <app-field label="Preço unitário" [error]="qa.field('lines.' + i + '.unitPrice')">
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'qprice' + i"
                  data-testid="qq-price"
                  [(ngModel)]="l.unitPrice"
                />
              </app-field>
              <app-field label="Imposto (%)" [error]="qa.field('lines.' + i + '.taxRate')">
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  [name]="'qtax' + i"
                  data-testid="qq-tax"
                  [(ngModel)]="l.taxRate"
                />
              </app-field>
            </div>
            <div class="mt-1 flex justify-end gap-3 text-sm">
              @if (l.alternativeNo === 0) {
                <button type="button" class="link" data-testid="qq-alt" (click)="addAlternative(i)">
                  Acrescentar alternativa
                </button>
              } @else {
                <button type="button" class="link" (click)="qf.lines.splice(i, 1)">Remover</button>
              }
            </div>
          </fieldset>
        }
      </div>
      <p class="mt-2 text-sm" data-testid="qq-total">
        Total (ofertas principais): {{ draftTotal() }}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="quoting.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="qq-save"
          [disabled]="qa.busy()"
          (click)="saveQuote()"
        >
          Registar
        </button>
      </div>
    </app-modal>

    <app-modal title="Rever o pedido" [open]="amending()" (closed)="amending.set(false)">
      <app-error-alert [error]="aa.error()" [showDetails]="true" />
      <p class="mb-3 text-sm text-muted">
        A revisão fica registada; as propostas já recebidas ficam assinaladas como feitas a uma
        revisão anterior.
      </p>
      <div class="space-y-3">
        <app-field label="Motivo" [required]="true" [error]="aa.field('reason')">
          <input
            appControl
            class="input"
            name="areason"
            data-testid="qa-reason"
            [(ngModel)]="af.reason"
          />
        </app-field>
        <app-field label="Prazo de resposta" [error]="aa.field('closesAt')">
          <input
            appControl
            class="input"
            type="datetime-local"
            name="acloses"
            data-testid="qa-closes"
            [(ngModel)]="af.closesAt"
          />
        </app-field>
        <app-field label="Especificações" [error]="aa.field('specifications')">
          <textarea
            appControl
            class="input min-h-16"
            name="aspecs"
            [(ngModel)]="af.specifications"
          ></textarea>
        </app-field>
        @for (l of af.lines; track l.lineId; let i = $index) {
          <app-field
            [label]="'Quantidade da linha ' + l.lineNo"
            [error]="aa.field('lines.' + i + '.quantity')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              [name]="'aqty' + i"
              data-testid="qa-qty"
              [(ngModel)]="l.quantity"
            />
          </app-field>
        }
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="amending.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="qa-save"
          [disabled]="aa.busy()"
          (click)="saveAmend()"
        >
          Rever
        </button>
      </div>
    </app-modal>
  `,
})
export class RfqDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Rfq | null>(null);
  protected readonly opts = signal<RfqOptions | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly qa = new Action();
  protected readonly aa = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  protected readonly quoting = signal(false);
  protected readonly amending = signal(false);
  private target = '';
  protected reason = '';
  protected invitePick = '';
  protected qf = this.emptyQuote();
  protected af = {
    reason: '',
    closesAt: '',
    specifications: '',
    lines: [] as { lineId: string; lineNo: number; quantity: string; original: string }[],
    originalCloses: '',
    originalSpecs: '',
  };
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly tone = rfqTone;
  protected readonly invTone = invitationTone;
  protected readonly statusLabel = (s: Rfq['status']) => RFQ_STATUS[s];
  protected readonly invLabel = (s: Rfq['invitations'][number]['status']) => INVITATION_STATUS[s];
  protected readonly quoteLabel = (s: Rfq['quotes'][number]['status']) => QUOTE_STATUS[s];
  protected readonly event = (k: string) => RFQ_EVENT[k] ?? k;
  protected readonly awardTone = awardTone;
  protected readonly awardLabel = (s: Rfq['awards'][number]['status']) => AWARD_STATUS[s];
  protected readonly title = computed(() => {
    const r = this.x();
    return r ? `Pedido de cotação ${r.number ?? '(rascunho)'}` : 'Pedido de cotação';
  });
  protected readonly activeCount = computed(
    () => this.x()?.quotes.filter((q) => q.status === 'ACTIVE').length ?? 0,
  );
  protected readonly candidates = computed(() => {
    const used = new Set(this.x()?.invitations.map((i) => i.supplier.id) ?? []);
    return (this.opts()?.suppliers ?? []).filter((s) => !used.has(s.id));
  });
  protected readonly quotable = computed(
    () => this.x()?.invitations.filter((i) => i.status !== 'DECLINED') ?? [],
  );
  protected readonly reasonTitle = computed(
    () =>
      ({
        cancel: 'Anular o pedido de cotação',
        decline: 'Registar a recusa do fornecedor',
        withdraw: 'Retirar a proposta',
      })[this.kind() ?? 'cancel'],
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private emptyQuote() {
    return {
      supplierId: '',
      supplierReference: '',
      validUntil: '',
      currency: '',
      deliveryDays: '',
      paymentTermsDays: '',
      lines: [] as QuoteLineForm[],
    };
  }

  protected lineNo(id: string) {
    return this.x()?.lines.find((l) => l.id === id)?.lineNo ?? '?';
  }

  protected draftTotal() {
    const t = quoteTotal(this.qf.lines);
    return t === null ? '—' : money(t, this.qf.currency || null);
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const r = await this.api.get<Rfq>(`procurement/rfqs/${this.id()}`);
      this.set(r);
      if (r.can.invite && !this.opts())
        this.opts.set(await this.api.get<RfqOptions>('procurement/rfqs/options').catch(() => null));
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private set(r: Rfq) {
    this.x.set(r);
    this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
  }

  protected back() {
    void this.router.navigate(['/compras/cotacoes']);
  }

  private done(r: Rfq | null | undefined, message: string) {
    if (!r) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.set(r);
    this.toasts.show(message);
  }

  protected async issue() {
    const r = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: 'Emitir o pedido de cotação',
      message: `O pedido recebe número e fica aberto a propostas até ${formatDateTime(r.closesAt)}; depois só se revê com motivo.`,
      confirmLabel: 'Emitir',
    });
    if (!ok) return;
    this.done(
      await this.act.run(() =>
        this.api.post<Rfq>(`procurement/rfqs/${r.id}/issue`, { expectedVersion: r.version }),
      ),
      'Pedido emitido.',
    );
  }

  protected async openBids() {
    const r = this.x()!;
    const ok = await this.confirmSvc.ask({
      title: 'Abrir as propostas',
      message: 'O pedido fecha: deixam de entrar propostas e os valores ficam visíveis.',
      confirmLabel: 'Abrir',
    });
    if (!ok) return;
    this.done(
      await this.act.run(() =>
        this.api.post<Rfq>(`procurement/rfqs/${r.id}/open`, { expectedVersion: r.version }),
      ),
      'Propostas abertas.',
    );
  }

  protected async invite() {
    const r = this.x()!;
    const res = await this.act.run(() =>
      this.api.post<Rfq>(`procurement/rfqs/${r.id}/invitations`, {
        supplierIds: [this.invitePick],
      }),
    );
    this.invitePick = '';
    this.done(res, 'Fornecedor convidado.');
  }

  protected async uninvite(invitationId: string) {
    const ok = await this.act.run(async () => {
      await this.api.delete(`procurement/rfq-invitations/${invitationId}`);
      return true;
    });
    if (!ok) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    await this.load();
    this.toasts.show('Convite retirado.');
  }

  protected ask(k: ReasonKind, target = '') {
    this.act.error.set(null);
    this.reason = '';
    this.target = target;
    this.kind.set(k);
  }

  protected async confirmReason() {
    const r = this.x()!;
    const k = this.kind()!;
    const url = {
      cancel: `procurement/rfqs/${r.id}/cancel`,
      decline: `procurement/rfq-invitations/${this.target}/decline`,
      withdraw: `procurement/rfq-quotes/${this.target}/withdraw`,
    }[k];
    const res = await this.act.run(() =>
      this.api.post<Rfq>(url, { expectedVersion: r.version, reason: this.reason }),
    );
    if (!res) return;
    this.set(res);
    this.kind.set(null);
    this.toasts.show(
      { cancel: 'Pedido anulado.', decline: 'Recusa registada.', withdraw: 'Proposta retirada.' }[
        k
      ],
    );
  }

  protected openQuote() {
    const r = this.x()!;
    this.qa.error.set(null);
    this.qf = { ...this.emptyQuote(), currency: r.currency, lines: quoteForm(r.lines) };
    this.quoting.set(true);
  }

  protected addAlternative(i: number) {
    const base = this.qf.lines[i];
    const n = nextAlternative(this.qf.lines, base.rfqLineId);
    if (n === null) return;
    let at = 0;
    this.qf.lines.forEach((l, k) => {
      if (l.rfqLineId === base.rfqLineId) at = k + 1;
    });
    this.qf.lines.splice(at, 0, { ...base, alternativeNo: n, description: '', unitPrice: '' });
  }

  protected async saveQuote() {
    const r = this.x()!;
    const int = (v: string) => (v.trim() === '' ? null : Number(v));
    const res = await this.qa.run(() =>
      this.api.post<Rfq>(`procurement/rfqs/${r.id}/quotes`, {
        supplierId: this.qf.supplierId,
        supplierReference: this.qf.supplierReference.trim() || null,
        validUntil: this.qf.validUntil,
        currency: this.qf.currency.trim().toUpperCase() || undefined,
        deliveryDays: int(this.qf.deliveryDays),
        paymentTermsDays: int(this.qf.paymentTermsDays),
        lines: quotePayload(this.qf.lines),
      }),
    );
    if (!res) return;
    this.set(res);
    this.quoting.set(false);
    this.toasts.show(
      res.pricesHidden ? 'Proposta registada (envelope fechado).' : 'Proposta registada.',
    );
  }

  protected openAmend() {
    const r = this.x()!;
    this.aa.error.set(null);
    const closes = isoToLocal(r.closesAt);
    this.af = {
      reason: '',
      closesAt: closes,
      specifications: r.specifications ?? '',
      lines: r.lines.map((l) => {
        const v = plain(l.quantity);
        return { lineId: l.id, lineNo: l.lineNo, quantity: v, original: v };
      }),
      originalCloses: closes,
      originalSpecs: r.specifications ?? '',
    };
    this.amending.set(true);
  }

  protected async saveAmend() {
    const r = this.x()!;
    const a = this.af;
    const res = await this.aa.run(() =>
      this.api.post<Rfq>(`procurement/rfqs/${r.id}/amend`, {
        expectedVersion: r.version,
        reason: a.reason,
        ...(a.closesAt !== a.originalCloses ? { closesAt: localToIso(a.closesAt) } : {}),
        ...(a.specifications !== a.originalSpecs ? { specifications: a.specifications } : {}),
        lines: a.lines
          .filter((l) => l.quantity !== l.original)
          .map((l) => ({ lineId: l.lineId, quantity: l.quantity.trim().replace(',', '.') })),
      }),
    );
    if (!res) return;
    this.set(res);
    this.amending.set(false);
    this.toasts.show(`Pedido revisto (revisão ${res.revision}).`);
  }
}
