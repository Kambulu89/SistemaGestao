import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Apresentação das entidades dinâmicas (C10), para a interface as mostrar sem inventar dados: nome no plural e
 * ícone da entidade; descrição, texto de ajuda e se o campo é pesquisável, filtrável e ordenável. É uma expansão
 * (colunas novas com valor por omissão): não altera registos nem versões já publicadas; os campos de versões
 * publicadas continuam imutáveis (a coluna nova faz parte da linha do campo).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      ALTER TABLE entity_definitions
        ADD COLUMN presentation jsonb NOT NULL DEFAULT '{}',
        ADD CONSTRAINT entity_definitions_presentation_check CHECK (jsonb_typeof(presentation) = 'object')
    `)
    this.schema.raw(`
      ALTER TABLE field_definitions
        ADD COLUMN presentation jsonb NOT NULL DEFAULT '{}',
        ADD CONSTRAINT field_definitions_presentation_check CHECK (jsonb_typeof(presentation) = 'object')
    `)
  }

  async down() {
    this.schema.raw(`ALTER TABLE field_definitions DROP COLUMN presentation`)
    this.schema.raw(`ALTER TABLE entity_definitions DROP COLUMN presentation`)
  }
}
