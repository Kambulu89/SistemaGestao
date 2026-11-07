import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmService } from '../ui/confirm';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import { downloadXlsx, type XlsxCell } from '../ui/xlsx';
import {
  type FiscalYear,
  type Period,
  type StatementNote,
  type StatementResult,
  type StatementTemplate,
  TEMPLATE_STATUS,
} from './model';
import { accountingDeps, legalEntityOptions, moneyText } from './shared';

/**
 * Demonstrações financeiras: escolher o modelo (publicado ou rascunho) e o exercício, ver a demonstração com a
 * conferência com o razão, o detalhe por conta e as notas; exportar para Excel ou imprimir/guardar em PDF.
 */
@Component({
  selector: 'app-statements',
  imports: [FormsModule, PageHeader, ErrorAlert],
  template: `
    <div class="no-print">
      <app-page-header
        title="Demonstrações financeiras"
        subtitle="Calculadas a partir dos lançamentos contabilizados; conferem com o razão e o balancete."
      />
      <form
        class="mb-4 flex flex-wrap items-end gap-2"
        (ngSubmit)="generate()"
        aria-label="Gerar demonstração"
      >
        <div>
          <label class="label" for="st-template">Modelo</label>
          <select id="st-template" name="template" class="input w-72" [(ngModel)]="templateId">
            <option [ngValue]="null">—</option>
            @for (t of templates(); track t.id) {
              <option [ngValue]="t.id">
                {{ t.code }} v{{ t.version }} — {{ t.name }} ({{ statusText(t.status) }})
              </option>
            }
          </select>
        </div>
        <div>
          <label class="label" for="st-year">Exercício</label>
          <select
            id="st-year"
            name="year"
            class="input w-64"
            [(ngModel)]="fiscalYearId"
            (ngModelChange)="yearChanged()"
          >
            <option [ngValue]="null">—</option>
            @for (y of years(); track y.id) {
              <option [ngValue]="y.id">
                {{ y.code }} — {{ names().get(y.legalEntityId) ?? 'entidade' }}
              </option>
            }
          </select>
        </div>
        <div>
          <label class="label" for="st-to">Até</label>
          <select id="st-to" name="to" class="input w-40" [(ngModel)]="toPeriod">
            <option [ngValue]="null">Fim do exercício</option>
            @for (p of periods(); track p.id) {
              <option [ngValue]="p.number">{{ p.name }}</option>
            }
          </select>
        </div>
        <div>
          <label class="label" for="st-compare">Comparar com</label>
          <select id="st-compare" name="compare" class="input w-48" [(ngModel)]="compareId">
            <option [ngValue]="null">—</option>
            @for (y of comparable(); track y.id) {
              <option [ngValue]="y.id">{{ y.code }}</option>
            }
          </select>
        </div>
        <button
          type="submit"
          class="btn-primary"
          [disabled]="action.busy() || !templateId || !fiscalYearId"
        >
          Gerar
        </button>
        @if (result()) {
          <button type="button" class="btn-secondary" (click)="exportXlsx()">Exportar Excel</button>
          <button type="button" class="btn-secondary" (click)="print()">Imprimir / PDF</button>
        }
      </form>
      <app-error-alert [error]="action.error()" [showDetails]="true" />
    </div>

    @if (result(); as r) {
      <article class="card" aria-labelledby="st-title">
        <header class="mb-3">
          <h2 id="st-title" class="text-lg font-semibold">{{ r.template.name }}</h2>
          <p class="text-sm text-muted">
            {{ entityName() }} · exercício {{ r.fiscalYear.code }}{{ periodText() }} · modelo
            {{ r.template.code }} v{{ r.template.version }}
            @if (r.template.status !== 'PUBLISHED') {
              <strong>({{ statusText(r.template.status) }})</strong>
            }
          </p>
          <p class="mt-1 text-sm" role="status" data-testid="st-status">
            @if (r.consistent) {
              <span class="text-success-text"
                >Confere com o razão{{
                  r.check ? ': ' + money(r.check.a) + ' = ' + money(r.check.b) : ''
                }}.</span
              >
            } @else {
              <span class="text-danger-text">
                Não confere:
                @if (r.unmapped.length) {
                  {{ r.unmapped.length }} conta(s) com saldo sem linha no modelo.
                }
                @if (r.check && !r.check.ok) {
                  Controlo {{ money(r.check.a) }} ≠ {{ money(r.check.b) }}.
                }
              </span>
            }
          </p>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[32rem] text-sm">
            <caption class="sr-only">
              {{
                r.template.name
              }}
            </caption>
            <thead>
              <tr class="border-b border-border text-left">
                <th scope="col" class="p-2">Rubrica</th>
                <th scope="col" class="p-2">Nota</th>
                <th scope="col" class="p-2 text-right">{{ r.fiscalYear.code }}</th>
                @if (r.compareFiscalYear) {
                  <th scope="col" class="p-2 text-right">{{ r.compareFiscalYear.code }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (l of r.lines; track l.lineNo) {
                <tr
                  class="border-b border-border"
                  [class.font-semibold]="l.kind === 'HEADER' || l.kind === 'TOTAL'"
                  [class.bg-surface-2]="l.kind === 'HEADER'"
                >
                  <th
                    scope="row"
                    class="p-2 text-left"
                    [class.font-normal]="l.kind === 'ACCOUNTS' || l.kind === 'NET_INCOME'"
                  >
                    @if (l.accounts.length) {
                      <details>
                        <summary class="cursor-pointer">{{ l.label }}</summary>
                        <ul class="mt-1 text-xs text-muted">
                          @for (a of l.accounts; track a.code) {
                            <li class="flex justify-between gap-4">
                              <span>{{ a.code }} {{ a.name }}</span
                              ><span>{{ money(a.amount) }}</span>
                            </li>
                          }
                        </ul>
                      </details>
                    } @else {
                      {{ l.label }}
                    }
                  </th>
                  <td class="p-2">{{ l.noteRef ?? '' }}</td>
                  <td class="p-2 text-right">{{ l.value === null ? '' : money(l.value) }}</td>
                  @if (r.compareFiscalYear) {
                    <td class="p-2 text-right">
                      {{ l.previous === null ? '' : money(l.previous) }}
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (r.unmapped.length) {
          <section class="mt-3 text-sm" aria-labelledby="st-unmapped">
            <h3 id="st-unmapped" class="font-semibold text-danger-text">
              Contas com saldo sem linha no modelo
            </h3>
            <ul data-testid="st-unmapped">
              @for (u of r.unmapped; track u.code + u.name) {
                <li>{{ u.code }} {{ u.name }}: {{ money(u.balance) }}</li>
              }
            </ul>
          </section>
        }
        @if (notes().length) {
          <section class="mt-4" aria-labelledby="st-notes">
            <h3 id="st-notes" class="mb-2 font-semibold">Notas</h3>
            @for (n of notes(); track n.id) {
              <div class="mb-2">
                <h4 class="font-semibold">{{ n.number }}. {{ n.title }}</h4>
                <p class="text-sm whitespace-pre-line">{{ n.body }}</p>
              </div>
            }
          </section>
        }
      </article>
    }

    @if (canWriteNotes() && fiscalYearId) {
      <section class="no-print card mt-4" aria-labelledby="st-note-form">
        <h2 id="st-note-form" class="mb-2 font-semibold">
          {{ editingNote() ? 'Alterar nota ' + editingNote()!.number : 'Nova nota' }}
        </h2>
        @if (notes().length) {
          <ul class="mb-3 divide-y divide-border text-sm">
            @for (n of notes(); track n.id) {
              <li class="flex items-center justify-between gap-2 py-1">
                <span>{{ n.number }}. {{ n.title }}</span>
                <span class="flex gap-1">
                  <button
                    type="button"
                    class="btn-ghost px-2"
                    [attr.aria-label]="'Alterar nota ' + n.number"
                    (click)="editNote(n)"
                  >
                    Alterar
                  </button>
                  <button
                    type="button"
                    class="btn-ghost px-2"
                    [attr.aria-label]="'Apagar nota ' + n.number"
                    (click)="deleteNote(n)"
                  >
                    Apagar
                  </button>
                </span>
              </li>
            }
          </ul>
        }
        <form
          class="grid gap-2 sm:grid-cols-[6rem_1fr]"
          (ngSubmit)="saveNote()"
          aria-label="Nota às demonstrações"
        >
          <div>
            <label class="label" for="nt-number">N.º</label>
            <input
              id="nt-number"
              name="number"
              type="number"
              min="1"
              max="999"
              class="input"
              [(ngModel)]="note.number"
            />
          </div>
          <div>
            <label class="label" for="nt-title">Título</label>
            <input id="nt-title" name="title" class="input" [(ngModel)]="note.title" />
          </div>
          <div class="sm:col-span-2">
            <label class="label" for="nt-body">Texto</label>
            <textarea
              id="nt-body"
              name="body"
              rows="4"
              class="input"
              [(ngModel)]="note.body"
            ></textarea>
          </div>
          <div class="flex gap-2 sm:col-span-2">
            <button type="submit" class="btn-primary" [disabled]="noteAction.busy()">
              Guardar nota
            </button>
            @if (editingNote()) {
              <button type="button" class="btn-secondary" (click)="resetNote()">Nova nota</button>
            }
          </div>
        </form>
        <app-error-alert [error]="noteAction.error()" [showDetails]="true" />
      </section>
    }
  `,
})
export class StatementsPage {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly canWriteNotes = computed(() =>
    this.deps.workspace.can('accounting.statements'),
  );
  protected readonly templates = signal<StatementTemplate[]>([]);
  protected readonly years = signal<FiscalYear[]>([]);
  protected readonly periods = signal<Period[]>([]);
  protected readonly notes = signal<StatementNote[]>([]);
  protected readonly result = signal<StatementResult | null>(null);
  protected readonly editingNote = signal<StatementNote | null>(null);
  private readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly action = new Action();
  protected readonly noteAction = new Action();
  protected templateId: string | null = null;
  protected fiscalYearId: string | null = null;
  protected toPeriod: number | null = null;
  protected compareId: string | null = null;
  protected note = { number: 1 as number | null, title: '', body: '' };
  protected readonly comparable = computed(() => {
    const y = this.years().find((x) => x.id === this.fiscalYearIdSignal());
    return this.years().filter(
      (x) => x.id !== y?.id && (!y || x.legalEntityId === y.legalEntityId),
    );
  });
  private readonly fiscalYearIdSignal = signal<string | null>(null);

  constructor() {
    this.deps.api.get<StatementTemplate[]>('accounting/statement-templates').then(
      (t) => this.templates.set(t.filter((x) => x.status !== 'RETIRED')),
      () => undefined,
    );
    this.deps.api.page<FiscalYear>('accounting/fiscal-years', { limit: 100 }).then(
      (p) => this.years.set(p.items),
      () => undefined,
    );
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (e) => this.entities.set(e),
      () => undefined,
    );
  }

  protected money(v: string) {
    return moneyText(v);
  }
  protected statusText(s: string) {
    return TEMPLATE_STATUS[s] ?? s;
  }
  protected entityName() {
    const y = this.years().find((x) => x.id === this.result()?.fiscalYear.id);
    return y ? (this.names().get(y.legalEntityId) ?? '') : '';
  }
  protected periodText() {
    const r = this.result();
    const p = this.periods().find((x) => x.number === r?.fiscalYear.toPeriod);
    return this.toPeriod !== null && p ? ` até ${p.name}` : '';
  }

  protected async yearChanged() {
    this.fiscalYearIdSignal.set(this.fiscalYearId);
    this.result.set(null);
    this.toPeriod = null;
    this.compareId = null;
    this.resetNote();
    if (!this.fiscalYearId) {
      this.periods.set([]);
      this.notes.set([]);
      return;
    }
    const [y] = await Promise.all([
      this.deps.api.get<FiscalYear>(`accounting/fiscal-years/${this.fiscalYearId}`),
      this.loadNotes(),
    ]);
    this.periods.set(y.periods ?? []);
  }

  private async loadNotes() {
    if (!this.fiscalYearId || !this.deps.workspace.can('accounting.reports')) return;
    this.notes.set(
      await this.deps.api.get<StatementNote[]>('accounting/statement-notes', {
        fiscalYearId: this.fiscalYearId,
      }),
    );
  }

  protected async generate() {
    const r = await this.action.run(() =>
      this.deps.api.get<StatementResult>('accounting/statements', {
        templateId: this.templateId,
        fiscalYearId: this.fiscalYearId,
        toPeriod: this.toPeriod ?? undefined,
        compareFiscalYearId: this.compareId ?? undefined,
      }),
    );
    this.result.set(r ?? null);
    if (r) this.notes.set(r.notes);
  }

  protected exportXlsx() {
    const r = this.result()!;
    const num = (v: string | null): XlsxCell => ({ value: v, kind: 'number' });
    const rows: XlsxCell[][] = [
      [{ value: r.template.name, bold: true }],
      [{ value: `${this.entityName()} · exercício ${r.fiscalYear.code}${this.periodText()}` }],
      [],
      [
        { value: 'Rubrica', bold: true },
        { value: 'Nota', bold: true },
        { value: r.fiscalYear.code, bold: true },
        ...(r.compareFiscalYear ? [{ value: r.compareFiscalYear.code, bold: true }] : []),
      ],
      ...r.lines.map((l) => {
        const bold = l.kind === 'HEADER' || l.kind === 'TOTAL';
        return [
          { value: l.label, bold },
          { value: l.noteRef },
          { ...num(l.value), bold },
          ...(r.compareFiscalYear ? [{ ...num(l.previous), bold }] : []),
        ];
      }),
    ];
    if (!r.consistent)
      rows.push([], [{ value: 'Atenção: a demonstração não confere com o razão.', bold: true }]);
    downloadXlsx(
      `${r.template.code}-${r.fiscalYear.code}.xlsx`,
      `${r.template.code} ${r.fiscalYear.code}`,
      rows,
    );
  }

  protected print() {
    window.print();
  }

  protected editNote(n: StatementNote) {
    this.editingNote.set(n);
    this.note = { number: n.number, title: n.title, body: n.body };
  }

  protected resetNote() {
    this.editingNote.set(null);
    this.note = {
      number: (this.notes().reduce((m, n) => Math.max(m, n.number), 0) || 0) + 1,
      title: '',
      body: '',
    };
  }

  protected async saveNote() {
    const n = this.editingNote();
    const body = { ...this.note, number: Number(this.note.number) };
    const r = await this.noteAction.run(() =>
      n
        ? this.deps.api.patch<StatementNote>(`accounting/statement-notes/${n.id}`, {
            ...body,
            expectedVersion: n.version,
          })
        : this.deps.api.post<StatementNote>('accounting/statement-notes', {
            ...body,
            fiscalYearId: this.fiscalYearId,
          }),
    );
    if (!r) return;
    this.toasts.show('Nota guardada.');
    await this.loadNotes();
    this.resetNote();
    if (this.result()) await this.generate();
  }

  protected async deleteNote(n: StatementNote) {
    const ok = await this.confirm.ask({
      title: 'Apagar nota',
      message: `Apagar a nota ${n.number} (${n.title})?`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!ok) return;
    const done = await this.noteAction.run(async () => {
      await this.deps.api.delete(`accounting/statement-notes/${n.id}`);
      return true;
    });
    if (!done) return;
    this.toasts.show('Nota apagada.');
    await this.loadNotes();
    if (this.result()) await this.generate();
  }
}
