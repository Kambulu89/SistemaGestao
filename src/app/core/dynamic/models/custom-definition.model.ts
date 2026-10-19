import type { EntityDefinition } from './entity-definition.model';
import type { EntityRecord } from './entity-record.model';
import type { FieldDefinition, FieldValue } from './field-definition.model';

/**
 * Referência estável a uma entidade, independente do nome visível.
 * - `core`: entidade da plataforma (ex.: `customer`), extensível com campos personalizados.
 * - `custom`: entidade criada por um tenant (ex.: `vehicle`).
 * A `key` é o código técnico e não muda depois de a entidade ser publicada.
 */
export type EntityRef =
  | { readonly kind: 'core'; readonly key: string }
  | { readonly kind: 'custom'; readonly key: string };

/** Forma textual estável, para chaves de mapas e logs: `core:customer`. */
export const entityRefId = (ref: EntityRef): string => `${ref.kind}:${ref.key}`;

/** Referência de uma definição: global = nativa da plataforma; tenant = personalizada. */
export const entityRefOf = (entity: Pick<EntityDefinition, 'scope' | 'key'>): EntityRef => ({
  kind: entity.scope === 'global' ? 'core' : 'custom',
  key: entity.key,
});

/** Rasto de criação e alteração de uma definição. */
export interface DefinitionAudit {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * Entidade criada por um tenant: é uma `EntityDefinition` de âmbito `tenant`, sem estrutura
 * paralela. Os seus campos (`fields`) são os seus "custom fields".
 */
export type CustomEntityDefinition = EntityDefinition & {
  readonly scope: 'tenant';
  readonly tenantId: string;
};

/** Registo de uma entidade personalizada: o mesmo contrato de qualquer registo. */
export type CustomEntityRecord = EntityRecord;

/** Valor de um campo personalizado. */
export type CustomFieldValue = FieldValue;

/**
 * `draft`: em configuração, não aparece aos utilizadores. `active`: publicado. `archived`:
 * retirado de uso, mantém os dados.
 */
export type CustomFieldState = 'draft' | 'active' | 'archived';

/**
 * Campo que um tenant acrescenta a uma entidade nativa. O `field` é um `FieldDefinition` normal
 * (com `origin: 'custom'`): os renderers e motores tratam-no como qualquer outro campo depois de
 * o registo o fundir na definição da entidade.
 */
export interface CustomFieldDefinition {
  readonly id: string;
  /** O tenant proprietário. Um campo nunca é visível a outro tenant. */
  readonly tenantId: string;
  readonly entity: EntityRef;
  readonly field: FieldDefinition;
  /** Posição entre os campos personalizados (`display_order` em SQL, evita a palavra reservada). */
  readonly displayOrder: number;
  /** Mostra o campo como coluna da listagem. */
  readonly showInList: boolean;
  readonly state: CustomFieldState;
  /** Incrementa a cada alteração publicada. */
  readonly version: number;
  readonly audit: DefinitionAudit;
}
