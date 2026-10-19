import { inject, Injectable } from '@angular/core';
import { type Observable } from 'rxjs';
import { EntityDefinitionGateway } from '../dynamic/data-access/entity-definition.gateway';
import type { EntityDefinition } from '../dynamic/models/entity-definition.model';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { mockError, respond } from './mock-helpers';
import { MOCK_ENTITY_DEFINITIONS } from './mock-entities';

/** O mock filtra por tenant como o backend faria, a partir do contexto do pedido. */
@Injectable()
export class MockEntityDefinitionGateway extends EntityDefinitionGateway {
  private readonly tenantContext = inject(TenantContextService);

  list(): Observable<readonly EntityDefinition[]> {
    return respond(() => {
      const tenantId = this.tenantContext.tenant()?.id;
      if (!tenantId) throw mockError(403, 'Sem tenant activo.');
      return MOCK_ENTITY_DEFINITIONS.filter((d) => d.scope === 'global' || d.tenantId === tenantId);
    });
  }
}
