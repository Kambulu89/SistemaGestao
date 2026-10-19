import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-plans',
  imports: [PageHeader, Card, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Planos"
      description="Planos, limites de utilização e módulos incluídos."
    />
    <app-card>
      <app-empty-state
        icon="card"
        title="Gestão de planos ainda não implementada"
        description="Esta secção será construída quando o contrato da API de planos estiver definido."
      />
    </app-card>
  `,
})
export class Plans {}
