import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import {
  ACCESS_LABELS,
  FEATURE_LABELS,
  LIFECYCLE_LABELS,
} from '../../../core/modules/module-labels';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { TenantModulesService } from '../../../core/modules/tenant-modules.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Badge } from '../../../shared/ui/badge/badge';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

/**
 * Ecrã provisório de qualquer módulo sem rotas próprias. Mostra o que a plataforma já sabe
 * sobre ele neste tenant: dependências, funcionalidades, parâmetros e permissões.
 * Quando o módulo for implementado, declara `routes` no manifesto e deixa de passar por aqui.
 */
@Component({
  selector: 'app-module-scaffold',
  imports: [PageHeader, Card, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (resolved(); as r) {
      <app-page-header [title]="r.manifest.name" [description]="r.manifest.description">
        <div pageActions class="flex items-center gap-2">
          <app-badge [tone]="lifecycle().tone">{{ lifecycle().label }}</app-badge>
          <app-badge>v{{ r.manifest.version }}</app-badge>
        </div>
      </app-page-header>

      <app-card class="mb-6">
        <p class="text-sm">
          Este módulo está <strong>{{ access().label.toLowerCase() }}</strong> neste tenant, mas as
          suas funcionalidades de negócio ainda não foram implementadas. O que se segue é o que a
          arquitectura já resolve para ele.
        </p>
      </app-card>

      <div class="grid gap-4 lg:grid-cols-2">
        <app-card title="Dependências">
          @if (dependencies().length === 0) {
            <p class="text-sm text-fg-muted">Sem dependências.</p>
          } @else {
            <ul class="space-y-2 text-sm">
              @for (dep of dependencies(); track dep.id) {
                <li class="flex items-center justify-between gap-3">
                  <span>{{ dep.name }}</span>
                  <app-badge [tone]="dep.ready ? 'success' : 'warning'">{{
                    dep.ready ? 'Pronta' : 'Em falta'
                  }}</app-badge>
                </li>
              }
            </ul>
          }
        </app-card>

        <app-card title="Funcionalidades">
          @if (r.manifest.features.length === 0) {
            <p class="text-sm text-fg-muted">Sem funcionalidades opcionais.</p>
          } @else {
            <ul class="space-y-3 text-sm">
              @for (feature of r.manifest.features; track feature.id) {
                <li>
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-medium">{{ feature.name }}</span>
                    <app-badge [tone]="featureLabel(feature.id).tone">{{
                      featureLabel(feature.id).label
                    }}</app-badge>
                  </div>
                  <p class="text-fg-muted">{{ feature.description }}</p>
                </li>
              }
            </ul>
          }
        </app-card>

        <app-card title="Parâmetros do tenant">
          @if (r.manifest.settings.length === 0) {
            <p class="text-sm text-fg-muted">Sem parâmetros configuráveis.</p>
          } @else {
            <dl class="space-y-2 text-sm">
              @for (setting of r.manifest.settings; track setting.key) {
                <div class="flex justify-between gap-3">
                  <dt class="text-fg-muted">{{ setting.label }}</dt>
                  <dd class="font-medium">{{ settingValue(setting.key) }}</dd>
                </div>
              }
            </dl>
          }
        </app-card>

        <app-card title="Permissões do módulo">
          <ul class="space-y-2 text-sm">
            @for (permission of permissionRows(); track permission.key) {
              <li class="flex items-center justify-between gap-3">
                <span
                  ><code class="text-xs">{{ permission.key }}</code></span
                >
                <app-badge [tone]="permission.granted ? 'success' : 'neutral'">{{
                  permission.granted ? 'Concedida' : 'Não concedida'
                }}</app-badge>
              </li>
            }
          </ul>
        </app-card>
      </div>
    }
  `,
})
export class ModuleScaffold {
  private readonly registry = inject(ModuleRegistryService);
  private readonly modules = inject(TenantModulesService);
  private readonly permissions = inject(PermissionService);

  /** Vem de `data.moduleId` da rota do módulo (binding automático do router). */
  readonly moduleId = input.required<string>();

  protected readonly resolved = computed(() =>
    this.modules.resolved().find((m) => m.manifest.id === this.moduleId()),
  );
  protected readonly lifecycle = computed(
    () => LIFECYCLE_LABELS[this.resolved()?.manifest.lifecycle ?? 'planned'],
  );
  protected readonly access = computed(
    () => ACCESS_LABELS[this.resolved()?.access ?? 'accessible'],
  );

  protected readonly dependencies = computed(() =>
    (this.resolved()?.manifest.dependencies ?? []).map((id) => {
      const dependency = this.modules.resolved().find((m) => m.manifest.id === id);
      return {
        id,
        name: this.registry.find(id)?.name ?? id,
        ready: dependency ? dependency.contracted && dependency.active : true,
      };
    }),
  );

  protected readonly permissionRows = computed(() =>
    (this.resolved()?.manifest.permissions ?? []).map((p) => ({
      key: p.key,
      granted: this.permissions.can(p.key),
    })),
  );

  protected featureLabel(featureId: string) {
    return FEATURE_LABELS[this.modules.featureStatus(this.moduleId(), featureId)];
  }

  protected settingValue(key: string): string {
    const value = this.modules.settingValue(this.moduleId(), key);
    return typeof value === 'boolean' ? (value ? 'Sim' : 'Não') : String(value ?? '—');
  }
}
