import { Injectable } from '@angular/core';
import { mergeCustomFields } from '../dynamic/engine/custom-fields';
import { resolvePublished } from '../dynamic/engine/resolve-definitions';
import type { CustomFieldDefinition } from '../dynamic/models/custom-definition.model';
import type { EntityDefinition } from '../dynamic/models/entity-definition.model';
import { MOCK_CUSTOM_FIELDS } from './mock-custom-fields';
import { MOCK_ENTITY_DEFINITIONS } from './mock-entities';

/**
 * Metadados do "servidor" mock: definições de entidades e campos personalizados de todos os
 * tenants. É a fonte única que os gateways mock consultam, como seria a base de dados no backend.
 */
@Injectable()
export class MockMetadataStore {
  private readonly definitions: EntityDefinition[] = [...MOCK_ENTITY_DEFINITIONS];
  private readonly customFields: CustomFieldDefinition[] = [...MOCK_CUSTOM_FIELDS];

  /** Definições visíveis ao tenant (globais + próprias), sem campos personalizados fundidos. */
  definitionsFor(tenantId: string): readonly EntityDefinition[] {
    return this.definitions.filter((d) => d.scope === 'global' || d.tenantId === tenantId);
  }

  customFieldsFor(tenantId: string): readonly CustomFieldDefinition[] {
    return this.customFields.filter((c) => c.tenantId === tenantId);
  }

  /** Definições em vigor para o tenant, já com os seus campos personalizados activos. */
  effective(tenantId: string): EntityDefinition[] {
    const custom = this.customFieldsFor(tenantId);
    return resolvePublished(this.definitions, tenantId).map((d) =>
      mergeCustomFields(d, custom, tenantId),
    );
  }
}
