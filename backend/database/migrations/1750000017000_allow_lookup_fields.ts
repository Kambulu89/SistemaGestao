import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Valores relacionados (C10): LOOKUP passa a ser um tipo válido de campo. É uma expansão (a restrição só fica mais larga):
 * nenhum campo nem versão existente muda. A relação, o campo de origem e o que fazer se faltar vivem em `validation`; o valor nunca se guarda (lê-se do registo de origem).
 */
const TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DECIMAL',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'EMAIL',
  'PHONE',
  'URL',
  'SELECT',
  'RADIO',
  'MULTISELECT',
  'ENTITY_REFERENCE',
  'USER_REFERENCE',
  'FORMULA',
]

const list = (types: string[]) => types.map((t) => `'${t}'`).join(',')

export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE field_definitions
        DROP CONSTRAINT field_definitions_type_check,
        ADD CONSTRAINT field_definitions_type_check CHECK (field_type IN (${list([...TYPES, 'LOOKUP'])}))
    `)
  }

  async down() {
    this.schema.raw(`DELETE FROM field_definitions WHERE field_type = 'LOOKUP'`)
    this.schema.raw(`
      ALTER TABLE field_definitions
        DROP CONSTRAINT field_definitions_type_check,
        ADD CONSTRAINT field_definitions_type_check CHECK (field_type IN (${list(TYPES)}))
    `)
  }
}
