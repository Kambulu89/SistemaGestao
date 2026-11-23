import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  CRITERIA,
  CRITERION,
  CRITERION_HINT,
  type Criterion,
  defaultPeriod,
  type Ranking,
  type Rating,
  RATING_HINT,
  ratingTone,
  scoreLabel,
  type Weights,
  weightsSum,
} from './evaluation-model';

type Row = Ranking['items'][number];

/**
 * Mapa de avaliação dos fornecedores num período: nota ponderada (qualidade, prazo, conformidade, custo) calculada
 * das recepções, devoluções, facturas e propostas das entidades do âmbito, classe A–D, resumo por classe e a última
 * avaliação publicada. Os pesos são da empresa.
 */
@Component({
  selector: 'app-supplier-evaluations',
  imports: [
    FormsModule,
    RouterLink,
    PageHeader,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
  ],
  template: `
    <app-page-header
      title="Avaliação de fornecedores"
      subtitle="Nota ponderada das provas do período: qualidade, prazo, conformidade e custo. Critérios sem provas não contam."
    />
    <div class="mb-3 flex flex-wrap items-end gap-3">
      <label class="block">
        <span class="label">De</span>
        <input
          class="input w-44"
          type="date"
          name="from"
          data-testid="ev-from"
          [(ngModel)]="from"
        />
      </label>
      <label class="block">
        <span class="label">Até</span>
        <input class="input w-44" type="date" name="to" data-testid="ev-to" [(ngModel)]="to" />
      </label>
      <button type="button" class="btn-primary" data-testid="ev-apply" (click)="load()">
        Calcular
      </button>
      @if (canWeights()) {
        <button
          type="button"
          class="btn-secondary"
          data-testid="ev-weights"
          (click)="openWeights()"
        >
          Pesos
        </button>
      }
    </div>
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else {
      @if (data(); as d) {
        <section
          class="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5"
          aria-label="Resumo por classe"
          data-testid="ev-summary"
        >
          @for (r of ratings; track r) {
            <div class="card">
              <span class="badge" [class]="tone(r)">Classe {{ r }}</span>
              <p
                class="mt-1 text-2xl font-semibold tabular-nums"
                [attr.data-testid]="'ev-count-' + r"
              >
                {{ d.summary[r] ?? 0 }}
              </p>
              <p class="text-xs text-muted">{{ hint(r) }}</p>
            </div>
          }
          <div class="card">
            <span class="badge" [class]="tone(null)">Sem nota</span>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ d.summary.none ?? 0 }}</p>
            <p class="text-xs text-muted">sem provas com peso</p>
          </div>
        </section>
        <p class="mb-2 text-xs text-muted" data-testid="ev-weights-text">
          Pesos:
          @for (c of criteria; track c) {
            {{ label(c) }} {{ d.weights[c] }}%{{ $last ? '' : ' · ' }}
          }
        </p>
      }
      <app-data-table
        label="Avaliação de fornecedores"
        tableId="proc-evaluations"
        [columns]="columns"
        [rows]="data()?.items ?? []"
        [total]="data()?.items?.length ?? 0"
        [limit]="1000"
        [loading]="loading()"
        emptyText="Sem provas neste período (recepções, facturas ou propostas)."
      >
        <ng-template appCell="supplier" let-row>
          <a
            class="link"
            [routerLink]="['/compras/avaliacao', row.supplier.id]"
            [queryParams]="{ from: from, to: to }"
            >{{ row.supplier.code }} — {{ row.supplier.name }}</a
          >
        </ng-template>
        <ng-template appCell="rating" let-row>
          <span
            class="badge"
            [class]="tone(row.rating)"
            [attr.data-testid]="'ev-rating-' + row.supplier.code"
            >{{ row.rating ?? '—' }}</span
          >
        </ng-template>
      </app-data-table>
    }

    <app-modal title="Pesos da avaliação" [open]="weightsOpen()" (closed)="weightsOpen.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        @for (c of criteria; track c) {
          <app-field
            [label]="label(c) + ' (%)'"
            [hint]="criterionHint(c)"
            [error]="action.field(c)"
          >
            <input
              appControl
              class="input w-24"
              type="number"
              min="0"
              max="100"
              [name]="c"
              [attr.data-testid]="'ev-w-' + c"
              [(ngModel)]="w[c]"
            />
          </app-field>
        }
        <p class="text-sm" [class.text-danger-text]="sum() !== 100" data-testid="ev-w-sum">
          Soma {{ sum() }} (tem de ser 100)
        </p>
        @if (action.field('weights'); as err) {
          <p class="text-sm text-danger-text">{{ err }}</p>
        }
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="weightsOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ev-w-save"
          [disabled]="action.busy()"
          (click)="saveWeights()"
        >
          Guardar
        </button>
      </div>
    </app-modal>
  `,
})
export class SupplierEvaluations {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<Ranking | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly weightsOpen = signal(false);
  protected readonly action = new Action();
  protected readonly canWeights = computed(() => this.workspace.can('procurement.settings'));
  protected readonly criteria = CRITERIA;
  protected readonly ratings: Rating[] = ['A', 'B', 'C', 'D'];
  protected readonly tone = ratingTone;
  protected readonly hint = (r: Rating) => RATING_HINT[r];
  protected readonly label = (c: Criterion) => CRITERION[c];
  protected readonly criterionHint = (c: Criterion) => CRITERION_HINT[c];
  protected from = defaultPeriod().from;
  protected to = defaultPeriod().to;
  protected w: Weights = { quality: 30, delivery: 30, compliance: 20, cost: 20 };
  protected readonly sum = () => weightsSum(this.w);
  protected readonly columns: Column<Row>[] = [
    {
      key: 'supplier',
      label: 'Fornecedor',
      required: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    ...CRITERIA.map((c): Column<Row> => ({
      key: c,
      label: CRITERION[c],
      align: 'end',
      hideOnMobile: true,
      value: (r) =>
        r.indicators[c].evidence
          ? `${scoreLabel(r.indicators[c].score)} (${r.indicators[c].evidence})`
          : '—',
    })),
    { key: 'score', label: 'Nota', align: 'end', value: (r) => scoreLabel(r.score) },
    { key: 'rating', label: 'Classe', value: (r) => r.rating ?? '—' },
    {
      key: 'latest',
      label: 'Publicada',
      hiddenByDefault: true,
      value: (r) => (r.latest ? `${r.latest.rating ?? '—'} até ${r.latest.periodTo}` : '—'),
    },
  ];

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loadError.set(null);
    this.loading.set(true);
    try {
      this.data.set(
        await this.api.get<Ranking>('procurement/evaluations/ranking', {
          from: this.from,
          to: this.to,
        }),
      );
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected async openWeights() {
    this.action.error.set(null);
    this.w = { ...(await this.api.get<Weights>('procurement/evaluations/weights')) };
    this.weightsOpen.set(true);
  }

  protected async saveWeights() {
    const body = Object.fromEntries(CRITERIA.map((c) => [c, Number(this.w[c])]));
    const r = await this.action.run(() =>
      this.api.put<Weights>('procurement/evaluations/weights', body),
    );
    if (!r) return;
    this.weightsOpen.set(false);
    this.toasts.show('Pesos guardados.');
    await this.load();
  }
}
