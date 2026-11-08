import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { Icon } from '../ui/icon';
import { StatusBadge } from '../ui/status-badge';
import { ToastService } from '../ui/toasts';
import { BRANCH_TYPES, ORG_KINDS, type OrgRecord, recordLabel, TREE_KINDS } from './org-kinds';
import { OrgTree } from './org-tree';
import { Tabs } from '../ui/tabs';

const LIMIT = 25;
/** Tipos que se filtram pela entidade legal / filial do âmbito de trabalho. */
const SCOPED_BY_ENTITY = new Set(['branches', 'departments', 'cost-centers']);

/**
 * Lista de uma entidade organizacional (EntityListPage): pesquisa, estado, ordenação e página na URL, âmbito de trabalho,
 * colunas configuráveis e exportação das colunas visíveis.
 */
@Component({
  selector: 'app-organization-list',
  imports: [
    RouterLink,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    StatusBadge,
    Icon,
    Tabs,
    OrgTree,
  ],
  template: `
    @if (meta(); as k) {
      <app-entity-list-page [title]="k.title" permission="organization.read" feature="organization">
        @if (canManage()) {
          <a actions class="btn-primary" [routerLink]="['/organizacao', k.segment, 'novo']"
            ><app-icon name="plus" [size]="16" />Criar {{ k.singular }}</a
          >
        }
        @if (hasTree()) {
          <app-tabs [tabs]="views" label="Vista" [(active)]="view" />
        }
        @if (view() === 'tree' && hasTree()) {
          <div role="tabpanel" id="panel-tree" aria-labelledby="tab-tree">
            <app-org-tree [kind]="k.segment" [label]="'Organograma: ' + k.title" />
          </div>
        } @else {
          <div role="tabpanel" id="panel-list" aria-labelledby="tab-list">
            <app-filter-bar
              id="org"
              [label]="k.title"
              placeholder="Código ou nome"
              [state]="list"
              [filters]="filters"
            >
              @if (scopeLabel(); as label) {
                <p class="ml-auto self-center text-sm text-muted" data-testid="scope-filter">
                  Filtrado pelo âmbito: <strong class="text-fg">{{ label }}</strong>
                </p>
              }
            </app-filter-bar>
            <app-data-table
              [label]="k.title"
              [tableId]="'org-' + k.segment"
              [columns]="columns()"
              [rows]="list.page.value()?.items ?? []"
              [total]="list.page.value()?.total ?? 0"
              [loading]="list.page.loading()"
              [error]="list.page.error()"
              [sort]="list.sort()"
              [offset]="list.offset()"
              [limit]="list.limit"
              [emptyText]="
                list.q() || list.activeFilters()
                  ? 'Sem registos com estes filtros.'
                  : 'Ainda não há registos.'
              "
              [exportable]="true"
              [exporting]="exporting()"
              (sortChange)="list.setSort($event)"
              (offsetChange)="list.goTo($event)"
              (retry)="list.reload()"
              (export)="export($event)"
            >
              <ng-template appCell="status" let-row
                ><app-status-badge [status]="row.status"
              /></ng-template>
            </app-data-table>
          </div>
        }
      </app-entity-list-page>
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
  protected readonly hasTree = computed(() => TREE_KINDS.has(this.kind()));
  protected readonly views = [
    { id: 'list', label: 'Lista' },
    { id: 'tree', label: 'Organograma' },
  ];
  protected readonly view = signal('list');
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: [
        { value: 'ACTIVE', label: 'Activos' },
        { value: 'INACTIVE', label: 'Inactivos' },
      ],
    },
  ];
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
      required: i === 0,
      link: i === 0 ? (r: OrgRecord) => ['/organizacao', meta.segment, r.id] : undefined,
      value: (r: OrgRecord) => this.cell(key, r[key]),
    }));
  });
  /** Pesquisa, estado, ordenação e página na URL; o âmbito de trabalho vai sempre (não fica na URL). */
  protected readonly list = new ListState<OrgRecord>(this.api, {
    url: () => `organization/${this.kind()}`,
    filterKeys: ['status'],
    sortFields: () =>
      this.columns()
        .filter((c) => c.sortable)
        .map((c) => c.key),
    limit: LIMIT,
    extra: () => this.scope(),
  });

  constructor() {
    effect(() => {
      this.kind();
      untracked(() => {
        this.view.set('list');
        void this.loadNames();
      });
    });
    // Recarrega ao mudar de tipo ou de âmbito.
    effect(() => {
      this.kind();
      this.workspace.legalEntityId();
      this.workspace.branchId();
      untracked(() => void this.list.reload());
    });
  }

  private scope() {
    const scope: Record<string, string | undefined> = {};
    if (this.scoped() && this.workspace.legalEntityId()) {
      scope['legalEntityId'] = this.workspace.legalEntityId()!;
      if (this.kind() === 'departments' && this.workspace.branchId())
        scope['branchId'] = this.workspace.branchId()!;
    }
    return scope;
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

  protected async export(columns: Column<OrgRecord>[]) {
    this.exporting.set(true);
    try {
      const query = withoutPaging(this.list.query());
      const count = await exportList(
        this.api,
        this.list.url(),
        query,
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
