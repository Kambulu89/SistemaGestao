import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AppConfigService } from '../../../core/config/app-config.service';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import type { ModuleAccessStatus, ModuleGroup } from '../../../core/modules/module.model';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import type { TenantStatus } from '../../../core/tenant-context/tenant.model';
import { Badge, type Tone } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Table, type TableColumn } from '../../../shared/ui/table/table';

const STATUS_UI: Record<TenantStatus, { label: string; tone: Tone }> = {
  active: { label: 'Activo', tone: 'success' },
  trial: { label: 'Teste', tone: 'brand' },
  suspended: { label: 'Suspenso', tone: 'danger' },
};

const ACCESS_UI: Record<ModuleAccessStatus, { label: string; tone: Tone }> = {
  accessible: { label: 'Acessível', tone: 'success' },
  'not-contracted': { label: 'Não contratado', tone: 'neutral' },
  inactive: { label: 'Desactivado no tenant', tone: 'warning' },
  'missing-dependency': { label: 'Dependência em falta', tone: 'warning' },
  'flag-disabled': { label: 'Funcionalidade desligada', tone: 'neutral' },
  forbidden: { label: 'Sem permissão', tone: 'danger' },
};

const GROUP_LABELS: Record<ModuleGroup, string> = {
  general: 'Geral',
  dynamic: 'Personalização',
  vertical: 'Vertical',
};

interface ModuleRow {
  readonly name: string;
  readonly group: string;
  readonly contracted: string;
  readonly active: string;
  readonly access: ModuleAccessStatus;
}

/** Painel do tenant: mostra a resolução módulo a módulo para o utilizador actual. */
@Component({
  selector: 'app-tenant-dashboard',
  imports: [PageHeader, Card, Badge, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      [title]="tenant()?.name ?? ''"
      description="Área de trabalho da organização. O menu lateral só mostra o que está contratado, activado, permitido e autorizado para si."
    />

    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Resumo da organização">
      <app-card title="Plano e estado">
        <p class="text-2xl font-semibold">{{ tenant()?.planName }}</p>
        @if (tenant(); as t) {
          <app-badge class="mt-2" [tone]="status(t.status).tone">{{
            status(t.status).label
          }}</app-badge>
        }
      </app-card>
      <app-card title="O meu papel">
        <p class="text-2xl font-semibold">{{ context()?.roleName }}</p>
        <p class="mt-1 text-sm text-fg-muted">
          {{ context()?.permissions?.length }} permissões atribuídas
        </p>
      </app-card>
      <app-card title="Preferências regionais">
        <p class="text-lg font-semibold">{{ config.locale() }} · {{ config.currency() }}</p>
        <p class="mt-1 text-sm text-fg-muted">{{ config.timeZone() }}</p>
      </app-card>
    </section>

    <h2 class="mb-3 mt-8 text-lg font-semibold">Módulos neste tenant</h2>
    <app-card [flush]="true">
      <app-table
        caption="Estado de cada módulo do catálogo neste tenant"
        [columns]="columns"
        [rows]="rows()"
      >
        <ng-template let-row let-column="column">
          @if (column.key === 'access') {
            <app-badge [tone]="access(row.access).tone">{{ access(row.access).label }}</app-badge>
          } @else {
            {{ row[column.key] }}
          }
        </ng-template>
      </app-table>
    </app-card>
  `,
})
export class TenantDashboard {
  private readonly tenantContext = inject(TenantContextService);
  private readonly registry = inject(ModuleRegistryService);
  protected readonly config = inject(AppConfigService);

  protected readonly tenant = this.tenantContext.tenant;
  protected readonly context = this.tenantContext.active;

  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Módulo' },
    { key: 'group', label: 'Grupo' },
    { key: 'contracted', label: 'Contratado' },
    { key: 'active', label: 'Activado' },
    { key: 'access', label: 'Resultado' },
  ];

  protected readonly rows = computed<readonly ModuleRow[]>(() => {
    const states = this.context()?.modules ?? [];
    return this.registry.resolved().map(({ manifest, access }) => {
      const state = states.find((s) => s.moduleId === manifest.id);
      return {
        name: manifest.name,
        group: GROUP_LABELS[manifest.group],
        contracted: state?.contracted ? 'Sim' : 'Não',
        active: state?.active ? 'Sim' : 'Não',
        access,
      };
    });
  });

  protected status(status: TenantStatus) {
    return STATUS_UI[status];
  }

  protected access(access: ModuleAccessStatus) {
    return ACCESS_UI[access];
  }
}
