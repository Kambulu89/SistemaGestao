import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  CRITERIA,
  CRITERION,
  CRITERION_HINT,
  type Criterion,
  defaultPeriod,
  type Published,
  ratingTone,
  scoreLabel,
  SLA_METRIC,
  type SupplierEvaluation,
} from './evaluation-model';

/**
 * Avaliação de um fornecedor num período (9.11): nota e classe, os quatro indicadores com o número de provas, as provas
 * (recepções atrasadas, com recusa ou devolução; facturas com excepção; linhas de cotação em que foi o mais barato),
 * o cumprimento dos SLA dos contratos, publicar (fotografia imutável) e o histórico.
 */
@Component({
  selector: 'app-supplier-evaluation',
  imports: [FormsModule, RouterLink, EntityFormPage, FormField, FieldControl, Modal, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="'Avaliação ' + (x()?.supplier?.code ?? '')"
      [subtitle]="x() ? x()!.supplier.name : ''"
      formId="supplier-evaluation"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as e) {
        <section class="card space-y-3" aria-label="Nota" data-testid="se-state">
          <div class="flex flex-wrap items-end gap-3">
            <label class="block">
              <span class="label">De</span>
              <input
                class="input w-44"
                type="date"
                name="from"
                data-testid="se-from"
                [(ngModel)]="periodFrom"
              />
            </label>
            <label class="block">
              <span class="label">Até</span>
              <input
                class="input w-44"
                type="date"
                name="to"
                data-testid="se-to"
                [(ngModel)]="periodTo"
              />
            </label>
            <button type="button" class="btn-secondary" (click)="load()">Calcular</button>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <span class="badge text-base" [class]="tone(e.rating)" data-testid="se-rating">{{
              e.rating ? 'Classe ' + e.rating : 'Sem nota'
            }}</span>
            <span class="text-2xl font-semibold tabular-nums" data-testid="se-score">{{
              score(e.score)
            }}</span>
            <a class="link text-sm" [routerLink]="['/compras/fornecedores', e.supplier.id]"
              >Ficha do fornecedor</a
            >
          </div>
          @if (!e.scopeAll) {
            <p class="text-xs text-muted">Só com as provas das entidades do seu âmbito.</p>
          }
          @if (!dialog() && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="true" data-testid="se-error" />
          }
          @if (e.can.publish) {
            <button
              type="button"
              class="btn-primary"
              data-testid="se-publish"
              (click)="openPublish()"
            >
              Publicar avaliação
            </button>
          }
        </section>

        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Indicadores">
          @for (c of criteria; track c) {
            <div class="card" [attr.data-testid]="'se-ind-' + c">
              <p class="text-sm text-muted">{{ label(c) }} · peso {{ e.weights[c] }}%</p>
              <p class="text-xl font-semibold tabular-nums">{{ score(e.indicators[c].score) }}</p>
              <p class="text-xs text-muted">
                {{ e.indicators[c].evidence }} prova(s) · {{ hint(c) }}
              </p>
            </div>
          }
        </section>

        <section class="card" aria-labelledby="se-rc-title">
          <h2 id="se-rc-title" class="mb-2 font-semibold">Recepções</h2>
          <ul class="space-y-1 text-sm" data-testid="se-receipts">
            @for (r of e.evidence.receipts; track r.id) {
              <li>
                <a class="link" [routerLink]="['/compras/recepcoes', r.id]">{{ r.number }}</a>
                · ordem {{ r.order.number }} · {{ date(r.receivedOn) }}
                @if (r.expectedOn) {
                  · prevista {{ date(r.expectedOn) }}
                }
                @if (r.late) {
                  <span class="badge bg-danger-soft text-danger-text">Atrasada</span>
                }
                @if (r.rejectedLines) {
                  <span class="badge bg-warning-soft text-warning-text">Com recusa</span>
                }
                @if (r.returnedLines) {
                  <span class="badge bg-warning-soft text-warning-text">Com devolução</span>
                }
              </li>
            } @empty {
              <li class="text-muted">Sem recepções no período.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="se-inv-title">
          <h2 id="se-inv-title" class="mb-2 font-semibold">Facturas</h2>
          <ul class="space-y-1 text-sm" data-testid="se-invoices">
            @for (i of e.evidence.invoices; track i.id) {
              <li>
                <a class="link" [routerLink]="['/compras/facturas', i.id]">{{
                  i.number ?? i.invoiceNumber
                }}</a>
                · {{ i.invoiceNumber }} · {{ date(i.date) }}
                @if (i.status === 'REJECTED') {
                  <span class="badge bg-danger-soft text-danger-text">Devolvida</span>
                } @else if (i.excepted) {
                  <span class="badge bg-warning-soft text-warning-text">Com excepção</span>
                } @else {
                  <span class="badge bg-success-soft text-success-text">Conforme</span>
                }
              </li>
            } @empty {
              <li class="text-muted">Sem facturas no período.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="se-rfq-title">
          <h2 id="se-rfq-title" class="mb-2 font-semibold">Cotações</h2>
          <ul class="space-y-1 text-sm" data-testid="se-rfqs">
            @for (q of e.evidence.rfqs; track q.id) {
              <li>
                <a class="link" [routerLink]="['/compras/cotacoes', q.id]">{{ q.number }}</a>
                · {{ q.lines }} linha(s) · o mais barato em {{ q.cheapest }}
              </li>
            } @empty {
              <li class="text-muted">Sem propostas em cotações abertas no período.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="se-sla-title">
          <h2 id="se-sla-title" class="mb-2 font-semibold">SLA dos contratos</h2>
          <ul class="space-y-1 text-sm" data-testid="se-sla">
            @for (s of e.sla; track s.contract.id + s.metric + $index) {
              <li>
                <a class="link" [routerLink]="['/compras/contratos', s.contract.id]">{{
                  s.contract.number
                }}</a>
                · {{ metric(s.metric) }} · alvo {{ s.target }} · medido {{ s.actual ?? '—' }}
                @if (s.met === true) {
                  <span class="badge bg-success-soft text-success-text">Cumprido</span>
                } @else if (s.met === false) {
                  <span class="badge bg-danger-soft text-danger-text">Falhado</span>
                } @else {
                  <span class="badge bg-surface-2 text-muted">Sem medição</span>
                }
              </li>
            } @empty {
              <li class="text-muted">Sem SLA em contratos deste fornecedor.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="se-hist-title">
          <h2 id="se-hist-title" class="mb-2 font-semibold">Avaliações publicadas</h2>
          <ul class="space-y-2 text-sm" data-testid="se-history">
            @for (h of e.history; track h.id) {
              <li [class.text-muted]="h.superseded">
                <span class="badge" [class]="tone(h.rating)">{{ h.rating ?? '—' }}</span>
                {{ score(h.score) }} · {{ date(h.periodFrom) }} a {{ date(h.periodTo) }} ·
                {{ h.publishedBy ?? '—' }} em {{ when(h.publishedAt) }}
                @if (h.superseded) {
                  · substituída
                }
                @if (h.comment) {
                  <span class="block text-xs">{{ h.comment }}</span>
                }
              </li>
            } @empty {
              <li class="text-muted">Ainda não publicada.</li>
            }
          </ul>
        </section>
      }
    </app-entity-form-page>

    <app-modal title="Publicar avaliação" [open]="dialog()" (closed)="dialog.set(false)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Recalcula com as provas de todas as entidades de {{ date(periodFrom) }} a
        {{ date(periodTo) }} e guarda a fotografia (não se altera; uma nova do mesmo período
        substitui-a no histórico).
      </p>
      <app-field label="Comentário" [error]="act.field('comment')">
        <textarea
          appControl
          class="input min-h-16"
          name="comment"
          data-testid="se-comment"
          [(ngModel)]="comment"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="se-publish-ok"
          [disabled]="act.busy()"
          (click)="publish()"
        >
          Publicar
        </button>
      </div>
    </app-modal>
  `,
})
export class SupplierEvaluationDetail {
  readonly id = input<string | null>(null);
  /** Período vindo da URL (`?from=&to=`). */
  readonly from = input<string | null>(null);
  readonly to = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<SupplierEvaluation | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal(false);
  protected readonly act = new Action();
  protected readonly criteria = CRITERIA;
  protected readonly tone = ratingTone;
  protected readonly score = scoreLabel;
  protected readonly date = formatDate;
  protected readonly when = formatDateTime;
  protected readonly label = (c: Criterion) => CRITERION[c];
  protected readonly hint = (c: Criterion) => CRITERION_HINT[c];
  protected readonly metric = (m: string) => SLA_METRIC[m] ?? m;
  protected periodFrom = defaultPeriod().from;
  protected periodTo = defaultPeriod().to;
  protected comment = '';

  constructor() {
    effect(() => {
      this.id();
      const f = this.from();
      const t = this.to();
      untracked(() => {
        if (f) this.periodFrom = f;
        if (t) this.periodTo = t;
        void this.load();
      });
    });
  }

  protected async load() {
    this.loadError.set(null);
    this.act.error.set(null);
    try {
      const e = await this.api.get<SupplierEvaluation>(
        `procurement/evaluations/suppliers/${this.id()}`,
        {
          from: this.periodFrom,
          to: this.periodTo,
        },
      );
      this.x.set(e);
      this.breadcrumbs.setCurrent(e.supplier.code);
    } catch (err) {
      const e = ApiError.from(err);
      if (this.x()) this.act.error.set(e);
      else this.loadError.set(e);
    }
  }

  protected back() {
    void this.router.navigate(['/compras/avaliacao'], {
      queryParams: { from: this.periodFrom, to: this.periodTo },
    });
  }

  protected openPublish() {
    this.act.error.set(null);
    this.comment = '';
    this.dialog.set(true);
  }

  protected async publish() {
    const res = await this.act.run(() =>
      this.api.post<Published>(`procurement/evaluations/suppliers/${this.id()}`, {
        from: this.periodFrom,
        to: this.periodTo,
        comment: this.comment.trim() || null,
      }),
    );
    if (!res) return;
    this.dialog.set(false);
    this.toasts.show(`Avaliação publicada: classe ${res.rating ?? '—'}.`);
    await this.load();
  }
}
