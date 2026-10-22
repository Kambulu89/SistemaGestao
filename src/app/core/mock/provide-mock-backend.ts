import type { Provider } from '@angular/core';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import { EntityDefinitionGateway } from '../dynamic/data-access/entity-definition.gateway';
import { CustomFieldGateway } from '../dynamic/data-access/custom-field.gateway';
import { MockCustomFieldGateway } from './mock-custom-field.gateway';
import { MockMetadataStore } from './mock-metadata-store';
import { MockEntityRecordsGateway } from './mock-entity-records.gateway';
import { MockEntityDefinitionGateway } from './mock-entity-definition.gateway';

/**
 * AINDA MOCK: entidades dinâmicas, campos personalizados e registos (Fase 2+; não há backend para
 * C10–C15). A identidade e os tenants já são HTTP (`HttpAuthGateway`, `HttpTenantGateway`).
 */
export function provideMockBackend(): Provider[] {
  return [
    { provide: EntityDefinitionGateway, useClass: MockEntityDefinitionGateway },
    MockMetadataStore,
    { provide: CustomFieldGateway, useClass: MockCustomFieldGateway },
    { provide: EntityRecordsGateway, useClass: MockEntityRecordsGateway },
  ];
}
