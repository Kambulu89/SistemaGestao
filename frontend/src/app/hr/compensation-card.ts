import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { ToastService } from '../ui/toasts';
import {
  type CompensationSummary,
  incidenceLabel,
  linesPayload,
  type PayComponent,
  PAY_CALCULATION,
  PROPOSAL_STATUS,
  type Proposal,
  type ProposalStatus,
  proposalTone,
} from './compensation-model';

interface DraftLine {
  componentId: string | null;
  action: 'SET' | 'REMOVE';
  value: string;
}

/**
 * Compensação na ficha do colaborador: salário base do contrato e componentes em vigor numa data (com incidência de
 * IRT/INSS), histórico com vigência e propostas. Só aparece a quem a API deixa ver remunerações.
 */
@Component({
  selector: 'app-compensation-card',
  imports: [FormsModule, RouterLink, FormField, FieldControl, Modal, ErrorAlert, Icon],
  template: `
    @if (data(); as d) {
      <section class="card" aria-labelledby="comp-title" data-testid="compensation">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="comp-title" class="font-semibold">Compensação</h2>
          <div class="flex flex-wrap items-center gap-2">
            <label class="sr-only" for="comp-date">Data</label>
            <input
              id="comp-date"
              class="input w-40"
              type="date"
              data-testid="comp-date"
              [ngModel]="date()"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="setDate($event)"
            />
            @if (d.access.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="new-proposal"
                (click)="open()"
              >
                <app-icon name="plus" [size]="16" />Nova proposta
              </button>
            }
          </div>
        </div>
        @if (d.at; as at) {
          <table class="w-full text-sm" data-testid="comp-lines">
            <caption class="sr-only">
              Remuneração em
              {{
                fmtDate(at.date)
              }}
            </caption>
            <thead>
              <tr class="text-left text-muted">
                <th scope="col" class="py-1 font-medium">Componente</th>
                <th scope="col" class="py-1 font-medium">Incidência</th>
                <th scope="col" class="py-1 text-right font-medium">Valor ({{ at.currency }})</th>
              </tr>
            </thead>
            <tbody>
              <tr class="border-t border-border">
                <td class="py-1">Salário base (contrato)</td>
                <td class="py-1 text-muted">—</td>
                <td class="py-1 text-right tabular-nums">{{ money(at.baseSalary) }}</td>
              </tr>
              @for (l of at.lines; track l.componentId) {
                <tr class="border-t border-border">
                  <td class="py-1">
                    {{ l.name }}{{ l.percent ? ' (' + pct(l.percent) + '%)' : '' }}
                  </td>
                  <td
                    class="py-1"
                    [class.text-warning-text]="!l.incidence"
                    [class.text-muted]="!!l.incidence"
                  >
                    {{ incidence(l.incidence) }}
                  </td>
                  <td class="py-1 text-right tabular-nums">
                    {{ l.kind === 'DEDUCTION' ? '−' : '' }}{{ money(l.amount) }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="text-sm text-muted">
            Sem contrato em vigor em {{ fmtDate(date()) }}: a remuneração assenta no contrato.
          </p>
        }

        @if (d.proposals.length) {
          <h3 class="mt-4 mb-2 text-sm font-semibold">Propostas</h3>
          <ul class="space-y-1 text-sm">
            @for (p of d.proposals; track p.id) {
              <li class="flex flex-wrap items-center justify-between gap-2">
                <a class="link" [routerLink]="['/rh/compensacao', p.id]"
                  >Efeito {{ fmtDate(p.effectiveDate) }} · {{ p.reason }}</a
                >
                <span class="badge" [class]="tone(p.status)">{{ status(p.status) }}</span>
              </li>
            }
          </ul>
        }
        @if (d.history.length) {
          <details class="mt-3 text-sm">
            <summary class="cursor-pointer text-link">Histórico com vigência</summary>
            <ul class="mt-2 space-y-1">
              @for (h of d.history; track h.id) {
                <li class="flex justify-between gap-2">
                  <span
                    >{{ h.name }} · {{ fmtDate(h.validFrom)
                    }}{{ h.validTo ? ' – ' + fmtDate(h.validTo) : ' em diante' }}</span
                  >
                  <span class="tabular-nums">{{
                    h.percent ? pct(h.percent) + '%' : money(h.amount!)
                  }}</span>
                </li>
              }
            </ul>
          </details>
        }
      </section>
    }

    <app-modal title="Nova proposta de compensação" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Fica em rascunho. Depois de aprovada, aplica-se a partir da data de efeito sem alterar o
        passado.
      </p>
      <div class="space-y-3">
        <app-field label="Data de efeito" [required]="true" [error]="action.field('effectiveDate')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="cp-date"
            [(ngModel)]="form.effectiveDate"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Motivo" [required]="true" [error]="action.field('reason')">
          <input
            appControl
            class="input"
            data-testid="cp-reason"
            [(ngModel)]="form.reason"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <fieldset class="min-w-0">
          <legend class="mb-2 text-sm font-medium">Componentes</legend>
          @if (action.field('lines')) {
            <p class="field-error">{{ action.field('lines') }}</p>
          }
          <ul class="space-y-2">
            @for (l of form.lines; track $index; let i = $index) {
              <li
                class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_auto]"
                data-testid="cp-line"
              >
                <select
                  class="input"
                  [attr.aria-label]="'Componente ' + (i + 1)"
                  [attr.data-testid]="'cp-component-' + i"
                  [(ngModel)]="l.componentId"
                  [ngModelOptions]="{ standalone: true }"
                >
                  <option [ngValue]="null">—</option>
                  @for (c of components(); track c.id) {
                    <option [ngValue]="c.id">{{ c.name }} ({{ calc(c) }})</option>
                  }
                </select>
                <select
                  class="input"
                  [attr.aria-label]="'Acção ' + (i + 1)"
                  [(ngModel)]="l.action"
                  [ngModelOptions]="{ standalone: true }"
                >
                  <option value="SET">Definir</option>
                  <option value="REMOVE">Remover</option>
                </select>
                <input
                  class="input text-right"
                  inputmode="decimal"
                  [disabled]="l.action === 'REMOVE'"
                  [attr.aria-label]="valueLabel(l) + ' ' + (i + 1)"
                  [attr.data-testid]="'cp-value-' + i"
                  [placeholder]="valueLabel(l)"
                  [(ngModel)]="l.value"
                  [ngModelOptions]="{ standalone: true }"
                />
                <button
                  type="button"
                  class="btn-ghost px-2"
                  [attr.aria-label]="'Remover linha ' + (i + 1)"
                  (click)="form.lines.splice(i, 1)"
                >
                  <app-icon name="close" [size]="16" />
                </button>
                @if (lineError(i)) {
                  <p class="field-error sm:col-span-4">{{ lineError(i) }}</p>
                }
              </li>
            }
          </ul>
          <button
            type="button"
            class="btn-ghost mt-2"
            data-testid="cp-add-line"
            (click)="form.lines.push({ componentId: null, action: 'SET', value: '' })"
          >
            <app-icon name="plus" [size]="16" />Adicionar componente
          </button>
        </fieldset>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="cp-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar rascunho
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class CompensationCard {
  readonly employeeId = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<CompensationSummary | null>(null);
  protected readonly date = signal(new Date().toISOString().slice(0, 10));
  protected readonly components = signal<PayComponent[]>([]);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected form = { effectiveDate: '', reason: '', lines: [] as DraftLine[] };
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly fmtDate = formatDate;
  protected readonly tone = proposalTone;
  protected readonly status = (s: ProposalStatus) => PROPOSAL_STATUS[s];
  protected readonly pct = (p: string) => p.replace(/\.?0+$/, '');
  protected readonly incidence = (i: Parameters<typeof incidenceLabel>[0]) =>
    incidenceLabel(i, (v) => formatMoney(v));
  protected readonly calc = (c: PayComponent) => PAY_CALCULATION[c.calculation];

  constructor() {
    effect(() => {
      const id = this.employeeId();
      const d = this.date();
      untracked(() => void this.load(id, d));
    });
  }

  private async load(id: string, date: string) {
    try {
      this.data.set(
        await this.api.get<CompensationSummary>(`hr/employees/${id}/compensation`, { date }),
      );
    } catch {
      this.data.set(null);
    }
  }

  protected setDate(d: string) {
    if (d) this.date.set(d);
  }

  protected valueLabel(l: DraftLine) {
    const c = this.components().find((x) => x.id === l.componentId);
    return c?.calculation === 'PERCENT_OF_BASE' ? '% do base' : 'Montante';
  }

  protected lineError(i: number) {
    return (
      this.action.field(`lines.${i}.componentId`) ??
      this.action.field(`lines.${i}.amount`) ??
      this.action.field(`lines.${i}.percent`) ??
      this.action.field(`lines.${i}.action`)
    );
  }

  protected async open() {
    this.action.error.set(null);
    try {
      this.components.set(
        (await this.api.get<PayComponent[]>('hr/pay-components')).filter(
          (c) => c.status === 'ACTIVE',
        ),
      );
    } catch {
      this.components.set([]);
    }
    this.form = {
      effectiveDate: '',
      reason: '',
      lines: [{ componentId: null, action: 'SET', value: '' }],
    };
    this.opened.set(true);
  }

  protected async save() {
    const calc = (id: string) => this.components().find((c) => c.id === id)?.calculation;
    const result = await this.action.run(() =>
      this.api.post<Proposal>(`hr/employees/${this.employeeId()}/compensation/proposals`, {
        effectiveDate: this.form.effectiveDate || null,
        reason: this.form.reason,
        lines: linesPayload(this.form.lines, calc),
      }),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Proposta guardada em rascunho.');
    await this.router.navigate(['/rh/compensacao', result.id]);
  }
}
