import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Expand: o assunto e a mensagem de uma campanha, para o serviço de notificações poder entregar o contacto (S02).
 * Colunas opcionais: as campanhas existentes ficam como estavam e uma campanha sem mensagem não é enviada.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('campaigns', (table) => {
      table.string('subject', 200).nullable()
      table.text('message').nullable()
    })
  }

  async down() {
    this.schema.alterTable('campaigns', (table) => {
      table.dropColumn('message')
      table.dropColumn('subject')
    })
  }
}
