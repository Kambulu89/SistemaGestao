import { InjectionToken } from '@angular/core';
import type { FieldType } from './models/field-definition.model';

/**
 * Tipos de campo que o designer oferece como disponíveis. `null` = todos os que o catálogo dá como
 * prontos. Na aplicação são os que o **servidor** guarda e valida (`SERVER_FIELD_TYPES`): os outros
 * aparecem como «em preparação» até terem backend.
 */
export const DESIGNER_FIELD_TYPES = new InjectionToken<ReadonlySet<FieldType> | null>(
  'DESIGNER_FIELD_TYPES',
  { providedIn: 'root', factory: () => null },
);
