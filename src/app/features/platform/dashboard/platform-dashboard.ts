import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { errorMessage } from '../../../core/api/error-message';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { PLATFORM_PERMISSIONS } from '../../../core/permissions/permission.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { PlatformApi } from '../data-access/platform.api';

@Component({
  selector: 'app-platform-dashboard',
  imports: [PageHeader, Card, Alert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Administração da plataforma"
      description="Gestão global do ecossistema SaaS: tenants, planos e subscrições."
    />

    <app-alert title="Isto não é a administração de uma organização">
      Aqui gere-se a plataforma como um todo. Módulos activados, utilizadores e permissões de cada
      organização configuram-se na área do tenant, e esta área não dá acesso aos dados dessas
      organizações.
    </app-alert>

    @if (canTenants()) {
      <h2 class="mb-3 mt-6 text-lg font-semibold">Operação</h2>
      @if (tenants.error()) {
        <app-alert tone="danger" title="Não foi possível carregar os indicadores">{{
          loadError()
        }}</app-alert>
      } @else {
        <section
          class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Indicadores de operação"
        >
          @for (stat of operations(); track stat.label) {
            <app-card [title]="stat.label">
              <p class="text-3xl font-semibold">{{ stat.value }}</p>
              <p class="mt-1 text-sm text-fg-muted">{{ stat.hint }}</p>
            </app-card>
          }
        </section>
      }
    }

    <h2 class="mb-3 mt-8 text-lg font-semibold">Catálogo de capacidades (código)</h2>
    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Indicadores do catálogo">
      @for (stat of catalog(); track stat.label) {
        <app-card [title]="stat.label">
          <p class="text-3xl font-semibold">{{ stat.value }}</p>
          <p class="mt-1 text-sm text-fg-muted">{{ stat.hint }}</p>
        </app-card>
      }
    </section>
  `,
})
export class PlatformDashboard {
  private readonly registry = inject(ModuleRegistryService);
  private readonly api = inject(PlatformApi);
  private readonly permissions = inject(PermissionService);

  protected readonly canTenants = computed(() =>
    this.permissions.can(PLATFORM_PERMISSIONS.tenantsManage),
  );

  protected readonly tenants = rxResource({
    params: () => (this.canTenants() ? true : undefined),
    stream: () => this.api.listTenants(),
  });
  protected readonly loadError = computed(() => errorMessage(this.tenants.error()));

  protected readonly operations = computed(() => {
    const list = this.tenants.hasValue() ? this.tenants.value() : [];
    const count = (predicate: (t: (typeof list)[number]) => boolean) =>
      list.filter(predicate).length;
    return [
      {
        label: 'Tenants activos',
        value: count((t) => t.status === 'ACTIVE'),
        hint: `${list.length} no total`,
      },
      {
        label: 'Em preparação',
        value: count((t) => t.status === 'PROVISIONING'),
        hint: 'Provisionamento por concluir',
      },
      {
        label: 'Suspensos',
        value: count((t) => t.status === 'SUSPENDED'),
        hint: 'Sem operação empresarial',
      },
      {
        label: 'Subscrições em teste',
        value: count((t) => t.plan?.status === 'TRIAL'),
        hint: 'Período de teste',
      },
      {
        label: 'Pagamento em atraso',
        value: count((t) => t.plan?.status === 'PAST_DUE'),
        hint: 'Em período de tolerância',
      },
      {
        label: 'Sem plano',
        value: count((t) => t.plan === null),
        hint: 'Não admitem novos membros',
      },
    ];
  });

  protected readonly catalog = computed(() => {
    const all = this.registry.modules;
    const foundation = all.filter((m) => m.kind === 'foundation').length;
    return [
      { label: 'Capacidades', value: all.length, hint: 'Registadas no catálogo do frontend' },
      { label: 'Módulos contratáveis', value: all.length - foundation, hint: 'Por tenant' },
      { label: 'Fundação', value: foundation, hint: 'Sempre activas' },
      { label: 'Grupos funcionais', value: this.registry.groups.length, hint: 'Categorias' },
    ];
  });
}
