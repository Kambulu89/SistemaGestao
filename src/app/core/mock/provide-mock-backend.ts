import type { Provider } from '@angular/core';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import { EntityDefinitionGateway } from '../dynamic/data-access/entity-definition.gateway';
import { CustomFieldGateway } from '../dynamic/data-access/custom-field.gateway';
import { MockCustomFieldGateway } from './mock-custom-field.gateway';
import { MockMetadataStore } from './mock-metadata-store';
import { MockEntityRecordsGateway } from './mock-entity-records.gateway';
import { MockEntityDefinitionGateway } from './mock-entity-definition.gateway';

/**
 * DUPLOS DE TESTE do core dinâmico (entidades, campos personalizados e registos), sem servidor. A aplicação
 * usa `provideDynamicBackend()` (API real); isto só serve aos testes (`setupMockBackend`).
 */
export function provideMockBackend(): Provider[] {
  return [
    { provide: EntityDefinitionGateway, useClass: MockEntityDefinitionGateway },
    MockMetadataStore,
    { provide: CustomFieldGateway, useClass: MockCustomFieldGateway },
    { provide: EntityRecordsGateway, useClass: MockEntityRecordsGateway },
  ];
}
