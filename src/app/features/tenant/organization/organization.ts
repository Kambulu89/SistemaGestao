import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';

@Component({
  selector: 'app-tenant-organization',
  imports: [PageHeader, Card, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Organização"
      description="Identidade, departamentos, filiais e unidades organizacionais."
    />
    <app-card>
      <app-empty-state
        icon="building"
        title="Ainda não implementado"
        description="Secção reservada. Será construída quando o contrato da API estiver definido."
      />
    </app-card>
  `,
})
export class TenantOrganization {}
