import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { type AssetClass, lifeText, METHOD_LABELS } from './model';
import { accountingDeps, entityReferences, keepKnown, legalEntityOptions } from './shared';

interface Option {
  id: string;
  label: string;
}

const ACCOUNT_FIELDS = [
  ['assetAccountId', 'Conta do activo', 'Onde entra o custo de aquisição.'],
  ['accumulatedAccountId', 'Amortizações acumuladas', 'Crédito das depreciações; sai no abate.'],
  ['expenseAccountId', 'Gasto de depreciação', 'Débito das depreciações mensais.'],
  ['gainAccountId', 'Ganho no abate', 'Quando a venda excede o valor líquido.'],
  ['lossAccountId', 'Perda no abate', 'Quando a venda fica abaixo do valor líquido.'],
] as const;

/**
 * Classes de activos fixos: contas, diário e vida útil/método por omissão. Os números de vida útil e coeficientes
 * são os que a empresa decide; não se assumem taxas fiscais.
 */
@Component({
  selector: 'app-asset-classes',
  imports: [
    FormsModule,
    PageHeader,
    DataTable,
    CellDef,
    StatusBadge,
    ErrorAlert,
    FormSection,
    FormField,
    FieldControl,
  ],
  template: `
    <app-page-header
      title="Classes de activos"
      subtitle="Contas, diário, vida útil e método por omissão de cada tipo de activo fixo."
    />
    <app-data-table
      label="Classes de activos"
      [columns]="columns"
      [rows]="classes.value() ?? []"
      [total]="classes.value()?.length ?? 0"
      [loading]="classes.loading()"
      [error]="classes.error()"
      emptyText="Ainda não há classes de activos."
      (retry)="classes.load()"
    >
      <ng-template appCell="code" let-row>
        <button type="button" class="btn-link" (click)="edit(row)">{{ row.code }}</button>
      </ng-template>
      <ng-template appCell="status" let-row><app-status-badge [status]="row.status" /></ng-template>
    </app-data-table>
    @if (canManage()) {
      <form
        class="mt-4 space-y-3"
        (ngSubmit)="save()"
        [attr.aria-label]="editing() ? 'Alterar classe' : 'Nova classe'"
      >
        <app-error-alert [error]="action.error()" [showDetails]="true" />
        <app-form-section [title]="editing() ? 'Alterar ' + editing()!.code : 'Nova classe'">
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
          <app-field label="Método" [error]="action.field('method')">
            <select appControl class="input" name="method" [(ngModel)]="form.method">
              <option value="STRAIGHT_LINE">Linha recta</option>
              <option value="DECLINING_BALANCE">Degressivo</option>
            </select>
          </app-field>
          <app-field
            label="Vida útil (meses)"
            [required]="true"
            [hint]="lifeHint()"
            [error]="action.field('usefulLifeMonths')"
          >
            <input
              appControl
              class="input"
              type="number"
              min="1"
              max="1200"
              name="life"
              [(ngModel)]="form.usefulLifeMonths"
            />
          </app-field>
          @if (form.method === 'DECLINING_BALANCE') {
            <app-field
              label="Coeficiente degressivo"
              hint="Entre 1,00 e 4,00 (p. ex. 2,00 duplica a taxa da linha recta)."
              [error]="action.field('decliningFactor')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                name="factor"
                [(ngModel)]="form.decliningFactor"
              />
            </app-field>
          }
          <app-field label="Estado">
            <select appControl class="input" name="status" [(ngModel)]="form.status">
              <option value="ACTIVE">Activa</option>
              <option value="INACTIVE">Inactiva</option>
            </select>
          </app-field>
        </app-form-section>
        <app-form-section
          title="Contas"
          description="Contas movimentáveis do plano activo da entidade. Com activos contabilizados, as contas do activo e das amortizações acumuladas deixam de mudar."
        >
          @for (f of accountFields; track f[0]) {
            <app-field [label]="f[1]" [required]="true" [hint]="f[2]" [error]="action.field(f[0])">
              <select appControl class="input" [name]="f[0]" [(ngModel)]="form[f[0]]">
                <option [ngValue]="null">—</option>
                @for (a of accounts(); track a.id) {
                  <option [ngValue]="a.id">{{ a.label }}</option>
                }
              </select>
            </app-field>
          }
        </app-form-section>
        <div class="flex gap-2">
          <button type="submit" class="btn-primary" [disabled]="action.busy()">
            {{ editing() ? 'Guardar classe' : 'Criar classe' }}
          </button>
          @if (editing()) {
            <button type="button" class="btn-secondary" (click)="reset()">Nova classe</button>
          }
        </div>
      </form>
    }
  `,
})
export class AssetClasses {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly accountFields = ACCOUNT_FIELDS;
  protected readonly canManage = computed(() => this.deps.workspace.can('fixed_assets.manage'));
  protected readonly entities = signal<Option[]>([]);
  protected readonly journals = signal<Option[]>([]);
  protected readonly accounts = signal<Option[]>([]);
  protected readonly editing = signal<AssetClass | null>(null);
  protected readonly action = new Action();
  protected form = this.blank(null);
  private refRequest = 0;
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly classes = new Loadable(
    async () =>
      (await this.deps.api.page<AssetClass>('accounting/fixed-asset-classes', { limit: 200 }))
        .items,
  );
  protected readonly columns: Column<AssetClass>[] = [
    { key: 'code', label: 'Código' },
    { key: 'name', label: 'Nome' },
    {
      key: 'legalEntityId',
      label: 'Entidade',
      hideOnMobile: true,
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    { key: 'method', label: 'Método', value: (r) => METHOD_LABELS[r.method] },
    { key: 'usefulLifeMonths', label: 'Vida útil', value: (r) => lifeText(r.usefulLifeMonths) },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.classes.load();
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.form.legalEntityId =
        this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      await this.loadRefs();
    })();
  }

  private blank(legalEntityId: string | null) {
    return {
      legalEntityId,
      code: '',
      name: '',
      method: 'STRAIGHT_LINE' as AssetClass['method'],
      usefulLifeMonths: 60 as number | null,
      decliningFactor: '2.00',
      journalId: null as string | null,
      assetAccountId: null as string | null,
      accumulatedAccountId: null as string | null,
      expenseAccountId: null as string | null,
      gainAccountId: null as string | null,
      lossAccountId: null as string | null,
      status: 'ACTIVE',
    };
  }

  protected lifeHint() {
    return this.form.usefulLifeMonths ? lifeText(Number(this.form.usefulLifeMonths)) : null;
  }

  protected async loadRefs() {
    const le = this.form.legalEntityId;
    const request = ++this.refRequest;
    this.journals.set([]);
    this.accounts.set([]);
    if (!le) return;
    const refs = await entityReferences(this.deps.api, this.deps.workspace, le);
    if (request !== this.refRequest) return;
    this.journals.set(refs.journals);
    this.accounts.set(refs.accounts);
    keepKnown(this.form, ['journalId'], refs.journals);
    keepKnown(
      this.form,
      ACCOUNT_FIELDS.map((f) => f[0]),
      refs.accounts,
    );
    if (!this.form.journalId && refs.journals.length === 1)
      this.form.journalId = refs.journals[0].id;
  }

  protected async edit(c: AssetClass) {
    this.editing.set(c);
    this.form = {
      legalEntityId: c.legalEntityId,
      code: c.code,
      name: c.name,
      method: c.method,
      usefulLifeMonths: c.usefulLifeMonths,
      decliningFactor: c.decliningFactor ?? '2.00',
      journalId: c.journalId,
      assetAccountId: c.assetAccountId,
      accumulatedAccountId: c.accumulatedAccountId,
      expenseAccountId: c.expenseAccountId,
      gainAccountId: c.gainAccountId,
      lossAccountId: c.lossAccountId,
      status: c.status,
    };
    await this.loadRefs();
  }

  protected reset() {
    this.editing.set(null);
    this.form = this.blank(this.form.legalEntityId);
    void this.loadRefs();
  }

  protected async save() {
    const c = this.editing();
    const body = {
      ...this.form,
      usefulLifeMonths: Number(this.form.usefulLifeMonths),
      decliningFactor:
        this.form.method === 'DECLINING_BALANCE'
          ? this.form.decliningFactor.replace(',', '.')
          : null,
    };
    const { legalEntityId, code, ...changes } = body;
    const result = await this.action.run(() =>
      c
        ? this.deps.api.patch<AssetClass>(`accounting/fixed-asset-classes/${c.id}`, {
            expectedVersion: c.version,
            ...changes,
          })
        : this.deps.api.post<AssetClass>('accounting/fixed-asset-classes', {
            legalEntityId,
            code,
            ...changes,
          }),
    );
    if (!result) return;
    this.toasts.show(c ? 'Classe guardada.' : 'Classe criada.');
    this.editing.set(result);
    await this.classes.load();
  }
}
