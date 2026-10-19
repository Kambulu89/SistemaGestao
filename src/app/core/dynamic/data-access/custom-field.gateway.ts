import type { Observable } from 'rxjs';
import type { CustomFieldDefinition } from '../models/custom-definition.model';

/**
 * Contrato com o backend para os campos personalizados do tenant (de todos os estados).
 * O servidor identifica o tenant pelo contexto do pedido; um tenant nunca recebe campos de outro.
 */
export abstract class CustomFieldGateway {
  abstract list(): Observable<readonly CustomFieldDefinition[]>;
}
