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
import { BLOCKED_BY } from './requisition-model';
import { type Award, AWARD_STATUS, awardTone, WEIGHT_LABELS } from './rfq-model';

type ReasonKind = 'reject' | 'cancel';

/**
 * Adjudicação (9.4): estado, critérios e pesos, notas de qualidade, o que se adjudica por linha e fornecedor (com a
 * fotografia dos valores na moeda de base e o motivo das escolhas que não são as melhores), totais por fornecedor,
 * justificação e decisão (submeter, aprovar ou recusar por outra pessoa, anular).
 */
@Component({
  selector: 'app-rfq-award-detail',
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
      [title]="'Adjudicação ' + (a()?.rfq?.number ?? '')"
      [subtitle]="a()?.rfq?.title ?? ''"
      formId="rfq-award-detail"
      [loading]="!a()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (a(); as x) {
        <section class="card space-y-3" aria-label="Estado" data-testid="ad-state">
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge" [class]="tone(x.status)" data-testid="ad-status">{{
              statusLabel(x.status)
            }}</span>
            <span class="text-sm" data-testid="ad-total"
              >Total {{ money(x.totalBase, x.baseCurrency) }} (líquido
              {{ money(x.totalNetBase, null) }}) · câmbio de {{ date(x.rateDate) }}</span
            >
          </div>
          @for (m of messages(x); track m) {
            <p class="text-sm text-muted">{{ m }}</p>
          }
          @if (x.can.decideBlockedBy) {
            <p class="text-sm text-warning-text" data-testid="ad-blocked">
              {{ blocked(x.can.decideBlockedBy) }}
            </p>
          }
          <div class="flex flex-wrap gap-2">
            <a
              class="btn-secondary"
              [routerLink]="['/compras/cotacoes', x.rfq.id, 'adjudicacao']"
              >{{ x.can.edit ? 'Editar no mapa comparativo' : 'Mapa comparativo' }}</a
            >
            @if (x.can.submit) {
              <button type="button" class="btn-primary" data-testid="ad-submit" (click)="submit()">
                Submeter para aprovação
              </button>
            }
            @if (x.can.decide) {
              <button
                type="button"
                class="btn-primary"
                data-testid="ad-approve"
                (click)="approve()"
              >
                Aprovar
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="ad-reject"
                (click)="ask('reject')"
              >
                Recusar
              </button>
            }
            @if (x.can.cancel) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="ad-cancel"
                (click)="ask('cancel')"
              >
                Anular
              </button>
            }
          </div>
        </section>

        <section class="card space-y-2 text-sm" aria-labelledby="ad-crit-title">
          <h2 id="ad-crit-title" class="font-semibold">Critérios e justificação</h2>
          <p data-testid="ad-weights">
            @for (w of weightLabels; track w[0]; let last = $last) {
              {{ w[1] }} {{ x.weights[w[0]] }}%{{ last ? '' : ' · ' }}
            }
          </p>
          <p class="whitespace-pre-line" data-testid="ad-justification">{{ x.justification }}</p>
        </section>

        <section class="card" aria-labelledby="ad-lines-title">
          <h2 id="ad-lines-title" class="mb-2 font-semibold">Adjudicado</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="ad-lines">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Linha</th>
                  <th class="px-2 py-1">Fornecedor e oferta</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Preço</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">
                    Total ({{ x.baseCurrency }})
                  </th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">Pontuação</th>
                </tr>
              </thead>
              <tbody>
                @for (l of x.lines; track l.id) {
                  <tr class="border-t border-border align-top">
                    <td class="px-2 py-1">{{ l.lineNo }} · {{ l.description }}</td>
                    <td class="px-2 py-1">
                      {{ l.supplier.code }} — {{ l.supplier.name }}
                      @if (l.alternativeNo > 0) {
                        <span class="block text-xs text-muted"
                          >Alternativa {{ l.alternativeNo }}: {{ l.offerDescription }}</span
                        >
                      }
                      @if (l.reason) {
                        <span class="block text-xs" data-testid="ad-reason"
                          >Não é a melhor: <em>{{ l.reason }}</em></span
                        >
                      }
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.quantity) }} {{ l.uom ?? '' }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ q(l.unitPrice) }} {{ l.currency }}
                      @if (l.currency !== x.baseCurrency) {
                        <span class="block text-xs text-muted">× {{ q(l.rate) }}</span>
                      }
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ money(l.totalBase, null) }}
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ score(l.score) }}
                      @if (l.best) {
                        <span class="badge bg-success-soft text-success-text">Melhor</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <h3 class="mb-1 mt-4 text-sm font-semibold">Por fornecedor</h3>
          <ul class="space-y-1 text-sm" data-testid="ad-suppliers">
            @for (s of x.bySupplier; track s.supplier.id) {
              <li>
                {{ s.supplier.code }} — {{ s.supplier.name }}: {{ s.lines }} linha(s),
                {{ money(s.totalBase, x.baseCurrency) }}
                @if (quality(x, s.supplier.id); as qv) {
                  · qualidade {{ qv }}
                }
              </li>
            }
          </ul>
        </section>

        <app-audit-history entityType="rfq_award" [entityId]="x.id" [refreshKey]="x.version" />
      }
    </app-entity-form-page>

    <app-modal [title]="modalTitle()" [open]="kind() !== null" (closed)="kind.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="true" />
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="ad-reason-input"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="kind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ad-reason-ok"
          [disabled]="act.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class RfqAwardDetail {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly a = signal<Award | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly act = new Action();
  protected readonly kind = signal<ReasonKind | null>(null);
  protected reason = '';
  protected readonly weightLabels = WEIGHT_LABELS;
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected readonly tone = awardTone;
  protected readonly statusLabel = (s: Award['status']) => AWARD_STATUS[s];
  protected readonly blocked = (k: string) =>
    k === 'SELF_APPROVAL' ? 'Submeteu esta adjudicação: não a pode aprovar.' : (BLOCKED_BY[k] ?? k);
  protected readonly modalTitle = computed(() =>
    this.kind() === 'reject' ? 'Recusar a adjudicação' : 'Anular a adjudicação',
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected score(v: number) {
    return v.toFixed(2).replace('.', ',');
  }
  protected quality(x: Award, supplierId: string) {
    return x.quality[supplierId] ?? null;
  }

  protected messages(x: Award) {
    const out: string[] = [];
    if (x.createdBy) out.push(`Preparada por ${x.createdBy}.`);
    if (x.submittedAt)
      out.push(`Submetida por ${x.submittedBy ?? '—'} em ${formatDateTime(x.submittedAt)}.`);
    if (x.decidedAt)
      out.push(
        `${x.status === 'APPROVED' ? 'Aprovada' : 'Recusada'} por ${x.decidedBy ?? '—'} em ${formatDateTime(x.decidedAt)}${x.decisionReason ? ': ' + x.decisionReason : '.'}`,
      );
    if (x.cancelReason) out.push(`Anulada: ${x.cancelReason}`);
    return out;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const x = await this.api.get<Award>(`procurement/rfq-awards/${this.id()}`);
      this.a.set(x);
      this.breadcrumbs.setCurrent(`Adjudicação ${x.rfq.number}`);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected back() {
    const x = this.a();
    void this.router.navigate(x ? ['/compras/cotacoes', x.rfq.id] : ['/compras/cotacoes']);
  }

  private done(x: Award | undefined, message: string) {
    if (!x) {
      this.toasts.show(this.act.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.a.set(x);
    this.toasts.show(message);
  }

  protected async submit() {
    const x = this.a()!;
    const ok = await this.confirmSvc.ask({
      title: 'Submeter para aprovação',
      message: `A adjudicação (${money(x.totalBase, x.baseCurrency)}) fica fixa e vai para aprovação de outra pessoa.`,
      confirmLabel: 'Submeter',
    });
    if (!ok) return;
    this.done(
      await this.act.run(() =>
        this.api.post<Award>(`procurement/rfq-awards/${x.id}/submit`, {
          expectedVersion: x.version,
        }),
      ),
      'Adjudicação submetida.',
    );
  }

  protected async approve() {
    const x = this.a()!;
    const ok = await this.confirmSvc.ask({
      title: 'Aprovar a adjudicação',
      message: `Aprova a adjudicação do pedido ${x.rfq.number} (${money(x.totalBase, x.baseCurrency)}); o pedido fica adjudicado.`,
      confirmLabel: 'Aprovar',
    });
    if (!ok) return;
    this.done(
      await this.act.run(() =>
        this.api.post<Award>(`procurement/rfq-awards/${x.id}/approve`, {
          expectedVersion: x.version,
        }),
      ),
      'Adjudicação aprovada.',
    );
  }

  protected ask(k: ReasonKind) {
    this.act.error.set(null);
    this.reason = '';
    this.kind.set(k);
  }

  protected async confirmReason() {
    const x = this.a()!;
    const k = this.kind()!;
    const r = await this.act.run(() =>
      this.api.post<Award>(`procurement/rfq-awards/${x.id}/${k}`, {
        expectedVersion: x.version,
        reason: this.reason,
      }),
    );
    if (!r) return;
    this.a.set(r);
    this.kind.set(null);
    this.toasts.show(k === 'reject' ? 'Adjudicação recusada.' : 'Adjudicação anulada.');
  }
}
