import type { Provider } from '@angular/core';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import { EntityDefinitionGateway } from '../dynamic/data-access/entity-definition.gateway';
import { AuthGateway } from '../auth/auth.gateway';
import { TenantGateway } from '../tenant-context/tenant.gateway';
import { MockAuthGateway } from './mock-auth.gateway';
import { CustomFieldGateway } from '../dynamic/data-access/custom-field.gateway';
import { MockCustomFieldGateway } from './mock-custom-field.gateway';
import { MockMetadataStore } from './mock-metadata-store';
import { MockEntityRecordsGateway } from './mock-entity-records.gateway';
import { MockEntityDefinitionGateway } from './mock-entity-definition.gateway';
import { MockTenantGateway } from './mock-tenant.gateway';

/** Liga os contratos do core aos adapters mock. Substituir por adapters HTTP quando houver API. */
export function provideMockBackend(): Provider[] {
  return [
    { provide: AuthGateway, useClass: MockAuthGateway },
    { provide: TenantGateway, useClass: MockTenantGateway },
    { provide: EntityDefinitionGateway, useClass: MockEntityDefinitionGateway },
    MockMetadataStore,
    { provide: CustomFieldGateway, useClass: MockCustomFieldGateway },
    { provide: EntityRecordsGateway, useClass: MockEntityRecordsGateway },
  ];
}
