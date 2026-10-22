import { defineConfig, drivers } from '@adonisjs/core/hash'

/**
 * Palavras-passe com scrypt (módulo `crypto` do Node, sem dependências nativas). Os parâmetros são
 * os recomendados pela OWASP para scrypt; o hash guardado inclui os parâmetros, por isso podem
 * subir no futuro sem invalidar as palavras-passe existentes.
 */
const hashConfig = defineConfig({
  default: 'scrypt',
  list: {
    scrypt: drivers.scrypt({
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
      maxMemory: 33554432,
    }),
  },
})

export default hashConfig

declare module '@adonisjs/core/types' {
  export interface HashersList extends InferHashers<typeof hashConfig> {}
}
