import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { Dropdown } from '../ui/dropdown';
import { Icon } from '../ui/icon';

interface Option {
  id: string;
  code: string;
  name: string;
  legalEntityId?: string;
}

/**
 * Âmbito de trabalho (entidade legal e filial). Só aparece com `organization.read` e a funcionalidade `organization`.
 * É um filtro por omissão das listas e um valor por omissão nos formulários; a autorização continua a ser da API.
 */
@Component({
  selector: 'app-scope-selector',
  imports: [Dropdown, Icon],
  template: `
    @if (visible()) {
      <app-dropdown
        label="Âmbito de trabalho: entidade legal e filial"
        align="start"
        buttonClass="btn-ghost max-w-64"
        [closeOnSelect]="false"
      >
        <span trigger class="flex min-w-0 items-center gap-2" data-testid="scope">
          <app-icon name="layers" />
          <span class="truncate text-sm">{{ summary() }}</span>
          <app-icon name="chevronDown" [size]="14" />
        </span>
        <div class="w-72 space-y-3 p-2">
          <div>
            <label class="label" for="scope-le">Entidade legal</label>
            <select
              id="scope-le"
              class="input"
              data-menu-item
              [value]="workspace.legalEntityId() ?? ''"
              (change)="pickEntity($any($event.target).value)"
            >
              <option value="">Todas</option>
              @for (e of entities(); track e.id) {
                <option [value]="e.id">{{ e.code }} — {{ e.name }}</option>
              }
            </select>
          </div>
          <div>
            <label class="label" for="scope-br">Filial</label>
            <select
              id="scope-br"
              class="input"
              data-menu-item
              [disabled]="!workspace.legalEntityId()"
              [value]="workspace.branchId() ?? ''"
              (change)="pickBranch($any($event.target).value)"
            >
              <option value="">Todas</option>
              @for (b of branchesOfEntity(); track b.id) {
                <option [value]="b.id">{{ b.code }} — {{ b.name }}</option>
              }
            </select>
          </div>
          <p class="text-xs text-muted">
            Filtra as listas e preenche os formulários por omissão. Não altera permissões.
          </p>
        </div>
      </app-dropdown>
    }
  `,
})
export class ScopeSelector {
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly entities = signal<Option[]>([]);
  private readonly branches = signal<Option[]>([]);
  protected readonly visible = computed(
    () => this.workspace.can('organization.read') && this.workspace.has('organization'),
  );
  protected readonly branchesOfEntity = computed(() =>
    this.branches().filter((b) => b.legalEntityId === this.workspace.legalEntityId()),
  );
  protected readonly summary = computed(() => {
    const le = this.entities().find((e) => e.id === this.workspace.legalEntityId());
    const br = this.branches().find((b) => b.id === this.workspace.branchId());
    if (!le) return 'Todas as entidades';
    return br ? `${le.code} · ${br.code}` : le.code;
  });

  constructor() {
    effect(() => {
      const tenant = this.workspace.tenantId();
      const visible = this.visible();
      untracked(() => {
        this.entities.set([]);
        this.branches.set([]);
        if (tenant && visible) void this.load();
      });
    });
  }

  private async load() {
    const map = (r: Record<string, unknown>): Option => ({
      id: r['id'] as string,
      code: r['code'] as string,
      name: ((r['name'] ?? r['legalName']) as string) ?? '',
      legalEntityId: r['legalEntityId'] as string | undefined,
    });
    try {
      const [entities, branches] = await Promise.all([
        this.workspace.cached('scope:legal-entities', () =>
          this.api.page<Record<string, unknown>>('organization/legal-entities', {
            status: 'ACTIVE',
            limit: 200,
          }),
        ),
        this.workspace.cached('scope:branches', () =>
          this.api.page<Record<string, unknown>>('organization/branches', {
            status: 'ACTIVE',
            limit: 200,
          }),
        ),
      ]);
      this.entities.set(entities.items.map(map));
      this.branches.set(branches.items.map(map));
      // Um âmbito guardado que já não existe (ou foi inactivado) é esquecido.
      if (
        this.workspace.legalEntityId() &&
        !this.entities().some((e) => e.id === this.workspace.legalEntityId())
      )
        this.workspace.setScope(null);
    } catch {
      /* sem lista: o selector fica só com "Todas" */
    }
  }

  protected pickEntity(id: string) {
    this.workspace.setScope(id || null, null);
  }

  protected pickBranch(id: string) {
    this.workspace.setScope(this.workspace.legalEntityId(), id || null);
  }
}
