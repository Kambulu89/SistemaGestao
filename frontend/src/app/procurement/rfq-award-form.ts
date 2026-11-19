import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { money } from '../inventory/valuation-model';
import { qty } from '../inventory/stock-model';
import {
  type Award,
  type Comparison,
  type ComparisonOffer,
  type Picks,
  picksPayload,
  plain,
  type Rfq,
  suggestBest,
  WEIGHT_LABELS,
  type Weights,
  weightSum,
} from './rfq-model';

/**
 * Mapa comparativo e adjudicação (9.4): pesos dos critérios (somam 100%) e notas de qualidade, ofertas lado a lado por
 * linha com preços na moeda funcional e pontuação, escolha por linha e fornecedor (motivo quando não é a melhor) e
 * justificação. Grava em preparação; a submissão e a aprovação fazem-se na ficha da adjudicação.
 */
@Component({
  selector: 'app-rfq-award-form',
  imports: [
    FormsModule,
    RouterLink,
    EntityFormPage,
    FormSection,
    FormField,
    FieldControl,
    ErrorAlert,
  ],
  template: `
    <app-entity-form-page
      [title]="'Mapa comparativo ' + (cmp()?.rfq?.number ?? '')"
      [subtitle]="cmp()?.rfq?.title ?? ''"
      formId="rfq-award-form"
      [loading]="!cmp()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [readOnly]="!canAward()"
      [saveLabel]="award() ? 'Guardar adjudicação' : 'Preparar adjudicação'"
      (save)="save()"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (cmp(); as c) {
        <app-form-section
          title="Critérios"
          [description]="
            'Valores em ' +
            c.baseCurrency +
            ' ao câmbio de ' +
            date(c.rateDate) +
            ' (abertura das propostas). Os pesos têm de somar 100%.'
          "
        >
          <div class="grid gap-3 sm:col-span-2 sm:grid-cols-4">
            @for (w of weightLabels; track w[0]) {
              <app-field [label]="w[1] + ' (%)'" [error]="action.field('weights.' + w[0])">
                <input
                  appControl
                  class="input"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  [name]="'w-' + w[0]"
                  [attr.data-testid]="'aw-w-' + w[0]"
                  [(ngModel)]="weights[w[0]]"
                />
              </app-field>
            }
          </div>
          <p
            class="text-sm sm:col-span-2"
            [class.text-danger-text]="sum() !== 100"
            data-testid="aw-sum"
          >
            Soma dos pesos: {{ sum() }}%
            @if (action.field('weights'); as e) {
              — {{ e }}
            }
          </p>
          <div class="overflow-x-auto sm:col-span-2">
            <table class="w-full text-sm" data-testid="aw-suppliers">
              <thead>
                <tr class="text-left text-muted">
                  <th class="px-2 py-1">Fornecedor</th>
                  <th class="whitespace-nowrap px-2 py-1 text-right">
                    Total ({{ c.baseCurrency }})
                  </th>
                  <th class="px-2 py-1">Moeda</th>
                  <th class="px-2 py-1">Entrega</th>
                  <th class="px-2 py-1">Pagamento</th>
                  <th class="px-2 py-1">Válida até</th>
                  <th class="px-2 py-1">Qualidade (0–100)</th>
                </tr>
              </thead>
              <tbody>
                @for (s of c.suppliers; track s.supplier.id) {
                  <tr class="border-t border-border">
                    <td class="px-2 py-1">
                      {{ s.supplier.code }} — {{ s.supplier.name }}
                      <span class="block text-xs text-muted"
                        >versão {{ s.quoteVersion }} · {{ s.linesQuoted }} linha(s) · melhor em
                        {{ s.bestLines }}</span
                      >
                    </td>
                    <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {{ s.totalBase === null ? 'sem câmbio' : money(s.totalBase, null) }}
                    </td>
                    <td class="px-2 py-1">
                      {{ s.currency }}
                      @if (s.currency !== c.baseCurrency) {
                        <span class="block text-xs text-muted">{{
                          s.rate ? '× ' + q(s.rate) : 'sem câmbio'
                        }}</span>
                      }
                    </td>
                    <td class="px-2 py-1">{{ days(s.deliveryDays) }}</td>
                    <td class="px-2 py-1">{{ days(s.paymentTermsDays) }}</td>
                    <td class="px-2 py-1">
                      {{ date(s.validUntil) }}
                      @if (s.expired) {
                        <span class="badge bg-danger-soft text-danger-text">Caducada</span>
                      }
                    </td>
                    <td class="px-2 py-1">
                      <input
                        class="input w-20"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        [name]="'q-' + s.supplier.id"
                        [attr.aria-label]="'Qualidade de ' + s.supplier.code"
                        data-testid="aw-quality"
                        [(ngModel)]="quality[s.supplier.id]"
                      />
                      @if (action.field('quality.' + s.supplier.id); as e) {
                        <span class="block text-xs text-danger-text">{{ e }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap gap-2 sm:col-span-2">
            <button
              type="button"
              class="btn-secondary"
              data-testid="aw-recalc"
              [disabled]="busy()"
              (click)="recalc()"
            >
              Recalcular pontuações
            </button>
            @if (canAward()) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="aw-suggest"
                (click)="suggest()"
              >
                Escolher as melhores por linha
              </button>
            }
          </div>
          <app-error-alert class="sm:col-span-2" [error]="recalcError()" />
        </app-form-section>

        @for (l of c.lines; track l.id) {
          <section class="card" [attr.aria-label]="'Linha ' + l.lineNo" data-testid="aw-line">
            <h2 class="mb-2 font-semibold">
              Linha {{ l.lineNo }} · {{ l.description }}
              <span class="font-normal text-muted">({{ q(l.quantity) }} {{ l.uom ?? '' }})</span>
            </h2>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Oferta</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Preço</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">
                      Preço ({{ c.baseCurrency }})
                    </th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">
                      Total ({{ c.baseCurrency }})
                    </th>
                    <th class="px-2 py-1">Entrega</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Pontuação</th>
                    @if (canAward()) {
                      <th class="px-2 py-1">Adjudicar</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (o of l.offers; track o.quoteLineId) {
                    <tr class="border-t border-border align-top" data-testid="aw-offer">
                      <td class="px-2 py-1">
                        <strong>{{ o.supplier.code }}</strong>
                        {{ o.alternativeNo === 0 ? '' : '· alternativa ' + o.alternativeNo }}
                        @if (o.description) {
                          <span class="block text-xs text-muted">{{ o.description }}</span>
                        }
                        @if (o.expired) {
                          <span class="badge bg-danger-soft text-danger-text">Caducada</span>
                        }
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(o.unitPrice) }} {{ o.currency }}
                        <span class="block text-xs text-muted">× {{ q(o.quantity) }}</span>
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ o.unitPriceBase === null ? '—' : q(o.unitPriceBase) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ o.totalBase === null ? '—' : money(o.totalBase, null) }}
                      </td>
                      <td class="px-2 py-1">{{ days(o.deliveryDays) }}</td>
                      <td
                        class="whitespace-nowrap px-2 py-1 text-right tabular-nums"
                        data-testid="aw-score"
                      >
                        @if (o.score; as s) {
                          <span [title]="breakdown(s)">{{ score(s.total) }}</span>
                          @if (s.best) {
                            <span
                              class="badge bg-success-soft text-success-text"
                              data-testid="aw-best"
                              >Melhor</span
                            >
                          }
                        } @else {
                          <span class="text-muted">sem câmbio</span>
                        }
                      </td>
                      @if (canAward()) {
                        <td class="px-2 py-1">
                          <input
                            class="input w-24"
                            inputmode="decimal"
                            placeholder="Qtd."
                            [name]="'pick-' + o.quoteLineId"
                            [attr.aria-label]="'Quantidade a adjudicar a ' + o.supplier.code"
                            data-testid="aw-qty"
                            [(ngModel)]="picks[o.quoteLineId].quantity"
                          />
                          @if (needsReason(o)) {
                            <input
                              class="input mt-1"
                              placeholder="Motivo (não é a melhor)"
                              [name]="'reason-' + o.quoteLineId"
                              aria-label="Motivo"
                              data-testid="aw-reason"
                              [(ngModel)]="picks[o.quoteLineId].reason"
                            />
                          }
                        </td>
                      }
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="7" class="px-2 py-2 text-muted">Sem ofertas para esta linha.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        @if (canAward()) {
          <app-form-section
            title="Decisão"
            description="Porque se adjudica assim; vai para aprovação de outra pessoa."
          >
            @for (e of lineErrors(); track e) {
              <p class="text-sm text-danger-text sm:col-span-2" data-testid="aw-line-error">
                {{ e }}
              </p>
            }
            <app-field
              label="Justificação"
              class="sm:col-span-2"
              [required]="true"
              [error]="action.field('justification')"
            >
              <textarea
                appControl
                class="input min-h-20"
                name="just"
                data-testid="aw-justification"
                [(ngModel)]="justification"
              ></textarea>
            </app-field>
          </app-form-section>
        } @else if (award(); as a) {
          <p class="text-sm">
            <a class="link" [routerLink]="['/compras/adjudicacoes', a.id]">Ver a adjudicação</a>
          </p>
        }
      }
    </app-entity-form-page>
  `,
})
export class RfqAwardForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly cmp = signal<Comparison | null>(null);
  protected readonly rfq = signal<Rfq | null>(null);
  protected readonly award = signal<Award | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly recalcError = signal<ApiError | null>(null);
  protected readonly busy = signal(false);
  protected readonly action = new Action();
  protected readonly weightLabels = WEIGHT_LABELS;
  protected readonly money = money;
  protected readonly q = qty;
  protected readonly date = formatDate;
  protected weights: Weights = { price: 60, delivery: 20, quality: 20, payment: 0 };
  protected quality: Record<string, number | null> = {};
  protected picks: Picks = {};
  protected justification = '';
  private initial = '';
  /** Pode preparar ou editar: o pedido está fechado e não há adjudicação viva, ou a viva está em preparação. */
  protected readonly canAward = computed(() => {
    const r = this.rfq();
    const a = this.award();
    return !!r && (r.can.award || (!!a && a.can.edit));
  });
  protected sum() {
    return weightSum(this.numericWeights());
  }
  /** Erros das linhas, com a oferta a que se referem (o índice é o da lista enviada). */
  protected readonly lineErrors = computed(() => {
    const c = this.cmp();
    const offers = new Map(
      (c?.lines ?? []).flatMap((l) => l.offers.map((o) => [o.quoteLineId, { l, o }] as const)),
    );
    return (this.action.error()?.details ?? [])
      .filter((d) => d.path === 'lines' || d.path?.startsWith('lines.'))
      .map((d) => {
        const i = Number(d.path.split('.')[1]);
        const sent = Number.isInteger(i) ? this.sent[i] : undefined;
        const x = sent ? offers.get(sent.quoteLineId) : undefined;
        return x ? `Linha ${x.l.lineNo} · ${x.o.supplier.code}: ${d.message}` : d.message;
      });
  });
  private sent: { quoteLineId: string }[] = [];

  constructor() {
    warnOnUnload(this);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return !!this.cmp() && this.canAward() && this.state() !== this.initial;
  }

  private state() {
    return snapshot({
      w: this.weights,
      q: this.quality,
      p: picksPayload(this.picks),
      j: this.justification,
    });
  }

  private numericWeights(): Weights {
    const n = (v: unknown) => (v === '' || v === null || v === undefined ? 0 : Number(v));
    return {
      price: n(this.weights.price),
      delivery: n(this.weights.delivery),
      quality: n(this.weights.quality),
      payment: n(this.weights.payment),
    };
  }

  private qualityPayload() {
    return Object.fromEntries(
      Object.entries(this.quality).filter(
        ([, v]) => v !== null && v !== undefined && `${v}` !== '',
      ),
    );
  }

  protected days(d: number | null) {
    return d === null ? '—' : `${d} dias`;
  }
  protected score(v: number) {
    return v.toFixed(2).replace('.', ',');
  }
  protected breakdown(s: { price: number; delivery: number; quality: number; payment: number }) {
    return `Preço ${s.price} · entrega ${s.delivery} · qualidade ${s.quality} · pagamento ${s.payment}`;
  }

  /** Uma entrada por oferta do mapa (vazia = não adjudicada), mantendo as escolhas já feitas. */
  private ensurePicks(c: Comparison) {
    for (const l of c.lines)
      for (const o of l.offers) this.picks[o.quoteLineId] ??= { quantity: '', reason: '' };
  }
  protected needsReason(o: ComparisonOffer) {
    const p = this.picks[o.quoteLineId];
    return !!p && p.quantity.trim() !== '' && !o.score?.best;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const r = await this.api.get<Rfq>(`procurement/rfqs/${this.id()}`);
      this.rfq.set(r);
      this.breadcrumbs.setCurrent(r.number ?? 'Pedido');
      const live = r.awards.find((a) =>
        ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(a.status),
      );
      const a = live ? await this.api.get<Award>(`procurement/rfq-awards/${live.id}`) : null;
      this.award.set(a);
      if (a) {
        this.weights = { ...a.weights };
        this.quality = { ...a.quality };
        this.justification = a.justification;
        this.picks = Object.fromEntries(
          a.lines.map((l) => [
            l.quoteLineId,
            { quantity: plain(l.quantity), reason: l.reason ?? '' },
          ]),
        );
      }
      await this.fetch();
      this.initial = this.state();
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  private async fetch() {
    const c = await this.api.post<Comparison>(`procurement/rfqs/${this.id()}/comparison`, {
      weights: this.numericWeights(),
      quality: this.qualityPayload(),
    });
    this.ensurePicks(c);
    this.cmp.set(c);
    for (const s of c.suppliers) this.quality[s.supplier.id] ??= null;
  }

  protected async recalc() {
    this.recalcError.set(null);
    this.busy.set(true);
    try {
      await this.fetch();
    } catch (e) {
      this.recalcError.set(ApiError.from(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected suggest() {
    const c = this.cmp();
    if (!c) return;
    const best = suggestBest(c);
    for (const [id, p] of Object.entries(this.picks)) {
      p.quantity = best[id]?.quantity ?? '';
      p.reason = '';
    }
  }

  protected async save() {
    const a = this.award();
    const body = {
      weights: this.numericWeights(),
      quality: this.qualityPayload(),
      justification: this.justification,
      lines: picksPayload(this.picks),
    };
    this.sent = body.lines;
    const saved = await this.action.run(() =>
      a
        ? this.api.put<Award>(`procurement/rfq-awards/${a.id}`, {
            ...body,
            expectedVersion: a.version,
          })
        : this.api.post<Award>(`procurement/rfqs/${this.id()}/awards`, body),
    );
    if (!saved) return;
    this.initial = this.state();
    this.toasts.show(a ? 'Adjudicação guardada.' : 'Adjudicação preparada.');
    await this.router.navigate(['/compras/adjudicacoes', saved.id]);
  }

  protected back() {
    void this.router.navigate(['/compras/cotacoes', this.id()]);
  }
}
