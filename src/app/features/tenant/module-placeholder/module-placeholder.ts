import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

/**
 * Destino temporário de qualquer módulo do catálogo. Quando um módulo for implementado,
 * ganha as suas próprias rotas em `features/business|dynamic|verticals` e deixa de passar por aqui.
 */
@Component({
  selector: 'app-module-placeholder',
  imports: [PageHeader, Card, EmptyState, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (manifest(); as m) {
      <app-page-header [title]="m.name" [description]="m.description" />
      <app-card>
        <app-empty-state
          [icon]="m.icon"
          title="Módulo ainda não implementado"
          description="O módulo está contratado, activado e autorizado para si; falta apenas construí-lo."
        >
          @if (sections().length > 0) {
            <ul class="flex flex-wrap justify-center gap-2" aria-label="Secções previstas">
              @for (section of sections(); track section.path) {
                <li>
                  <a
                    [routerLink]="['/t', slug(), 'modules', m.id, section.path]"
                    class="inline-flex rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-muted"
                  >
                    {{ section.label }}
                  </a>
                </li>
              }
            </ul>
          }
        </app-empty-state>
      </app-card>
    }
  `,
})
export class ModulePlaceholder {
  private readonly registry = inject(ModuleRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  /** Parâmetros da rota (binding automático). */
  readonly moduleId = input.required<string>();
  readonly section = input<string>();

  protected readonly slug = computed(() => this.tenant()?.slug ?? '');
  protected readonly manifest = computed(() => this.registry.find(this.moduleId()));
  protected readonly sections = computed(() =>
    (this.manifest()?.routes ?? []).filter(
      (r) => !r.permission || this.permissions.can(r.permission),
    ),
  );
}
