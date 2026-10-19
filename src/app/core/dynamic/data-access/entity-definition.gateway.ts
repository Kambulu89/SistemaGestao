import type { Observable } from 'rxjs';
import type { EntityDefinition } from '../models/entity-definition.model';

/**
 * Contrato com o backend para definições de entidades. O servidor identifica o tenant pelo
 * contexto do pedido e devolve as definições globais e as desse tenant (todas as versões e estados).
 */
export abstract class EntityDefinitionGateway {
  abstract list(): Observable<readonly EntityDefinition[]>;
}
