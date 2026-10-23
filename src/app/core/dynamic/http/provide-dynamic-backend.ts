import type { Provider } from '@angular/core';
import { DESIGNER_FIELD_TYPES } from '../designer-field-types';
import { CustomFieldGateway } from '../data-access/custom-field.gateway';
import { EntityDefinitionGateway } from '../data-access/entity-definition.gateway';
import { EntityRecordsGateway } from '../data-access/entity-records.gateway';
import { SERVER_FIELD_TYPES } from './dynamic-mapper';
import { HttpEntityDefinitionGateway } from './http-entity-definition.gateway';
import { HttpEntityRecordsGateway } from './http-entity-records.gateway';
import { UnavailableCustomFieldGateway } from './unavailable-custom-field.gateway';

/** Entidades dinâmicas e registos pela API real (C10); campos personalizados ainda sem servidor. */
export function provideDynamicBackend(): Provider[] {
  return [
    { provide: EntityDefinitionGateway, useClass: HttpEntityDefinitionGateway },
    { provide: EntityRecordsGateway, useClass: HttpEntityRecordsGateway },
    { provide: CustomFieldGateway, useClass: UnavailableCustomFieldGateway },
    // O designer só oferece como escolhíveis os tipos que o servidor guarda e valida.
    { provide: DESIGNER_FIELD_TYPES, useValue: SERVER_FIELD_TYPES },
  ];
}
