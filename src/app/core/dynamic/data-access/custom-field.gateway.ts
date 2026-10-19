import type { Observable } from 'rxjs';
import type { DefinitionIssue } from '../engine/definition-integrity';
import type { CustomFieldDefinition, EntityRef } from '../models/custom-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';

/** Pedido para criar (`id: null`) ou alterar um campo personalizado. O tenant vem do contexto. */
export interface SaveCustomFieldInput {
  readonly id: string | null;
  readonly entity: EntityRef;
  readonly field: FieldDefinition;
  readonly showInList: boolean;
  readonly displayOrder?: number;
  /** `draft` guarda sem publicar; `active` publica. */
  readonly state: 'draft' | 'active';
  /** Versão que o cliente viu; o servidor recusa se entretanto mudou (409). */
  readonly expectedVersion: number | null;
}

/** Detalhe de um 422: problemas da definição (o servidor é a autoridade). */
export interface DefinitionFailure {
  readonly issues: readonly DefinitionIssue[];
}

/**
 * Contrato com o backend para os campos personalizados do tenant (de todos os estados).
 * O servidor identifica o tenant pelo contexto do pedido; um tenant nunca recebe campos de outro.
 * Guardar exige a permissão de gestão dos formulários e valida a definição no servidor.
 */
export abstract class CustomFieldGateway {
  abstract list(): Observable<readonly CustomFieldDefinition[]>;
  abstract save(input: SaveCustomFieldInput): Observable<CustomFieldDefinition>;
  /** Arquiva ou reactiva um campo (os dados nunca são apagados). */
  abstract setState(id: string, state: 'active' | 'archived'): Observable<CustomFieldDefinition>;
}
