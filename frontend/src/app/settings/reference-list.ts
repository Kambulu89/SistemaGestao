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
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { REF_KINDS } from './reference-kinds';

const LIMIT = 25;

/** Lista de uma tabela de referência (câmbios, séries, calendários, contas bancárias) com filtros do servidor. */
@Component({
  selector: 'app-reference-list',
  imports: [FormsModule, RouterLink, PageHeader, DataTable, CellDef, StatusBadge, Icon],
  template: `
    @if (meta(); as k) {
      <app-page-header [title]="k.title">
        @if (canManage()) {
          <a class="btn-primary" [routerLink]="['/empresa', k.segment, 'novo']"
            ><app-icon name="plus" [size]="16" />{{ k.feminine ? 'Nova' : 'Novo' }}
            {{ k.singular }}</a
          >
        }
      </app-page-header>
      <form class="mb-4 flex flex-wrap items-end gap-2" (ngSubmit)="go(0)" role="search">
        <div>
          <label class="label" for="q">Pesquisar</label>
          <input id="q" name="q" type="search" class="input w-64" [(ngModel)]="q" />
        </div>
        @for (f of k.filters; track f.key) {
          <div>
            <label class="label" [for]="'f-' + f.key">{{ f.label }}</label>
            <select
              class="input w-48"
              [id]="'f-' + f.key"
              [name]="f.key"
              [ngModel]="filters()[f.key] ?? ''"
              (ngModelChange)="setFilter(f.key, $event)"
            >
              <option value="">Todos</option>
              @for (o of f.options; track o.value) {
                <option [value]="o.value">{{ o.label }}</option>
              }
            </select>
          </div>
        }
        <button type="submit" class="btn-secondary">Pesquisar</button>
      </form>
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
        [columns]="columns()"
        [rows]="page.value()?.items ?? []"
        [total]="page.value()?.total ?? 0"
        [loading]="page.loading()"
        [error]="page.error()"
        [offset]="offset()"
        [limit]="limit"
        [emptyText]="q() ? 'Sem registos com estes filtros.' : 'Ainda não há registos.'"
        [exportable]="true"
        [exporting]="exporting()"
        (offsetChange)="go($event)"
        (retry)="page.load()"
        (export)="export()"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
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
  protected readonly limit = LIMIT;
  protected readonly q = signal('');
  protected readonly filters = signal<Record<string, string>>({});
  protected readonly offset = signal(0);
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
      link: i === 0 ? (r: OrgRecord) => ['/empresa', meta.segment, r.id] : undefined,
      value: (r: OrgRecord) => this.cell(c.key, r),
    }));
  });
  protected readonly page = new Loadable(() => this.api.page<OrgRecord>(this.kind(), this.query()));

  constructor() {
    effect(() => {
      this.kind();
      untracked(() => {
        this.q.set('');
        this.filters.set({});
        this.offset.set(0);
        void this.page.load();
        void this.loadNames();
      });
    });
  }

  private query() {
    const legalEntityId =
      this.meta()?.columns.some((c) => c.key === 'legalEntityId') || this.kind() === 'bank-accounts'
        ? (this.workspace.legalEntityId() ?? undefined)
        : undefined;
    return {
      q: this.q().trim() || undefined,
      ...this.filters(),
      legalEntityId,
      limit: LIMIT,
      offset: this.offset(),
    };
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

  protected setFilter(key: string, value: string) {
    this.filters.update((f) => {
      const next = { ...f };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    this.go(0);
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

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async export() {
    this.exporting.set(true);
    try {
      const count = await exportList(
        this.api,
        this.kind(),
        withoutPaging(this.query()),
        this.columns(),
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
