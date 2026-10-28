import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { entityPermissionDefinitions } from '../../../core/dynamic/engine/entity-permissions';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { AccessSimulator } from './access-simulator';
import { PoliciesManager } from './policies-manager';
import { RolesManager } from './roles-manager';

type TabId = 'roles' | 'policies' | 'simulator' | 'catalog';

const TABS: readonly { id: TabId; label: string; needsIamRead: boolean }[] = [
  { id: 'roles', label: 'Perfis', needsIamRead: true },
  { id: 'policies', label: 'Políticas de acesso', needsIamRead: true },
  { id: 'simulator', label: 'Simulador', needsIamRead: true },
  { id: 'catalog', label: 'Catálogo de permissões', needsIamRead: false },
];

/** Catálogo de permissões declaradas pelos módulos e quais o seu perfil concede. */
@Component({
  selector: 'app-tenant-permissions-page',
  imports: [PageHeader, Card, Table, Badge, RolesManager, PoliciesManager, AccessSimulator],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Permissões"
      description="Perfis, políticas de acesso e simulação. O servidor decide sempre: o que aqui se mostra ou esconde é só conveniência."
    />

    <div class="mb-5 flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Acessos">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="-mb-px border-b-2 px-4 py-2 text-sm font-medium"
          [class.border-brand-600]="active() === tab.id"
          [class.text-brand-700]="active() === tab.id"
          [class.border-transparent]="active() !== tab.id"
          [class.text-fg-muted]="active() !== tab.id"
          [attr.aria-selected]="active() === tab.id"
          [attr.data-testid]="'tab-' + tab.id"
          (click)="selected.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>

    @switch (active()) {
      @case ('roles') {
        <app-roles-manager />
      }
      @case ('policies') {
        <app-policies-manager />
      }
      @case ('simulator') {
        <app-access-simulator />
      }
      @case ('catalog') {
        @for (group of allGroups(); track group.id) {
          <section class="mb-6" [attr.aria-label]="group.name">
            <h2 class="mb-2 text-base font-semibold">{{ group.name }}</h2>
            <app-card [flush]="true">
              <app-table
                [caption]="'Permissões do grupo ' + group.name"
                [columns]="columns"
                [rows]="group.rows"
              >
                <ng-template let-row let-column="column">
                  @switch (column.key) {
                    @case ('key') {
                      <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{
                        row.key
                      }}</code>
                    }
                    @case ('granted') {
                      <app-badge [tone]="row.granted ? 'success' : 'neutral'">{{
                        row.granted ? 'Concedida' : 'Não concedida'
                      }}</app-badge>
                    }
                    @default {
                      {{ row[column.key] }}
                    }
                  }
                </ng-template>
              </app-table>
            </app-card>
          </section>
        }
      }
    }
  `,
})
export class TenantPermissionsPage {
  private readonly registry = inject(ModuleRegistryService);
  private readonly entities = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  protected readonly tabs = computed(() =>
    TABS.filter((t) => !t.needsIamRead || this.permissions.can('iam.read')),
  );
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(
    () => this.selected() ?? this.tabs()[0]?.id ?? 'catalog',
  );

  protected readonly columns: readonly TableColumn[] = [
    { key: 'key', label: 'Permissão' },
    { key: 'name', label: 'Descrição' },
    { key: 'module', label: 'Módulo' },
    { key: 'granted', label: 'Estado' },
  ];

  protected readonly groups = computed(() =>
    this.registry.groups
      .map((group) => ({
        ...group,
        rows: this.registry.inGroup(group.id).flatMap((m) =>
          m.scope === 'tenant'
            ? m.permissions.map((p) => ({
                key: p.key,
                name: p.name,
                module: m.name,
                granted: this.permissions.can(p.key),
              }))
            : [],
        ),
      }))
      .filter((g) => g.rows.length > 0),
  );

  /** Permissões das entidades dinâmicas: as mesmas chaves do IAM, declaradas pelas definições. */
  protected readonly allGroups = computed(() => [...this.groups(), ...this.entityGroups()]);

  protected readonly entityGroups = computed(() =>
    this.entities.published().map((entity) => ({
      id: `entity-${entity.key}`,
      name: `Entidade: ${entity.names.plural}`,
      rows: entityPermissionDefinitions(entity).map((p) => ({
        key: p.key,
        name: p.name,
        module: 'Core Dinâmico',
        granted: this.permissions.can(p.key),
      })),
    })),
  );
}
