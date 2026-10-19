import type { Condition } from './condition.model';
import type { DefinitionAudit } from './custom-definition.model';
import type { DefinitionState } from './entity-definition.model';
import type { ValidationRule } from './validation-rule.model';

/**
 * Onde o formulário é usado. `read` é o contexto de consulta («view»): o mesmo formulário
 * apresentado só para leitura.
 */
export type FormMode = 'create' | 'edit' | 'read';

export type FormColumns = 1 | 2 | 3 | 4;

/**
 * Valores por omissão permitidos num formulário. É uma lista fechada de *resolvers*:
 * nunca há expressões arbitrárias nem código do tenant.
 */
export type DefaultValueSpec =
  | { readonly kind: 'fixed'; readonly value: string | number | boolean | readonly string[] }
  | { readonly kind: 'today' }
  | { readonly kind: 'now' }
  | { readonly kind: 'currentUser'; readonly as: 'id' | 'name' | 'email' }
  | { readonly kind: 'currentTenant'; readonly as: 'id' | 'name' };

/**
 * `FormFieldConfiguration`: como um campo aparece **neste** formulário. O `FieldDefinition` (o
 * contrato de dados) é referido por `field`, o identificador estável; tudo o resto é apresentação.
 *
 * Um formulário só pode **restringir** o campo, nunca relaxá-lo: o que a entidade exige (obrigatório,
 * escondido, só de leitura, validações) continua a valer. Ver `applyFormConfiguration`.
 */
export interface FormFieldItem {
  readonly kind: 'field';
  /** Chave estável do campo (nunca o rótulo). */
  readonly field: string;
  /** Colunas que o campo ocupa na grelha (por omissão 1). É a «largura». */
  readonly span?: FormColumns;
  /** Substituem os do campo, só neste formulário. */
  readonly label?: string;
  readonly placeholder?: string;
  readonly help?: string;
  /** `false` esconde o campo neste formulário; `true`/ausente não o mostra se a entidade o esconde. */
  readonly visible?: boolean;
  /** `false` torna-o só de leitura neste formulário. */
  readonly editable?: boolean;
  /** `true` exige-o neste formulário; `false` não relaxa um campo obrigatório na entidade. */
  readonly required?: boolean;
  /** Condições que se juntam (AND, ou OR no caso da obrigatoriedade) às do campo. */
  readonly visibleWhen?: Condition;
  readonly editableWhen?: Condition;
  readonly requiredWhen?: Condition;
  /** Valor inicial na criação (e, com `defaultWhen`, quando a condição passa a verificar-se). */
  readonly defaultValue?: DefaultValueSpec;
  readonly defaultWhen?: Condition;
  /** Regras adicionais; só podem apertar (min, max, comprimentos, padrão, email). */
  readonly validations?: readonly ValidationRule[];
}

/** Alias que torna explícita a distinção entre `FieldDefinition` e a sua utilização. */
export type FormFieldConfiguration = FormFieldItem;

/** Agrupamento visual de campos dentro de uma secção. */
export interface FormGroupItem {
  readonly kind: 'group';
  readonly title?: string;
  readonly columns?: FormColumns;
  readonly items: readonly FormFieldItem[];
}

export type FormItem = FormFieldItem | FormGroupItem;

/**
 * Secção de um formulário. A ordem é a posição no array (única fonte de verdade).
 * Hoje há secções empilhadas; `FormLayout` prepara separadores, acordeões e assistentes.
 */
export interface FormSection {
  /** Identificador estável da secção dentro do formulário. */
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  /** Colunas da grelha em ecrãs largos; em ecrãs pequenos é sempre uma. */
  readonly columns: FormColumns;
  /** Pode recolher-se (por omissão não). */
  readonly collapsible?: boolean;
  /** Estado inicial quando é recolhível. */
  readonly collapsed?: boolean;
  /** Esconde a secção (e valida os seus campos como escondidos) quando a condição falha. */
  readonly visibleWhen?: Condition;
  readonly items: readonly FormItem[];
}

/** Forma de organizar as secções. Só `sections` está implementada; os outros reservam o contrato. */
export interface FormLayout {
  readonly kind: 'sections';
}

export type FormScope = 'global' | 'tenant';

/**
 * Estrutura visual de um formulário de uma entidade. A entidade pode ter vários (cadastro
 * simplificado, completo, edição, consulta…) que reutilizam os mesmos campos.
 *
 * Os formulários embutidos numa `EntityDefinition` só usam `key`, `name`, `modes` e `sections`.
 * Os geridos pelo Form Builder têm também o ciclo de vida (`ManagedFormDefinition`).
 */
export interface FormDefinition {
  /** Código estável do formulário dentro da entidade. */
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  /** Modos em que este formulário é usado. */
  readonly modes: readonly FormMode[];
  /** É o formulário usado por omissão nos seus modos (quando há vários). */
  readonly isDefault?: boolean;
  readonly layout?: FormLayout;
  readonly sections: readonly FormSection[];

  // --- ciclo de vida (formulários geridos)
  readonly id?: string;
  readonly entityKey?: string;
  readonly scope?: FormScope;
  /** `null` nos formulários globais. */
  readonly tenantId?: string | null;
  readonly version?: number;
  readonly state?: DefinitionState;
  /** Formulário global de que este é uma cópia personalizada (sem herança dinâmica). */
  readonly basedOn?: { readonly key: string; readonly version: number };
  readonly publishedAt?: string;
  readonly meta?: DefinitionAudit;
}

/** Formulário gerido pelo Form Registry: tem sempre identidade, âmbito, versão e estado. */
export type ManagedFormDefinition = FormDefinition &
  Required<Pick<FormDefinition, 'id' | 'entityKey' | 'scope' | 'tenantId' | 'version' | 'state'>>;
