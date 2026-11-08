import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action, Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type Chart,
  formatMappings,
  parseMappings,
  STATEMENT_KIND_LABELS,
  STATEMENT_LINE_LABELS,
  type StatementKind,
  type StatementLineKind,
  type StatementTemplate,
  TEMPLATE_STATUS,
} from './model';
import { accountingDeps } from './shared';

interface LineDraft {
  kind: StatementLineKind;
  code: string;
  label: string;
  sign: 1 | -1;
  formula: string;
  noteRef: string;
  mappings: string;
}

const blankLine = (kind: StatementLineKind = 'ACCOUNTS'): LineDraft => ({
  kind,
  code: '',
  label: '',
  sign: 1,
  formula: '',
  noteRef: '',
  mappings: '',
});

/**
 * Modelos de demonstrações financeiras, versionados por plano de contas: linhas (títulos, contas por prefixo, totais
 * por fórmula, resultado líquido) e linhas de controlo. Publicado não muda: altera-se numa nova versão.
 */
@Component({
  selector: 'app-statement-templates',
  imports: [
    FormsModule,
    EntityListPage,
    DataTable,
    CellDef,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-entity-list-page
      title="Modelos de demonstrações"
      subtitle="Balanço e demonstração de resultados por plano de contas, com versões. Nenhum modelo vem pré-definido: confirme o PGC em vigor."
      permission="accounting.read"
      feature="accounting"
    >
      <app-data-table
        tableId="acc-statement-templates"
        label="Modelos de demonstrações"
        [columns]="columns"
        [rows]="templates.value() ?? []"
        [total]="templates.value()?.length ?? 0"
        [loading]="templates.loading()"
        [error]="templates.error()"
        emptyText="Ainda não há modelos."
        (retry)="templates.load()"
      >
        <ng-template appCell="code" let-row>
          <button type="button" class="btn-link" (click)="edit(row)">{{ row.code }}</button>
        </ng-template>
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ statusText(row.status) }}</span>
        </ng-template>
      </app-data-table>

      @if (canManage() || current()) {
        <form
          class="mt-4 space-y-3"
          (ngSubmit)="save()"
          [attr.aria-label]="current() ? 'Modelo ' + current()!.code : 'Novo modelo'"
        >
          <app-error-alert [error]="action.error()" [showDetails]="true" />
          <app-form-section
            [title]="
              current()
                ? current()!.code +
                  ' v' +
                  current()!.version +
                  ' (' +
                  statusText(current()!.status) +
                  ')'
                : 'Novo modelo'
            "
          >
            <app-field label="Plano de contas" [required]="true" [error]="action.field('chartId')">
              <select
                appControl
                class="input"
                name="chart"
                [disabled]="!!current()"
                [(ngModel)]="form.chartId"
              >
                <option [ngValue]="null">—</option>
                @for (c of charts(); track c.id) {
                  <option [ngValue]="c.id">{{ c.code }} — {{ c.name }}</option>
                }
              </select>
            </app-field>
            <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
              <select
                appControl
                class="input"
                name="kind"
                [disabled]="!!current()"
                [(ngModel)]="form.kind"
              >
                @for (k of kinds; track k[0]) {
                  <option [value]="k[0]">{{ k[1] }}</option>
                }
              </select>
            </app-field>
            <app-field label="Código" [required]="true" [error]="action.field('code')">
              <input
                appControl
                class="input"
                name="code"
                [disabled]="!!current()"
                [(ngModel)]="form.code"
              />
            </app-field>
            <app-field label="Nome" [required]="true" [error]="action.field('name')">
              <input
                appControl
                class="input"
                name="name"
                [disabled]="readOnly()"
                [(ngModel)]="form.name"
              />
            </app-field>
            <app-field
              [label]="
                form.kind === 'BALANCE_SHEET'
                  ? 'Controlo: linha do activo'
                  : 'Controlo: linha do resultado'
              "
              [hint]="
                form.kind === 'BALANCE_SHEET'
                  ? 'Tem de igualar a linha seguinte.'
                  : 'Tem de igualar o resultado do razão.'
              "
              [error]="action.field('checkA')"
            >
              <input
                appControl
                class="input"
                name="checkA"
                [disabled]="readOnly()"
                [(ngModel)]="form.checkA"
              />
            </app-field>
            @if (form.kind === 'BALANCE_SHEET') {
              <app-field
                label="Controlo: linha do capital próprio e passivo"
                [error]="action.field('checkB')"
              >
                <input
                  appControl
                  class="input"
                  name="checkB"
                  [disabled]="readOnly()"
                  [(ngModel)]="form.checkB"
                />
              </app-field>
            }
          </app-form-section>

          <fieldset class="card min-w-0 space-y-2 overflow-x-auto">
            <legend class="font-semibold">Linhas</legend>
            <p class="text-sm text-muted">
              Contas: prefixos de código separados por vírgulas; <code>:D</code> só saldo devedor,
              <code>:C</code> só credor (p. ex. <code>111, 113:D</code>). Cada conta vai para o
              prefixo mais longo. Sinal −1 apresenta saldos credores como positivos. Totais: códigos
              somados ou subtraídos (<code>A1+A2-A3</code>).
            </p>
            @if (action.field('lines')) {
              <p class="field-error" role="alert">{{ action.field('lines') }}</p>
            }
            <table class="w-full min-w-[60rem] text-sm">
              <thead>
                <tr class="text-left">
                  <th scope="col" class="p-1">Tipo</th>
                  <th scope="col" class="p-1">Código</th>
                  <th scope="col" class="p-1">Texto</th>
                  <th scope="col" class="p-1">Sinal</th>
                  <th scope="col" class="p-1">Prefixos / fórmula</th>
                  <th scope="col" class="p-1">Nota</th>
                  <th scope="col" class="p-1"><span class="sr-only">Acções</span></th>
                </tr>
              </thead>
              <tbody>
                @for (l of lines; track $index; let i = $index) {
                  <tr>
                    <td class="p-1">
                      <select
                        class="input"
                        [attr.aria-label]="'Tipo da linha ' + (i + 1)"
                        [name]="'k' + i"
                        [disabled]="readOnly()"
                        [(ngModel)]="l.kind"
                      >
                        @for (k of lineKinds; track k[0]) {
                          <option [value]="k[0]">{{ k[1] }}</option>
                        }
                      </select>
                    </td>
                    <td class="p-1">
                      <input
                        class="input w-20"
                        [attr.aria-label]="'Código da linha ' + (i + 1)"
                        [name]="'c' + i"
                        [disabled]="readOnly() || l.kind === 'HEADER'"
                        [(ngModel)]="l.code"
                      />
                    </td>
                    <td class="p-1">
                      <input
                        class="input"
                        [attr.aria-label]="'Texto da linha ' + (i + 1)"
                        [name]="'l' + i"
                        [disabled]="readOnly()"
                        [(ngModel)]="l.label"
                      />
                    </td>
                    <td class="p-1">
                      <select
                        class="input w-20"
                        [attr.aria-label]="'Sinal da linha ' + (i + 1)"
                        [name]="'s' + i"
                        [disabled]="readOnly() || l.kind === 'HEADER' || l.kind === 'TOTAL'"
                        [(ngModel)]="l.sign"
                      >
                        <option [ngValue]="1">+1</option>
                        <option [ngValue]="-1">−1</option>
                      </select>
                    </td>
                    <td class="p-1">
                      @if (l.kind === 'ACCOUNTS') {
                        <input
                          class="input"
                          [attr.aria-label]="'Prefixos da linha ' + (i + 1)"
                          [name]="'m' + i"
                          [disabled]="readOnly()"
                          [(ngModel)]="l.mappings"
                        />
                      } @else if (l.kind === 'TOTAL') {
                        <input
                          class="input"
                          [attr.aria-label]="'Fórmula da linha ' + (i + 1)"
                          [name]="'f' + i"
                          [disabled]="readOnly()"
                          [(ngModel)]="l.formula"
                        />
                      }
                    </td>
                    <td class="p-1">
                      <input
                        class="input w-16"
                        [attr.aria-label]="'Nota da linha ' + (i + 1)"
                        [name]="'n' + i"
                        [disabled]="readOnly()"
                        [(ngModel)]="l.noteRef"
                      />
                    </td>
                    <td class="p-1 whitespace-nowrap">
                      @if (!readOnly()) {
                        <button
                          type="button"
                          class="btn-ghost px-2"
                          [attr.aria-label]="'Subir linha ' + (i + 1)"
                          [disabled]="i === 0"
                          (click)="move(i, -1)"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          class="btn-ghost px-2"
                          [attr.aria-label]="'Descer linha ' + (i + 1)"
                          [disabled]="i === lines.length - 1"
                          (click)="move(i, 1)"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          class="btn-ghost px-2"
                          [attr.aria-label]="'Remover linha ' + (i + 1)"
                          (click)="lines.splice(i, 1)"
                        >
                          ✕
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            @if (!readOnly()) {
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="btn-secondary"
                  (click)="lines.push(blankLine('HEADER'))"
                >
                  Acrescentar título
                </button>
                <button
                  type="button"
                  class="btn-secondary"
                  (click)="lines.push(blankLine('ACCOUNTS'))"
                >
                  Acrescentar linha de contas
                </button>
                <button
                  type="button"
                  class="btn-secondary"
                  (click)="lines.push(blankLine('TOTAL'))"
                >
                  Acrescentar total
                </button>
              </div>
            }
          </fieldset>

          @if (canManage()) {
            <div class="flex flex-wrap gap-2">
              @if (!readOnly()) {
                <button type="submit" class="btn-primary" [disabled]="action.busy()">
                  {{ current() ? 'Guardar rascunho' : 'Criar modelo' }}
                </button>
              }
              @if (current()?.status === 'DRAFT') {
                <button
                  type="button"
                  class="btn-secondary"
                  [disabled]="action.busy()"
                  (click)="publish()"
                >
                  Publicar
                </button>
                <button
                  type="button"
                  class="btn-danger"
                  [disabled]="action.busy()"
                  (click)="remove()"
                >
                  Apagar rascunho
                </button>
              }
              @if (current() && current()!.status !== 'DRAFT') {
                <button
                  type="button"
                  class="btn-secondary"
                  [disabled]="action.busy()"
                  (click)="newVersion()"
                >
                  Nova versão
                </button>
              }
              @if (current()) {
                <button type="button" class="btn-secondary" (click)="reset()">Novo modelo</button>
              }
            </div>
          }
        </form>
      }
    </app-entity-list-page>
  `,
})
export class StatementTemplates {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly blankLine = blankLine;
  protected readonly kinds = Object.entries(STATEMENT_KIND_LABELS);
  protected readonly lineKinds = Object.entries(STATEMENT_LINE_LABELS);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly charts = signal<Chart[]>([]);
  protected readonly current = signal<StatementTemplate | null>(null);
  protected readonly readOnly = computed(
    () => !this.canManage() || (!!this.current() && this.current()!.status !== 'DRAFT'),
  );
  protected readonly action = new Action();
  protected form = this.blank();
  protected lines: LineDraft[] = [blankLine('HEADER'), blankLine('ACCOUNTS'), blankLine('TOTAL')];
  private readonly chartNames = computed(() => new Map(this.charts().map((c) => [c.id, c.code])));
  protected readonly templates = new Loadable(() =>
    this.deps.api.get<StatementTemplate[]>('accounting/statement-templates'),
  );
  protected readonly columns: Column<StatementTemplate>[] = [
    { key: 'code', required: true, label: 'Código' },
    { key: 'version', label: 'Versão', value: (r) => `v${r.version}` },
    { key: 'name', label: 'Nome' },
    { key: 'kind', label: 'Tipo', value: (r) => STATEMENT_KIND_LABELS[r.kind] },
    {
      key: 'chartId',
      label: 'Plano',
      hideOnMobile: true,
      value: (r) => this.chartNames().get(r.chartId) ?? '…',
    },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.templates.load();
    this.deps.api.page<Chart>('accounting/charts', { limit: 200 }).then(
      (p) => {
        this.charts.set(p.items);
        if (!this.form.chartId && p.items.length === 1) this.form.chartId = p.items[0].id;
      },
      () => undefined,
    );
  }

  private blank() {
    return {
      chartId: null as string | null,
      kind: 'BALANCE_SHEET' as StatementKind,
      code: '',
      name: '',
      checkA: '',
      checkB: '',
    };
  }

  protected statusText(s: string) {
    return TEMPLATE_STATUS[s] ?? s;
  }
  protected tone(s: string) {
    return s === 'PUBLISHED'
      ? 'bg-success-soft text-success-text'
      : s === 'DRAFT'
        ? 'bg-warning-soft text-warning-text'
        : 'bg-surface-2 text-fg';
  }

  protected move(i: number, d: number) {
    const [l] = this.lines.splice(i, 1);
    this.lines.splice(i + d, 0, l);
  }

  protected async edit(t: StatementTemplate) {
    const full = await this.deps.api.get<StatementTemplate>(
      `accounting/statement-templates/${t.id}`,
    );
    this.load(full);
  }

  private load(t: StatementTemplate) {
    this.current.set(t);
    this.action.error.set(null);
    this.form = {
      chartId: t.chartId,
      kind: t.kind,
      code: t.code,
      name: t.name,
      checkA: t.checkA ?? '',
      checkB: t.checkB ?? '',
    };
    this.lines = (t.lines ?? []).map((l) => ({
      kind: l.kind,
      code: l.code ?? '',
      label: l.label,
      sign: l.sign,
      formula: l.formula ?? '',
      noteRef: l.noteRef ?? '',
      mappings: formatMappings((t.mappings ?? []).filter((m) => m.lineCode === l.code)),
    }));
  }

  protected reset() {
    this.current.set(null);
    this.form = { ...this.blank(), chartId: this.form.chartId };
    this.lines = [blankLine('HEADER'), blankLine('ACCOUNTS'), blankLine('TOTAL')];
  }

  /** Linhas para a API; null (com aviso) se algum prefixo estiver mal escrito. */
  private payloadLines() {
    const out = [];
    for (const [i, l] of this.lines.entries()) {
      const mappings = l.kind === 'ACCOUNTS' ? parseMappings(l.mappings) : [];
      if (mappings === null) {
        this.toasts.show(`Linha ${i + 1}: prefixos inválidos (use p. ex. 111, 113:D).`, 'error');
        return null;
      }
      out.push({
        kind: l.kind,
        code: l.kind === 'HEADER' ? null : l.code,
        label: l.label,
        sign: l.sign,
        formula: l.kind === 'TOTAL' ? l.formula : null,
        noteRef: l.noteRef || null,
        mappings,
      });
    }
    return out;
  }

  protected async save() {
    const t = this.current();
    const lines = this.payloadLines();
    if (!lines) return;
    const body = {
      name: this.form.name,
      checkA: this.form.checkA || null,
      checkB: this.form.kind === 'BALANCE_SHEET' ? this.form.checkB || null : null,
      lines,
    };
    const result = await this.action.run(() =>
      t
        ? this.deps.api.patch<StatementTemplate>(`accounting/statement-templates/${t.id}`, body)
        : this.deps.api.post<StatementTemplate>('accounting/statement-templates', {
            ...body,
            chartId: this.form.chartId,
            code: this.form.code,
            kind: this.form.kind,
          }),
    );
    if (!result) return;
    this.toasts.show(t ? 'Rascunho guardado.' : 'Modelo criado em rascunho.');
    this.load(result);
    await this.templates.load();
  }

  protected async publish() {
    const t = this.current()!;
    const ok = await this.confirm.ask({
      title: 'Publicar modelo',
      message: `Publicar ${t.code} v${t.version}? Fica imutável e retira a versão publicada anterior.`,
      confirmLabel: 'Publicar',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.deps.api.post<StatementTemplate>(`accounting/statement-templates/${t.id}/publish`, {}),
    );
    if (!r) return;
    this.toasts.show('Modelo publicado.');
    this.load(r);
    await this.templates.load();
  }

  protected async newVersion() {
    const t = this.current()!;
    const r = await this.action.run(() =>
      this.deps.api.post<StatementTemplate>(`accounting/statement-templates/${t.id}/versions`, {}),
    );
    if (!r) return;
    this.toasts.show(`Versão ${r.version} criada em rascunho.`);
    this.load(r);
    await this.templates.load();
  }

  protected async remove() {
    const t = this.current()!;
    const ok = await this.confirm.ask({
      title: 'Apagar rascunho',
      message: `Apagar o rascunho ${t.code} v${t.version}?`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(async () => {
      await this.deps.api.delete(`accounting/statement-templates/${t.id}`);
      return true;
    });
    if (!done) return;
    this.toasts.show('Rascunho apagado.');
    this.reset();
    await this.templates.load();
  }
}
