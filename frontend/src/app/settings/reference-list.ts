import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { type OrgRecord, recordLabel } from '../admin/org-kinds';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { Icon } from '../ui/icon';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { REF_KINDS } from './reference-kinds';

const LIMIT = 25;

/**
 * Lista de uma tabela de referência (EntityListPage: câmbios, séries, calendários, contas bancárias): filtros do tipo na
 * URL, colunas configuráveis e exportação das colunas visíveis.
 */
@Component({
  selector: 'app-reference-list',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    StatusBadge,
    Icon,
  ],
  template: `
    @if (meta(); as k) {
      <app-entity-list-page [title]="k.title" [permission]="k.readPermission">
        @if (canManage()) {
          <a actions class="btn-primary" [routerLink]="['/empresa', k.segment, 'novo']"
            ><app-icon name="plus" [size]="16" />{{ k.feminine ? 'Nova' : 'Novo' }}
            {{ k.singular }}</a
          >
        }
        <app-filter-bar
          id="ref"
          [label]="k.title"
          placeholder="Pesquisar"
          [state]="list"
          [filters]="filterDefs()"
        />
        @if (k.segment === 'exchange-rates') {
          <form
            class="card mb-4 flex flex-wrap items-end gap-2"
            (ngSubmit)="lookup()"
            aria-label="Consultar câmbio"
          >
            <div>
              <label class="label" for="lk-from">De</label>
              <input id="lk-from" name="lkFrom" class="input w-24" [(ngModel)]="rate.from" />
            </div>
            <div>
              <label class="label" for="lk-to">Para</label>
              <input id="lk-to" name="lkTo" class="input w-24" [(ngModel)]="rate.to" />
            </div>
            <div>
              <label class="label" for="lk-date">Na data</label>
              <input id="lk-date" name="lkDate" type="date" class="input" [(ngModel)]="rate.date" />
            </div>
            <button type="submit" class="btn-secondary">Consultar</button>
            <p class="text-sm" role="status" data-testid="rate-result">{{ rateResult() }}</p>
          </form>
        }
        <app-data-table
          [label]="k.title"
          [tableId]="'ref-' + k.segment"
          [columns]="columns()"
          [rows]="list.page.value()?.items ?? []"
          [total]="list.page.value()?.total ?? 0"
          [loading]="list.page.loading()"
          [error]="list.page.error()"
          [offset]="list.offset()"
          [limit]="list.limit"
          [emptyText]="
            list.q() || list.activeFilters()
              ? 'Sem registos com estes filtros.'
              : 'Ainda não há registos.'
          "
          [exportable]="true"
          [exporting]="exporting()"
          (offsetChange)="list.goTo($event)"
          (retry)="list.reload()"
          (export)="export($event)"
        >
          <ng-template appCell="status" let-row
            ><app-status-badge [status]="row.status"
          /></ng-template>
        </app-data-table>
      </app-entity-list-page>
    } @else {
      <p class="card">Tipo desconhecido.</p>
    }
  `,
})
export class ReferenceList {
  readonly kind = input.required<string>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly meta = computed(() => REF_KINDS[this.kind()] ?? null);
  protected readonly canManage = computed(() => {
    const m = this.meta();
    return !!m && this.workspace.can(m.managePermission);
  });
  protected readonly filterDefs = computed<FilterDef[]>(() =>
    (this.meta()?.filters ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      options: (f.options ?? []).map((o) => ({ value: String(o.value), label: o.label })),
    })),
  );
  protected readonly exporting = signal(false);
  protected rate = { from: 'USD', to: 'AOA', date: new Date().toISOString().slice(0, 10) };
  protected readonly rateResult = signal('');
  private readonly names = signal<Map<string, string>>(new Map());
  protected readonly columns = computed<Column<OrgRecord>[]>(() => {
    const meta = this.meta();
    if (!meta) return [];
    return meta.columns.map((c, i) => ({
      key: c.key,
      label: c.label,
      hideOnMobile: i > 2 && c.key !== 'status',
      required: i === 0,
      link: i === 0 ? (r: OrgRecord) => ['/empresa', meta.segment, r.id] : undefined,
      value: (r: OrgRecord) => this.cell(c.key, r),
    }));
  });
  /** Pesquisa, filtros do tipo e página na URL; a entidade legal do âmbito vai sempre (não fica na URL). */
  protected readonly list = new ListState<OrgRecord>(this.api, {
    url: () => this.kind(),
    filterKeys: () => (this.meta()?.filters ?? []).map((f) => f.key),
    limit: LIMIT,
    extra: () => this.scope(),
  });

  constructor() {
    effect(() => {
      this.kind();
      this.workspace.legalEntityId();
      untracked(() => {
        void this.list.reload();
        void this.loadNames();
      });
    });
  }

  private scope() {
    const legalEntityId =
      this.meta()?.columns.some((c) => c.key === 'legalEntityId') || this.kind() === 'bank-accounts'
        ? (this.workspace.legalEntityId() ?? undefined)
        : undefined;
    return { legalEntityId };
  }

  private async loadNames() {
    if (!this.workspace.can('organization.read')) return;
    try {
      const page = await this.workspace.cached('names:legal-entities', () =>
        this.api.page<OrgRecord>('organization/legal-entities', { limit: 200 }),
      );
      this.names.set(new Map(page.items.map((r) => [r.id, recordLabel(r)])));
    } catch {
      /* sem nomes */
    }
  }

  private cell(key: string, r: OrgRecord) {
    const v = r[key];
    if (key === 'legalEntityId') return this.names().get(v as string) ?? '…';
    if (key === 'ibanMasked') return v ?? r['accountNumber'];
    if (key === 'isDefault') return v ? 'Sim' : 'Não';
    if (key === 'documentType') {
      const opt = this.meta()?.fields.find((f) => f.key === key)?.options;
      return opt?.find((o) => o.value === v)?.label ?? v;
    }
    if (key === 'validOn') return formatDate(v as string);
    return v ?? null;
  }

  /** Câmbio em vigor numa data: o mais recente com data igual ou anterior (regra do servidor). */
  protected async lookup() {
    const from = this.rate.from.trim().toUpperCase();
    const to = this.rate.to.trim().toUpperCase();
    try {
      const r = await this.api.get<{ rate: string; validOn: string; source: string | null }>(
        'exchange-rates/lookup',
        { from, to, date: this.rate.date },
      );
      this.rateResult.set(
        `1 ${from} = ${r.rate} ${to} (em vigor desde ${formatDate(r.validOn)}${r.source ? ', ' + r.source : ''})`,
      );
    } catch (error) {
      this.rateResult.set((error as { message?: string }).message ?? 'Sem câmbio.');
    }
  }

  protected async export(columns: Column<OrgRecord>[]) {
    this.exporting.set(true);
    try {
      const count = await exportList(
        this.api,
        this.list.url(),
        withoutPaging(this.list.query()),
        columns,
        `${this.kind()}.csv`,
      );
      this.toasts.show(`Exportados ${count} registo(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
