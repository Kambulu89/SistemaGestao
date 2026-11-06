import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { Icon } from '../ui/icon';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import { ASSET_STATUS, type AssetClass, type AssetStatus, type FixedAsset } from './model';
import { accountingDeps, moneyText } from './shared';

const LIMIT = 25;

/** Activos fixos com filtros do servidor (estado, classe, pesquisa) e valor líquido actual. */
@Component({
  selector: 'app-assets',
  imports: [FormsModule, RouterLink, PageHeader, DataTable, CellDef, Icon],
  template: `
    <app-page-header
      title="Activos fixos"
      subtitle="Fichas, aquisição, depreciação e abate. Os lançamentos são gerados e contabilizados pela ficha."
    >
      @if (canManage()) {
        <a class="btn-primary" routerLink="/contabilidade/activos/novo"
          ><app-icon name="plus" [size]="16" />Novo activo</a
        >
      }
    </app-page-header>
    <form class="mb-4 flex flex-wrap items-end gap-2" role="search" (ngSubmit)="go(0)">
      <div>
        <label class="label" for="fa-q">Pesquisar</label>
        <input
          id="fa-q"
          name="q"
          type="search"
          class="input w-64"
          placeholder="N.º, designação, série ou localização"
          [(ngModel)]="q"
        />
      </div>
      <div>
        <label class="label" for="fa-status">Estado</label>
        <select
          id="fa-status"
          name="status"
          class="input w-44"
          [(ngModel)]="status"
          (ngModelChange)="go(0)"
        >
          <option value="">Todos</option>
          @for (s of statuses; track s[0]) {
            <option [value]="s[0]">{{ s[1] }}</option>
          }
        </select>
      </div>
      <div>
        <label class="label" for="fa-class">Classe</label>
        <select
          id="fa-class"
          name="class"
          class="input w-48"
          [(ngModel)]="classId"
          (ngModelChange)="go(0)"
        >
          <option value="">Todas</option>
          @for (c of classes(); track c.id) {
            <option [value]="c.id">{{ c.code }} — {{ c.name }}</option>
          }
        </select>
      </div>
      <button type="submit" class="btn-secondary">Pesquisar</button>
    </form>
    <app-data-table
      label="Activos fixos"
      [columns]="columns"
      [rows]="page.value()?.items ?? []"
      [total]="page.value()?.total ?? 0"
      [loading]="page.loading()"
      [error]="page.error()"
      [offset]="offset()"
      [limit]="limit"
      [exportable]="true"
      [exporting]="exporting()"
      emptyText="Sem activos fixos."
      (offsetChange)="go($event)"
      (retry)="page.load()"
      (export)="export()"
    >
      <ng-template appCell="status" let-row>
        <span class="badge" [class]="tone(row.status)">{{ statusText(row.status) }}</span>
      </ng-template>
    </app-data-table>
  `,
})
export class Assets {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly limit = LIMIT;
  protected readonly statuses = Object.entries(ASSET_STATUS);
  protected readonly canManage = computed(() => this.deps.workspace.can('fixed_assets.manage'));
  protected readonly classes = signal<AssetClass[]>([]);
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly classId = signal('');
  protected readonly offset = signal(0);
  protected readonly exporting = signal(false);
  protected readonly statusText = (s: AssetStatus) => ASSET_STATUS[s] ?? s;
  protected readonly tone = (s: AssetStatus) =>
    s === 'ACTIVE'
      ? 'bg-success-soft text-success-text'
      : s === 'DRAFT'
        ? 'bg-warning-soft text-warning-text'
        : 'bg-surface-2 text-fg';
  private readonly classNames = computed(() => new Map(this.classes().map((c) => [c.id, c.code])));
  protected readonly columns: Column<FixedAsset>[] = [
    { key: 'number', label: 'N.º', link: (r) => ['/contabilidade/activos', r.id] },
    { key: 'name', label: 'Designação' },
    {
      key: 'classId',
      label: 'Classe',
      hideOnMobile: true,
      value: (r) => this.classNames().get(r.classId) ?? '…',
    },
    {
      key: 'acquisitionDate',
      label: 'Aquisição',
      hideOnMobile: true,
      value: (r) => formatDate(r.acquisitionDate),
    },
    { key: 'cost', label: 'Custo', align: 'end', value: (r) => moneyText(r.cost) },
    {
      key: 'accumulated',
      label: 'Depreciação acumulada',
      align: 'end',
      hideOnMobile: true,
      value: (r) => moneyText(r.accumulated),
    },
    {
      key: 'bookValue',
      label: 'Valor líquido',
      align: 'end',
      value: (r) => moneyText(r.bookValue),
    },
    { key: 'location', label: 'Localização', hideOnMobile: true, value: (r) => r.location ?? '—' },
    { key: 'status', label: 'Estado' },
  ];
  protected readonly page = new Loadable(() =>
    this.deps.api.page<FixedAsset>('accounting/fixed-assets', this.query()),
  );

  constructor() {
    void this.page.load();
    this.deps.api.page<AssetClass>('accounting/fixed-asset-classes', { limit: 200 }).then(
      (p) => this.classes.set(p.items),
      () => undefined,
    );
  }

  private query() {
    return {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      classId: this.classId() || undefined,
      legalEntityId: this.deps.workspace.legalEntityId() ?? undefined,
      limit: LIMIT,
      offset: this.offset(),
    };
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async export() {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.deps.api,
        'accounting/fixed-assets',
        withoutPaging(this.query()),
        this.columns,
        'activos-fixos.csv',
      );
      this.toasts.show(`Exportados ${n} activo(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
