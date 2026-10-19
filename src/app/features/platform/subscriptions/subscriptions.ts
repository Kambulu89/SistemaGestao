import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-subscriptions',
  imports: [PageHeader, Card, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Subscrições"
      description="Ciclos de facturação e estado das subscrições."
    />
    <app-card>
      <app-empty-state
        icon="shield"
        title="Gestão de subscrições ainda não implementada"
        description="Esta secção será construída quando o contrato da API de facturação estiver definido."
      />
    </app-card>
  `,
})
export class Subscriptions {}
