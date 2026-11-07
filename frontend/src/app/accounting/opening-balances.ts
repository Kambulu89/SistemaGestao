import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import {
  type Entry,
  type FiscalYear,
  type Journal,
  type OpeningLine,
  parseOpeningCsv,
} from './model';
import { accountingDeps, legalEntityOptions } from './shared';

interface Validation {
  issues: { path: string; code: string; message: string }[];
  debit: string;
  credit: string;
  existingEntryId: string | null;
}

/**
 * Importação de saldos de abertura: colar (ou carregar) as linhas de uma folha de cálculo, validar no servidor e criar
 * o lançamento em rascunho no período de abertura do exercício (segue depois o fluxo normal de aprovação).
 */
@Component({
  selector: 'app-opening-balances',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, FormSection, FormField, FieldControl],
  template: `
    <app-page-header
      title="Saldos de abertura"
      subtitle="Uma importação por exercício, por código de conta. Gera um rascunho no período de abertura."
    />
    <form class="space-y-4" (ngSubmit)="validate()" aria-label="Importar saldos de abertura">
      <app-form-section title="Destino">
        <app-field label="Exercício" [required]="true" [error]="action.field('fiscalYearId')">
          <select
            appControl
            class="input"
            name="year"
            [(ngModel)]="fiscalYearId"
            (ngModelChange)="yearChanged()"
          >
            <option [ngValue]="null">—</option>
            @for (y of years(); track y.id) {
              <option [ngValue]="y.id">{{ yearLabel(y) }}</option>
            }
          </select>
        </app-field>
        <app-field label="Diário" [required]="true" [error]="action.field('journalId')">
          <select appControl class="input" name="journal" [(ngModel)]="journalId">
            <option [ngValue]="null">—</option>
            @for (j of journals(); track j.id) {
              <option [ngValue]="j.id">{{ j.code }} — {{ j.name }}</option>
            }
          </select>
        </app-field>
      </app-form-section>
      <app-form-section
        title="Linhas"
        description="Colunas: conta; débito; crédito; centro de custo; terceiro; descrição (cabeçalho opcional). Separador ; ou tab; vírgula decimal aceite."
      >
        <app-field label="Ficheiro CSV" class="md:col-span-2">
          <input
            appControl
            type="file"
            accept=".csv,.txt"
            class="input"
            name="file"
            (change)="load($event)"
          />
        </app-field>
        <app-field label="Ou cole aqui" class="md:col-span-2">
          <textarea
            appControl
            class="input font-mono"
            rows="8"
            name="csv"
            [(ngModel)]="csv"
            (ngModelChange)="parsed.set(parse($event))"
          ></textarea>
        </app-field>
        <p class="text-sm text-muted md:col-span-2" role="status">
          {{ parsed().length }} linha(s) lidas.
        </p>
      </app-form-section>
      <app-error-alert [error]="action.error()" [showDetails]="true" />
      <div class="flex flex-wrap gap-2">
        <button type="submit" class="btn-secondary" [disabled]="action.busy() || !ready()">
          Validar
        </button>
        @if (canImport()) {
          <button
            type="button"
            class="btn-primary"
            [disabled]="action.busy() || !ready() || !valid()"
            (click)="import()"
          >
            Importar
          </button>
        }
      </div>
    </form>

    @if (result(); as r) {
      <section class="card mt-4 text-sm" aria-labelledby="val-title" data-testid="validation">
        <h2 id="val-title" class="font-semibold">Validação</h2>
        <p class="mt-1">Devedores {{ money(r.debit) }} · Credores {{ money(r.credit) }}</p>
        @if (r.issues.length === 0) {
          <p class="mt-2 text-success-text">Sem problemas: pode importar.</p>
        } @else {
          <ul class="mt-2 list-disc pl-5 text-danger-text">
            @for (i of r.issues; track $index) {
              <li>{{ i.message }}</li>
            }
          </ul>
          @if (r.existingEntryId) {
            <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', r.existingEntryId]"
              >Ver importação existente</a
            >
          }
        }
      </section>
    }
    @if (created(); as e) {
      <p class="mt-4 text-sm" role="status" data-testid="created">
        Rascunho criado no período de abertura —
        <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', e.id]">abrir lançamento</a>
        para submeter.
      </p>
    }
  `,
})
export class OpeningBalances {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly canImport = computed(() => this.deps.workspace.can('accounting.create'));
  protected readonly years = signal<FiscalYear[]>([]);
  private readonly entityNames = signal<Map<string, string>>(new Map());
  /** Exercício identificado pela entidade (há um "2026" por entidade legal). */
  protected yearLabel(y: FiscalYear) {
    return `${y.code} — ${this.entityNames().get(y.legalEntityId) ?? 'entidade'}`;
  }
  protected readonly journals = signal<Journal[]>([]);
  protected readonly parsed = signal<OpeningLine[]>([]);
  protected readonly result = signal<Validation | null>(null);
  protected readonly created = signal<Entry | null>(null);
  protected readonly action = new Action();
  protected fiscalYearId: string | null = null;
  protected journalId: string | null = null;
  protected csv = '';
  protected readonly parse = parseOpeningCsv;
  protected readonly valid = computed(() => this.result()?.issues.length === 0);

  constructor() {
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (list) => this.entityNames.set(new Map(list.map((e) => [e.id, e.label]))),
      () => undefined,
    );
    this.deps.api.page<FiscalYear>('accounting/fiscal-years', { status: 'OPEN', limit: 100 }).then(
      (p) => this.years.set(p.items),
      () => undefined,
    );
  }

  protected ready() {
    return !!this.fiscalYearId && !!this.journalId && this.parsed().length > 0;
  }

  protected money(v: string) {
    return formatMoney(v, v.includes('.') ? v.split('.')[1].length : 0);
  }

  protected async yearChanged() {
    this.journalId = null;
    this.result.set(null);
    const year = this.years().find((y) => y.id === this.fiscalYearId);
    this.journals.set(
      year
        ? (
            await this.deps.api.page<Journal>('accounting/journals', {
              legalEntityId: year.legalEntityId,
              status: 'ACTIVE',
              limit: 200,
            })
          ).items
        : [],
    );
    const opening = this.journals().find((j) => j.type === 'OPENING');
    if (opening) this.journalId = opening.id;
  }

  protected async load(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.csv = await file.text();
    this.parsed.set(parseOpeningCsv(this.csv));
    this.result.set(null);
  }

  private body() {
    return { fiscalYearId: this.fiscalYearId, journalId: this.journalId, lines: this.parsed() };
  }

  protected async validate() {
    this.created.set(null);
    const r = await this.action.run(() =>
      this.deps.api.post<Validation>('accounting/opening-balances/validate', this.body()),
    );
    this.result.set(r ?? null);
  }

  protected async import() {
    const entry = await this.action.run(() =>
      this.deps.api.post<Entry>('accounting/opening-balances', this.body()),
    );
    if (!entry) return;
    this.result.set(null);
    this.created.set(entry);
    this.toasts.show('Saldos importados em rascunho.');
  }
}
