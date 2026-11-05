import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable, type Sort } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { Icon } from '../ui/icon';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { BRANCH_TYPES, ORG_KINDS, type OrgRecord, recordLabel } from './org-kinds';

const LIMIT = 25;
/** Tipos que se filtram pela entidade legal / filial do âmbito de trabalho. */
const SCOPED_BY_ENTITY = new Set(['branches', 'departments', 'cost-centers']);

/** Lista de uma entidade organizacional: pesquisa, estado, âmbito, ordenação e paginação no servidor, exportação. */
@Component({
  selector: 'app-organization-list',
  imports: [FormsModule, RouterLink, PageHeader, DataTable, CellDef, StatusBadge, Icon],
  template: `
    @if (meta(); as k) {
      <app-page-header [title]="k.title">
        @if (canManage()) {
          <a class="btn-primary" [routerLink]="['/organizacao', k.segment, 'novo']"
            ><app-icon name="plus" [size]="16" />Nova {{ k.singular }}</a
          >
        }
      </app-page-header>
      <form class="mb-4 flex flex-wrap items-end gap-2" (ngSubmit)="go(0)" role="search">
        <div>
          <label class="label" for="q">Pesquisar</label>
          <input
            id="q"
            name="q"
            type="search"
            class="input w-64"
            placeholder="Código ou nome"
            [(ngModel)]="q"
          />
        </div>
        <div>
          <label class="label" for="status">Estado</label>
          <select
            id="status"
            name="status"
            class="input w-40"
            [(ngModel)]="status"
            (ngModelChange)="go(0)"
          >
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="INACTIVE">Inactivos</option>
          </select>
        </div>
        <button type="submit" class="btn-secondary">Pesquisar</button>
        @if (scopeLabel(); as label) {
          <p class="ml-auto text-sm text-muted" data-testid="scope-filter">
            Filtrado pelo âmbito: <strong class="text-fg">{{ label }}</strong>
          </p>
        }
      </form>
      <app-data-table
        [label]="k.title"
        [columns]="columns()"
        [rows]="page.value()?.items ?? []"
        [total]="page.value()?.total ?? 0"
        [loading]="page.loading()"
        [error]="page.error()"
        [sort]="sort()"
        [offset]="offset()"
        [limit]="limit"
        [emptyText]="q() || status() ? 'Sem registos com estes filtros.' : 'Ainda não há registos.'"
        [exportable]="true"
        [exporting]="exporting()"
        (sortChange)="onSort($event)"
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
export class OrganizationList {
  readonly kind = input.required<string>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  protected readonly meta = computed(() => ORG_KINDS[this.kind()] ?? null);
  protected readonly canManage = computed(() => this.workspace.can('organization.manage'));
  protected readonly limit = LIMIT;
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  protected readonly sort = signal<Sort | null>(null);
  protected readonly exporting = signal(false);
  private readonly names = signal<Map<string, string>>(new Map());
  private readonly scoped = computed(() => SCOPED_BY_ENTITY.has(this.kind()));
  protected readonly scopeLabel = computed(() => {
    if (!this.scoped() || !this.workspace.legalEntityId()) return null;
    const le = this.names().get(this.workspace.legalEntityId()!) ?? '…';
    const br = this.workspace.branchId() ? this.names().get(this.workspace.branchId()!) : null;
    return this.kind() === 'departments' && br ? `${le} · ${br}` : le;
  });
  protected readonly columns = computed<Column<OrgRecord>[]>(() => {
    const meta = this.meta();
    if (!meta) return [];
    return meta.columns.map((key, i) => ({
      key,
      label: meta.fields.find((f) => f.key === key)?.label ?? key,
      // Referências (ids de outros registos) não se ordenam pelo nome: o servidor ordenaria pelo id.
      sortable: !this.isRef(key),
      hideOnMobile: i > 2 && key !== 'status',
      link: i === 0 ? (r: OrgRecord) => ['/organizacao', meta.segment, r.id] : undefined,
      value: (r: OrgRecord) => this.cell(key, r[key]),
    }));
  });
  protected readonly page = new Loadable(() =>
    this.api.page<OrgRecord>(`organization/${this.kind()}`, this.query()),
  );

  constructor() {
    effect(() => {
      this.kind();
      untracked(() => {
        this.q.set('');
        this.status.set('');
        this.sort.set(null);
        this.offset.set(0);
        void this.loadNames();
      });
    });
    // Recarrega ao mudar de tipo ou de âmbito.
    effect(() => {
      this.kind();
      this.workspace.legalEntityId();
      this.workspace.branchId();
      untracked(() => {
        this.offset.set(0);
        void this.page.load();
      });
    });
  }

  private query() {
    const scope: Record<string, string | undefined> = {};
    if (this.scoped() && this.workspace.legalEntityId()) {
      scope['legalEntityId'] = this.workspace.legalEntityId()!;
      if (this.kind() === 'departments' && this.workspace.branchId())
        scope['branchId'] = this.workspace.branchId()!;
    }
    return {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      sort: this.sort()?.field,
      direction: this.sort()?.direction,
      ...scope,
      limit: LIMIT,
      offset: this.offset(),
    };
  }

  private async loadNames() {
    const map = new Map<string, string>();
    for (const ref of ['legal-entities', 'branches', 'departments', 'cost-centers']) {
      try {
        const page = await this.workspace.cached(`names:${ref}`, () =>
          this.api.page<OrgRecord>(`organization/${ref}`, { limit: 200 }),
        );
        for (const r of page.items) map.set(r.id, recordLabel(r));
      } catch {
        /* sem nomes: mostra-se "…" */
      }
    }
    this.names.set(map);
  }

  private isRef(key: string) {
    return this.meta()?.fields.find((f) => f.key === key)?.type === 'ref';
  }

  private cell(key: string, value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    if (this.isRef(key)) return this.names().get(value as string) ?? '…';
    if (key === 'type') return BRANCH_TYPES.find((t) => t.value === value)?.label ?? value;
    if (key.startsWith('valid')) return formatDate(value as string);
    return value;
  }

  protected onSort(sort: Sort) {
    this.sort.set(sort);
    this.go(0);
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async export() {
    this.exporting.set(true);
    try {
      const query = withoutPaging(this.query());
      const count = await exportList(
        this.api,
        `organization/${this.kind()}`,
        query,
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
