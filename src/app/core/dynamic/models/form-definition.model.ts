export type FormMode = 'create' | 'edit' | 'read';

export type FormColumns = 1 | 2 | 3 | 4;

/** Referência a um campo dentro de um formulário. */
export interface FormFieldItem {
  readonly kind: 'field';
  readonly field: string;
  /** Colunas que o campo ocupa na grelha (por omissão 1). */
  readonly span?: FormColumns;
}

/** Agrupamento visual de campos dentro de uma secção. */
export interface FormGroupItem {
  readonly kind: 'group';
  readonly title?: string;
  readonly columns?: FormColumns;
  readonly items: readonly FormFieldItem[];
}

export type FormItem = FormFieldItem | FormGroupItem;

export interface FormSection {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  /** Colunas da grelha em ecrãs largos; em ecrãs pequenos é sempre uma. */
  readonly columns: FormColumns;
  readonly items: readonly FormItem[];
}

/**
 * Estrutura visual de um formulário. A obrigatoriedade, visibilidade e edição vêm
 * dos campos; o formulário só decide organização e ordem.
 */
export interface FormDefinition {
  readonly key: string;
  readonly name: string;
  /** Modos em que este formulário é usado. */
  readonly modes: readonly FormMode[];
  readonly sections: readonly FormSection[];
}
