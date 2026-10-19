import { inject, Injectable } from '@angular/core';
import { type Observable } from 'rxjs';
import { CustomFieldGateway } from '../dynamic/data-access/custom-field.gateway';
import type { CustomFieldDefinition } from '../dynamic/models/custom-definition.model';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { mockError, respond } from './mock-helpers';
import { MockMetadataStore } from './mock-metadata-store';

/** O tenant vem do contexto do pedido; nunca se devolvem campos de outro tenant. */
@Injectable()
export class MockCustomFieldGateway extends CustomFieldGateway {
  private readonly tenantContext = inject(TenantContextService);
  private readonly store = inject(MockMetadataStore);

  list(): Observable<readonly CustomFieldDefinition[]> {
    return respond(() => {
      const tenantId = this.tenantContext.tenant()?.id;
      if (!tenantId) throw mockError(403, 'Sem tenant activo.');
      return this.store.customFieldsFor(tenantId);
    });
  }
}
