import { defineConfig } from '@adonisjs/core/bodyparser'

const bodyParserConfig = defineConfig({
  allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],

  form: {
    convertEmptyStringsToNull: true,
    types: ['application/x-www-form-urlencoded'],
  },

  json: {
    convertEmptyStringsToNull: true,
    limit: '1mb',
    types: [
      'application/json',
      'application/json-patch+json',
      'application/vnd.api+json',
      'application/csp-report',
    ],
  },

  /** Uploads não passam pelo bodyparser: usam o fluxo prepare/complete (ver docs/architecture.md). */
  multipart: {
    autoProcess: false,
    processManually: [],
    limit: '1mb',
    types: ['multipart/form-data'],
  },
})

export default bodyParserConfig
