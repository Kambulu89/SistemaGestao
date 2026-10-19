import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ModuleRegistryService } from '../../../core/modules/module-registry.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-platform-dashboard',
  imports: [PageHeader, Card, Alert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Administração da plataforma"
      description="Gestão global do ecossistema SaaS: tenants, catálogo de módulos, planos e subscrições."
    />

    <app-alert title="Isto não é a administração de uma organização">
      Aqui gere-se a plataforma como um todo. Módulos activados, utilizadores e permissões de cada
      organização configuram-se na área do tenant.
    </app-alert>

    <h2 class="mb-3 mt-6 text-lg font-semibold">Catálogo</h2>
    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Indicadores do catálogo">
      @for (stat of catalog(); track stat.label) {
        <app-card [title]="stat.label">
          <p class="text-3xl font-semibold">{{ stat.value }}</p>
          <p class="mt-1 text-sm text-fg-muted">{{ stat.hint }}</p>
        </app-card>
      }
    </section>

    <h2 class="mb-3 mt-8 text-lg font-semibold">Monitorização</h2>
    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Indicadores de operação">
      @for (stat of operations; track stat.label) {
        <app-card [title]="stat.label">
          <p class="text-3xl font-semibold">{{ stat.value }}</p>
          <p class="mt-1 text-sm text-fg-muted">Valor de demonstração</p>
        </app-card>
      }
    </section>
  `,
})
export class PlatformDashboard {
  private readonly registry = inject(ModuleRegistryService);

  protected readonly catalog = computed(() => {
    const all = this.registry.modules;
    const foundation = all.filter((m) => m.kind === 'foundation').length;
    return [
      { label: 'Capacidades', value: all.length, hint: 'Registadas no catálogo' },
      { label: 'Módulos contratáveis', value: all.length - foundation, hint: 'Por tenant' },
      { label: 'Fundação', value: foundation, hint: 'Sempre activas' },
      { label: 'Grupos funcionais', value: this.registry.groups.length, hint: 'Categorias' },
    ];
  });

  protected readonly operations = [
    { label: 'Tenants activos', value: '27' },
    { label: 'Subscrições em teste', value: '6' },
    { label: 'Pagamentos em atraso', value: '2' },
  ];
}
