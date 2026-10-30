import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Campos fórmula (C12): passam a ser um tipo válido de campo. É uma expansão (a restrição só fica mais larga):
 * nenhum campo nem versão existente muda. A fórmula (texto, árvore e dependências) vive em `validation`.
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
]

const list = (types: string[]) => types.map((t) => `'${t}'`).join(',')

export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE field_definitions
        DROP CONSTRAINT field_definitions_type_check,
        ADD CONSTRAINT field_definitions_type_check CHECK (field_type IN (${list([...TYPES, 'FORMULA'])}))
    `)
  }

  async down() {
    this.schema.raw(`DELETE FROM field_definitions WHERE field_type = 'FORMULA'`)
    this.schema.raw(`
      ALTER TABLE field_definitions
        DROP CONSTRAINT field_definitions_type_check,
        ADD CONSTRAINT field_definitions_type_check CHECK (field_type IN (${list(TYPES)}))
    `)
  }
}
