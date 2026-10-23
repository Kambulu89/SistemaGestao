import type { Observable } from 'rxjs';
import type { EntityDefinition } from '../models/entity-definition.model';
import type { FieldDefinition } from '../models/field-definition.model';

/** Pedido para guardar o rascunho de uma entidade do tenant. O tenant vem do contexto. */
export interface SaveEntityDraftInput {
  /** Código técnico; imutável depois de a entidade existir. */
  readonly key: string;
  readonly names: EntityDefinition['names'];
  readonly description?: string;
  readonly icon: string;
  readonly fields: readonly FieldDefinition[];
  /** Versão do rascunho (ou da publicada, se ainda não há rascunho) que o cliente viu; `null` = nova. */
  readonly expectedVersion: number | null;
  /** Controlo de concorrência da entidade (`EntityDefinition.rowVersion`), quando o servidor o fornece. */
  readonly expectedRowVersion?: number;
}

/**
 * Contrato com o backend para definições de entidades. O servidor identifica o tenant pelo
 * contexto do pedido e devolve as definições globais e as desse tenant (todas as versões e estados).
 * Criar, publicar e descartar exigem a permissão de gestão e são validados no servidor.
 */
export abstract class EntityDefinitionGateway {
  abstract list(): Observable<readonly EntityDefinition[]>;
  /** Cria ou actualiza o rascunho (uma nova versão se só existir a publicada). */
  abstract saveDraft(input: SaveEntityDraftInput): Observable<EntityDefinition>;
  /** Publica o rascunho: valida a integridade e recusa alterações destrutivas. */
  abstract publish(key: string): Observable<EntityDefinition>;
  /** Descarta o rascunho; a versão publicada (se existir) mantém-se. */
  abstract discardDraft(key: string): Observable<void>;
}
