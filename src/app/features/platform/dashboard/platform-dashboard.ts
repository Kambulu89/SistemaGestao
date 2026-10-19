import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Alert } from '../../../shared/ui/alert/alert';
import { Card } from '../../../shared/ui/card/card';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-platform-dashboard',
  imports: [PageHeader, Card, Alert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Administração da plataforma"
      description="Gestão global do ecossistema SaaS: tenants, planos, subscrições e catálogo de módulos."
    />

    <app-alert title="Isto não é a administração de uma organização">
      Aqui gere-se a plataforma como um todo. A configuração de utilizadores, módulos activados e
      permissões de cada organização faz-se na área do tenant.
    </app-alert>

    <section class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Indicadores">
      @for (stat of stats; track stat.label) {
        <app-card [title]="stat.label">
          <p class="text-3xl font-semibold">{{ stat.value }}</p>
          <p class="mt-1 text-sm text-fg-muted">Valor de demonstração</p>
        </app-card>
      }
    </section>
  `,
})
export class PlatformDashboard {
  protected readonly stats = [
    { label: 'Tenants activos', value: '27' },
    { label: 'Subscrições em teste', value: '6' },
    { label: 'Módulos no catálogo', value: '7' },
  ];
}
