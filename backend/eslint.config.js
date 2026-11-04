import { configApp } from '@adonisjs/eslint-config'

export default configApp({
  rules: {
    // Os repositórios usam SQL parametrizado e leem `(await trx.rawQuery(...)).rows`; a regra só obrigaria a variáveis
    // intermédias sem ganho de legibilidade.
    '@unicorn/no-await-expression-member': 'off',
  },
})
