import { inject, Injectable } from '@angular/core';
import { type Observable } from 'rxjs';
import { EntityDefinitionGateway } from '../dynamic/data-access/entity-definition.gateway';
import type { EntityDefinition } from '../dynamic/models/entity-definition.model';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { mockError, respond } from './mock-helpers';
import { MockMetadataStore } from './mock-metadata-store';

/** O mock filtra por tenant como o backend faria, a partir do contexto do pedido. */
@Injectable()
export class MockEntityDefinitionGateway extends EntityDefinitionGateway {
  private readonly tenantContext = inject(TenantContextService);
  private readonly store = inject(MockMetadataStore);

  list(): Observable<readonly EntityDefinition[]> {
    return respond(() => {
      const tenantId = this.tenantContext.tenant()?.id;
      if (!tenantId) throw mockError(403, 'Sem tenant activo.');
      return this.store.definitionsFor(tenantId);
    });
  }
}
