import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action, Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import {
  type AdjustmentPreview,
  type AdjustmentSchedule,
  currentMonth,
  FREQUENCY_LABELS,
  normalizeAmount,
  SCHEDULE_KIND_LABELS,
  type ScheduleKind,
  type ScheduleLineInput,
} from './model';
import {
  accountingDeps,
  entityReferences,
  keepKnown,
  legalEntityOptions,
  moneyText,
} from './shared';

interface Option {
  id: string;
  label: string;
}

const blankLine = (): ScheduleLineInput => ({
  accountId: null,
  debit: '',
  credit: '',
  costCenterId: null,
  thirdPartyRef: '',
  description: '',
});

/**
 * Planos de regularização: recorrências (linhas fixas) e acréscimos/diferimentos (total repartido por N meses). A
 * geração cria rascunhos que seguem a aprovação normal; cada plano gera cada mês uma só vez.
 */
@Component({
  selector: 'app-adjustment-schedules',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    DataTable,
    CellDef,
    StatusBadge,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-entity-list-page
      title="Regularizações"
      subtitle="Recorrências, acréscimos e diferimentos. Geram rascunhos que seguem a aprovação normal."
      permission="accounting.read"
      feature="accounting"
    >
      @if (canManage()) {
        <section class="card mb-4" aria-labelledby="adj-gen">
          <h2 id="adj-gen" class="mb-3 font-semibold">Gerar rascunhos</h2>
          <form
            class="flex flex-wrap items-end gap-2"
            (ngSubmit)="preview()"
            aria-label="Gerar regularizações"
          >
            <div>
              <label class="label" for="adj-le">Entidade legal</label>
              <select
                id="adj-le"
                name="le"
                class="input w-64"
                [(ngModel)]="genEntity"
                (ngModelChange)="pending.set(null)"
              >
                @for (e of entities(); track e.id) {
                  <option [ngValue]="e.id">{{ e.label }}</option>
                }
              </select>
            </div>
            <div>
              <label class="label" for="adj-upto">Até ao mês</label>
              <input
                id="adj-upto"
                name="upTo"
                type="month"
                class="input w-44"
                [(ngModel)]="upTo"
                (ngModelChange)="pending.set(null)"
              />
            </div>
            <button type="submit" class="btn-secondary" [disabled]="gen.busy() || !genEntity">
              Simular
            </button>
            @if (pending()?.rows?.length && !pending()?.entries) {
              <button
                type="button"
                class="btn-primary"
                [disabled]="gen.busy()"
                (click)="generate()"
              >
                Gerar {{ pending()!.rows.length }} rascunho(s)
              </button>
            }
          </form>
          <app-error-alert [error]="gen.error()" [showDetails]="true" />
          @if (pending(); as p) {
            <p class="mt-3 text-sm" role="status" data-testid="adj-status">
              @if (p.entries) {
                Gerados {{ p.entries.length }} rascunho(s), total {{ money(p.total) }}. Submeta-os
                em Lançamentos.
              } @else if (p.rows.length === 0) {
                Nada por gerar até {{ upTo }}.
              } @else {
                Por gerar: {{ p.rows.length }} rascunho(s), total {{ money(p.total) }}.
              }
            </p>
            @if (p.rows.length) {
              <ul class="mt-2 divide-y divide-border text-sm">
                @for (r of p.rows; track r.scheduleId + r.month) {
                  <li class="flex justify-between gap-2 py-1">
                    <span
                      >{{ r.month }} · {{ r.code }} — {{ r.name }} ({{ kindText(r.kind) }})</span
                    >
                    <span>{{ money(r.total) }}</span>
                  </li>
                }
              </ul>
            }
          }
        </section>
      }

      <app-data-table
        tableId="acc-adjustment-schedules"
        label="Planos de regularização"
        [columns]="columns"
        [rows]="schedules.value() ?? []"
        [total]="schedules.value()?.length ?? 0"
        [loading]="schedules.loading()"
        [error]="schedules.error()"
        emptyText="Ainda não há planos."
        (retry)="schedules.load()"
      >
        <ng-template appCell="code" let-row>
          <button type="button" class="btn-link" (click)="edit(row)">{{ row.code }}</button>
        </ng-template>
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>

      @if (editing()?.occurrences?.length) {
        <section class="card mt-4" aria-labelledby="adj-occ">
          <h2 id="adj-occ" class="mb-2 font-semibold">Meses gerados de {{ editing()!.code }}</h2>
          <ul class="divide-y divide-border text-sm" data-testid="adj-occurrences">
            @for (o of editing()!.occurrences; track o.month) {
              <li class="flex justify-between gap-2 py-1">
                <span>{{ o.month }} · {{ money(o.amount) }}</span>
                <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', o.entryId]">{{
                  o.entryNumber ?? 'rascunho'
                }}</a>
              </li>
            }
          </ul>
        </section>
      }

      @if (canManage()) {
        <form
          class="mt-4 space-y-3"
          (ngSubmit)="save()"
          [attr.aria-label]="editing() ? 'Alterar plano' : 'Novo plano'"
        >
          <app-error-alert [error]="action.error()" [showDetails]="true" />
          <app-form-section [title]="editing() ? 'Alterar ' + editing()!.code : 'Novo plano'">
            <app-field
              label="Entidade legal"
              [required]="true"
              [error]="action.field('legalEntityId')"
            >
              <select
                appControl
                class="input"
                name="le"
                [disabled]="!!editing()"
                [(ngModel)]="form.legalEntityId"
                (ngModelChange)="loadRefs()"
              >
                <option [ngValue]="null">—</option>
                @for (e of entities(); track e.id) {
                  <option [ngValue]="e.id">{{ e.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
              <select
                appControl
                class="input"
                name="kind"
                [disabled]="!!editing()"
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
                [disabled]="!!editing()"
                [(ngModel)]="form.code"
              />
            </app-field>
            <app-field label="Nome" [required]="true" [error]="action.field('name')">
              <input appControl class="input" name="name" [(ngModel)]="form.name" />
            </app-field>
            <app-field label="Diário" [required]="true" [error]="action.field('journalId')">
              <select appControl class="input" name="journal" [(ngModel)]="form.journalId">
                <option [ngValue]="null">—</option>
                @for (j of journals(); track j.id) {
                  <option [ngValue]="j.id">{{ j.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Primeiro mês" [required]="true" [error]="action.field('startMonth')">
              <input
                appControl
                class="input"
                type="month"
                name="start"
                [(ngModel)]="form.startMonth"
              />
            </app-field>
            @if (form.kind === 'RECURRING') {
              <app-field label="Periodicidade" [error]="action.field('frequency')">
                <select appControl class="input" name="frequency" [(ngModel)]="form.frequency">
                  @for (f of frequencies; track f[0]) {
                    <option [value]="f[0]">{{ f[1] }}</option>
                  }
                </select>
              </app-field>
              <app-field
                label="Último mês"
                hint="Vazio: sem fim."
                [error]="action.field('endMonth')"
              >
                <input
                  appControl
                  class="input"
                  type="month"
                  name="end"
                  [(ngModel)]="form.endMonth"
                />
              </app-field>
            } @else {
              <app-field
                label="Total a repartir"
                [required]="true"
                [error]="action.field('totalAmount')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  name="total"
                  [(ngModel)]="form.totalAmount"
                />
              </app-field>
              <app-field label="N.º de meses" [required]="true" [error]="action.field('months')">
                <input
                  appControl
                  class="input"
                  type="number"
                  min="1"
                  max="600"
                  name="months"
                  [(ngModel)]="form.months"
                />
              </app-field>
              <app-field
                label="Conta a débito"
                [required]="true"
                [hint]="
                  form.kind === 'DEFERRAL' ? 'P. ex. o gasto do mês.' : 'P. ex. o gasto incorrido.'
                "
                [error]="action.field('debitAccountId')"
              >
                <select appControl class="input" name="debit" [(ngModel)]="form.debitAccountId">
                  <option [ngValue]="null">—</option>
                  @for (a of accounts(); track a.id) {
                    <option [ngValue]="a.id">{{ a.label }}</option>
                  }
                </select>
              </app-field>
              <app-field
                label="Conta a crédito"
                [required]="true"
                [hint]="
                  form.kind === 'DEFERRAL'
                    ? 'P. ex. gastos a reconhecer.'
                    : 'P. ex. acréscimos de gastos.'
                "
                [error]="action.field('creditAccountId')"
              >
                <select appControl class="input" name="credit" [(ngModel)]="form.creditAccountId">
                  <option [ngValue]="null">—</option>
                  @for (a of accounts(); track a.id) {
                    <option [ngValue]="a.id">{{ a.label }}</option>
                  }
                </select>
              </app-field>
              <app-field label="Centro de custo" [error]="action.field('costCenterId')">
                <select appControl class="input" name="cc" [(ngModel)]="form.costCenterId">
                  <option [ngValue]="null">—</option>
                  @for (c of centers(); track c.id) {
                    <option [ngValue]="c.id">{{ c.label }}</option>
                  }
                </select>
              </app-field>
            }
            <app-field label="Estado">
              <select appControl class="input" name="status" [(ngModel)]="form.status">
                <option value="ACTIVE">Activo</option>
                <option value="INACTIVE">Inactivo</option>
              </select>
            </app-field>
          </app-form-section>
          @if (form.kind === 'RECURRING') {
            <fieldset class="card space-y-2">
              <legend class="font-semibold">Linhas de cada mês</legend>
              @if (action.field('lines')) {
                <p class="field-error" role="alert">{{ action.field('lines') }}</p>
              }
              @for (l of lines; track $index; let i = $index) {
                <div class="grid gap-2 md:grid-cols-[2fr_1fr_1fr_1.5fr_1fr_auto] md:items-end">
                  <div>
                    <label class="label" [for]="'l-acc-' + i">Conta {{ i + 1 }}</label>
                    <select
                      class="input"
                      [id]="'l-acc-' + i"
                      [name]="'acc' + i"
                      [(ngModel)]="l.accountId"
                    >
                      <option [ngValue]="null">—</option>
                      @for (a of accounts(); track a.id) {
                        <option [ngValue]="a.id">{{ a.label }}</option>
                      }
                    </select>
                  </div>
                  <div>
                    <label class="label" [for]="'l-d-' + i">Débito {{ i + 1 }}</label>
                    <input
                      class="input"
                      inputmode="decimal"
                      [id]="'l-d-' + i"
                      [name]="'d' + i"
                      [(ngModel)]="l.debit"
                    />
                  </div>
                  <div>
                    <label class="label" [for]="'l-c-' + i">Crédito {{ i + 1 }}</label>
                    <input
                      class="input"
                      inputmode="decimal"
                      [id]="'l-c-' + i"
                      [name]="'c' + i"
                      [(ngModel)]="l.credit"
                    />
                  </div>
                  <div>
                    <label class="label" [for]="'l-cc-' + i">Centro de custo {{ i + 1 }}</label>
                    <select
                      class="input"
                      [id]="'l-cc-' + i"
                      [name]="'cc' + i"
                      [(ngModel)]="l.costCenterId"
                    >
                      <option [ngValue]="null">—</option>
                      @for (c of centers(); track c.id) {
                        <option [ngValue]="c.id">{{ c.label }}</option>
                      }
                    </select>
                  </div>
                  <div>
                    <label class="label" [for]="'l-t-' + i">Terceiro {{ i + 1 }}</label>
                    <input
                      class="input"
                      [id]="'l-t-' + i"
                      [name]="'t' + i"
                      [(ngModel)]="l.thirdPartyRef"
                    />
                  </div>
                  <button
                    type="button"
                    class="btn-secondary"
                    [attr.aria-label]="'Remover linha ' + (i + 1)"
                    [disabled]="lines.length <= 2"
                    (click)="lines.splice(i, 1)"
                  >
                    Remover
                  </button>
                </div>
              }
              <button type="button" class="btn-secondary" (click)="lines.push(blankLine())">
                Acrescentar linha
              </button>
            </fieldset>
          }
          <div class="flex gap-2">
            <button type="submit" class="btn-primary" [disabled]="action.busy()">
              {{ editing() ? 'Guardar plano' : 'Criar plano' }}
            </button>
            @if (editing()) {
              <button type="button" class="btn-secondary" (click)="reset()">Novo plano</button>
            }
          </div>
        </form>
      }
    </app-entity-list-page>
  `,
})
export class AdjustmentSchedules {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly blankLine = blankLine;
  protected readonly kinds = Object.entries(SCHEDULE_KIND_LABELS);
  protected readonly frequencies = Object.entries(FREQUENCY_LABELS);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.adjustments'));
  protected readonly entities = signal<Option[]>([]);
  protected readonly journals = signal<Option[]>([]);
  protected readonly accounts = signal<Option[]>([]);
  protected readonly centers = signal<Option[]>([]);
  protected readonly editing = signal<AdjustmentSchedule | null>(null);
  protected readonly pending = signal<AdjustmentPreview | null>(null);
  protected readonly action = new Action();
  protected readonly gen = new Action();
  protected form = this.blank(null);
  protected lines: ScheduleLineInput[] = [blankLine(), blankLine()];
  protected genEntity: string | null = null;
  protected upTo = currentMonth();
  private refRequest = 0;
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly schedules = new Loadable(
    async () =>
      (
        await this.deps.api.page<AdjustmentSchedule>('accounting/adjustment-schedules', {
          limit: 200,
        })
      ).items,
  );
  protected readonly columns: Column<AdjustmentSchedule>[] = [
    { key: 'code', required: true, label: 'Código' },
    { key: 'name', label: 'Nome' },
    { key: 'kind', label: 'Tipo', value: (r) => SCHEDULE_KIND_LABELS[r.kind] },
    {
      key: 'startMonth',
      label: 'Período',
      value: (r) =>
        r.kind === 'RECURRING'
          ? `${FREQUENCY_LABELS[r.frequency] ?? r.frequency} desde ${r.startMonth}${r.endMonth ? ' até ' + r.endMonth : ''}`
          : `${r.months} meses desde ${r.startMonth}`,
    },
    {
      key: 'totalAmount',
      label: 'Total',
      align: 'end',
      hideOnMobile: true,
      value: (r) => (r.totalAmount ? moneyText(r.totalAmount) : '—'),
    },
    {
      key: 'legalEntityId',
      label: 'Entidade',
      hideOnMobile: true,
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.schedules.load();
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      const le = this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      this.form.legalEntityId = le;
      this.genEntity = le;
      await this.loadRefs();
    })();
  }

  private blank(legalEntityId: string | null) {
    return {
      legalEntityId,
      kind: 'RECURRING' as ScheduleKind,
      code: '',
      name: '',
      journalId: null as string | null,
      frequency: 'MONTHLY',
      startMonth: currentMonth(),
      endMonth: '',
      totalAmount: '',
      months: 12 as number | null,
      debitAccountId: null as string | null,
      creditAccountId: null as string | null,
      costCenterId: null as string | null,
      status: 'ACTIVE',
    };
  }

  protected money(v: string) {
    return moneyText(v);
  }
  protected kindText(k: ScheduleKind) {
    return SCHEDULE_KIND_LABELS[k];
  }

  protected async loadRefs() {
    const le = this.form.legalEntityId;
    const request = ++this.refRequest;
    this.journals.set([]);
    this.accounts.set([]);
    this.centers.set([]);
    if (!le) return;
    const refs = await entityReferences(this.deps.api, this.deps.workspace, le);
    if (request !== this.refRequest) return;
    this.journals.set(refs.journals);
    this.accounts.set(refs.accounts);
    this.centers.set(refs.centers);
    keepKnown(this.form, ['journalId'], refs.journals);
    keepKnown(this.form, ['debitAccountId', 'creditAccountId'], refs.accounts);
    keepKnown(this.form, ['costCenterId'], refs.centers);
    for (const l of this.lines) {
      keepKnown(l, ['accountId'], refs.accounts);
      keepKnown(l, ['costCenterId'], refs.centers);
    }
    if (!this.form.journalId && refs.journals.length === 1)
      this.form.journalId = refs.journals[0].id;
  }

  protected async edit(s: AdjustmentSchedule) {
    const full = await this.deps.api.get<AdjustmentSchedule>(
      `accounting/adjustment-schedules/${s.id}`,
    );
    this.editing.set(full);
    this.form = {
      legalEntityId: full.legalEntityId,
      kind: full.kind,
      code: full.code,
      name: full.name,
      journalId: full.journalId,
      frequency: full.frequency,
      startMonth: full.startMonth,
      endMonth: full.endMonth ?? '',
      totalAmount: full.totalAmount ?? '',
      months: full.months,
      debitAccountId: full.debitAccountId,
      creditAccountId: full.creditAccountId,
      costCenterId: full.costCenterId,
      status: full.status,
    };
    this.lines = full.lines?.length
      ? full.lines.map((l) => ({ ...l }))
      : [blankLine(), blankLine()];
    await this.loadRefs();
  }

  protected reset() {
    this.editing.set(null);
    this.form = this.blank(this.form.legalEntityId);
    this.lines = [blankLine(), blankLine()];
    void this.loadRefs();
  }

  protected async save() {
    const s = this.editing();
    const f = this.form;
    const used = !!s?.occurrences?.length;
    const body: Record<string, unknown> = {
      name: f.name,
      journalId: f.journalId,
      status: f.status,
    };
    if (!used) body['startMonth'] = f.startMonth;
    if (f.kind === 'RECURRING') {
      if (!used) body['frequency'] = f.frequency;
      body['endMonth'] = f.endMonth || null;
      body['lines'] = this.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit ? normalizeAmount(l.debit) : null,
        credit: l.credit ? normalizeAmount(l.credit) : null,
        costCenterId: l.costCenterId,
        thirdPartyRef: l.thirdPartyRef,
      }));
    } else if (!used) {
      Object.assign(body, {
        totalAmount: normalizeAmount(f.totalAmount),
        months: Number(f.months),
        debitAccountId: f.debitAccountId,
        creditAccountId: f.creditAccountId,
        costCenterId: f.costCenterId,
      });
    }
    const result = await this.action.run(() =>
      s
        ? this.deps.api.patch<AdjustmentSchedule>(`accounting/adjustment-schedules/${s.id}`, {
            expectedVersion: s.version,
            ...body,
          })
        : this.deps.api.post<AdjustmentSchedule>('accounting/adjustment-schedules', {
            ...body,
            legalEntityId: f.legalEntityId,
            code: f.code,
            kind: f.kind,
          }),
    );
    if (!result) return;
    this.toasts.show(s ? 'Plano guardado.' : 'Plano criado.');
    this.editing.set(result);
    await this.schedules.load();
  }

  protected async preview() {
    const r = await this.gen.run(() =>
      this.deps.api.get<AdjustmentPreview>('accounting/adjustments/preview', {
        legalEntityId: this.genEntity,
        upTo: this.upTo,
      }),
    );
    this.pending.set(r ?? null);
  }

  protected async generate() {
    const p = this.pending()!;
    const ok = await this.confirm.ask({
      title: 'Gerar rascunhos',
      message: `Criar ${p.rows.length} rascunho(s) (${this.money(p.total)}) até ${this.upTo}? Ficam em rascunho para submeter e aprovar.`,
      confirmLabel: 'Gerar',
    });
    if (!ok) return;
    const r = await this.gen.run(() =>
      this.deps.api.post<AdjustmentPreview>('accounting/adjustments/generate', {
        legalEntityId: this.genEntity,
        upTo: this.upTo,
      }),
    );
    if (!r) return;
    this.pending.set(r);
    this.toasts.show(`Gerados ${r.entries?.length ?? 0} rascunho(s).`);
    const s = this.editing();
    if (s) await this.edit(s);
  }
}
