import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-tenant-users',
  imports: [PageHeader, Card, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Utilizadores"
      description="Utilizadores, membros, perfis e permissões da organização."
    />
    <app-card>
      <app-empty-state
        icon="users"
        title="Ainda não implementado"
        description="Secção reservada. Será construída quando o contrato da API estiver definido."
      />
    </app-card>
  `,
})
export class TenantUsers {}
