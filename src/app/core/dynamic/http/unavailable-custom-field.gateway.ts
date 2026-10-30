import { type Observable, of, throwError } from 'rxjs';
import type { ApiError } from '../../api/api-error.model';
import { CustomFieldGateway } from '../data-access/custom-field.gateway';
import type { CustomFieldDefinition } from '../models/custom-definition.model';

const unavailable = (): Observable<never> =>
  throwError(
    () =>
      ({
        status: 501,
        message:
          'Os campos personalizados de entidades nativas ainda não existem no servidor (extensões de entidades).',
      }) satisfies ApiError,
  );

/**
 * Os campos personalizados estendem entidades nativas (`EntityExtension`), que dependem de módulos de
 * negócio que ainda não existem. Até lá não há nenhum e não se podem criar: nada é simulado.
 */
export class UnavailableCustomFieldGateway extends CustomFieldGateway {
  list(): Observable<readonly CustomFieldDefinition[]> {
    return of([]);
  }

  save(): Observable<CustomFieldDefinition> {
    return unavailable();
  }

  setState(): Observable<CustomFieldDefinition> {
    return unavailable();
  }
}
