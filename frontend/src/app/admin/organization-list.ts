import { Component, computed, inject, input, signal, effect, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { ErrorAlert } from '../ui/error-alert';
import { BRANCH_TYPES, ORG_KINDS, type OrgRecord, recordLabel } from './org-kinds';
import { Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { Pager } from '../ui/pager';
import { StatusBadge } from '../ui/status-badge';
import { formatDate } from '../ui/dates';

const LIMIT = 25;

/** Lista genérica de uma entidade organizacional: pesquisa, filtro por estado e paginação. */
@Component({
  selector: 'app-organization-list',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert, Pager, StatusBadge],
  template: `
    @if (meta(); as k) {
      <app-page-header [title]="k.title">
        @if (canManage()) {
          <a class="btn-primary" [routerLink]="['/organizacao', k.segment, 'novo']"
            >Nova {{ k.singular }}</a
          >
        }
      </app-page-header>
      <form class="mb-4 flex flex-wrap gap-2" (ngSubmit)="search()" role="search">
        <label class="sr-only" for="q">Pesquisar</label>
        <input
          id="q"
          name="q"
          class="input max-w-xs"
          placeholder="Código ou nome"
          [(ngModel)]="q"
        />
        <label class="sr-only" for="status">Estado</label>
        <select
          id="status"
          name="status"
          class="input w-40"
          [(ngModel)]="status"
          (ngModelChange)="search()"
        >
          <option value="">Todos os estados</option>
          <option value="ACTIVE">Activos</option>
          <option value="INACTIVE">Inactivos</option>
        </select>
        <button type="submit" class="btn-secondary">Pesquisar</button>
      </form>
      <app-error-alert [error]="page.error()" />
      @if (page.loading()) {
        <p class="text-sm text-slate-500">A carregar…</p>
      } @else if ((page.value()?.items ?? []).length === 0) {
        <p class="card text-sm text-slate-600">
          Sem registos{{ q() || status() ? ' com estes filtros' : '' }}.
        </p>
      } @else {
        <div class="card overflow-x-auto p-0">
          <table class="table" [attr.aria-label]="k.title">
            <thead>
              <tr>
                @for (c of k.columns; track c) {
                  <th>{{ columnLabel(c) }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of page.value()?.items; track r.id) {
                <tr class="hover:bg-slate-50">
                  @for (c of k.columns; track c; let first = $first) {
                    <td>
                      @if (first) {
                        <a class="btn-link" [routerLink]="['/organizacao', k.segment, r.id]">{{
                          r[c]
                        }}</a>
                      } @else if (c === 'status') {
                        <app-status-badge [status]="$any(r[c])" />
                      } @else {
                        {{ cell(c, r[c]) }}
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <app-pager
          [total]="page.value()?.total ?? 0"
          [limit]="limit"
          [offset]="offset()"
          (offsetChange)="go($event)"
        />
      }
    } @else {
      <p class="card">Tipo desconhecido.</p>
    }
  `,
})
export class OrganizationList {
  readonly kind = input.required<string>();
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly meta = computed(() => ORG_KINDS[this.kind()] ?? null);
  protected readonly canManage = computed(() => this.workspace.can('organization.manage'));
  protected readonly limit = LIMIT;
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  /** Nomes das entidades legais e pais, para mostrar em vez dos ids. */
  private readonly names = signal<Map<string, string>>(new Map());
  protected readonly page = new Loadable(() =>
    this.api.page<OrgRecord>(`organization/${this.kind()}`, {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      limit: LIMIT,
      offset: this.offset(),
    }),
  );

  constructor() {
    effect(() => {
      const kind = this.kind();
      untracked(() => {
        this.q.set('');
        this.status.set('');
        this.offset.set(0);
        void this.page.load();
        void this.loadNames(kind);
      });
    });
  }

  private async loadNames(kind: string) {
    const refs = new Set(
      (ORG_KINDS[kind]?.fields ?? [])
        .filter((f) => f.ref && ORG_KINDS[kind].columns.includes(f.key))
        .map((f) => f.ref!),
    );
    const map = new Map<string, string>();
    for (const ref of refs) {
      try {
        const page = await this.api.page<OrgRecord>(`organization/${ref}`, { limit: 200 });
        for (const r of page.items) map.set(r.id, recordLabel(r));
      } catch {
        /* sem nomes: mostra-se o código do registo */
      }
    }
    this.names.set(map);
  }

  protected columnLabel(key: string) {
    return this.meta()?.fields.find((f) => f.key === key)?.label ?? key;
  }

  protected cell(key: string, value: unknown) {
    if (value === null || value === undefined || value === '') return '—';
    if (key.endsWith('Id')) return this.names().get(value as string) ?? '…';
    if (key === 'type') return BRANCH_TYPES.find((t) => t.value === value)?.label ?? value;
    if (key.startsWith('valid')) return formatDate(value as string);
    return value;
  }

  protected search() {
    this.go(0);
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }
}
