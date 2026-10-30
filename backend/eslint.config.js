import { configApp } from '@adonisjs/eslint-config'

export default configApp({
  files: ['tests/**/*.ts'],
  rules: {
    // Nos testes, `(await client.get(...)).assertStatus(...)` é a forma legível de afirmar uma resposta.
    '@unicorn/no-await-expression-member': 'off',
  },
})
