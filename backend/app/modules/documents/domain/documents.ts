/**
 * Documentos e anexos (S01): regras puras, sem acesso a dados. O servidor decide a chave de armazenamento, o tipo real
 * do conteúdo e o estado do anexo; nada disto vem do cliente como verdade.
 */

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export const VISIBILITIES = ['PRIVATE', 'TENANT', 'RESOURCE'] as const
export type Visibility = (typeof VISIBILITIES)[number]

export const ATTACHMENT_STATUSES = [
  'PENDING',
  'QUARANTINED',
  'AVAILABLE',
  'REJECTED',
  'DELETED',
] as const
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number]

export const TEMPLATE_CHANNELS = ['DOCUMENT', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'] as const
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number]

export const TEMPLATE_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

/** Tamanho máximo por ficheiro (o limite do tenant é configurado à parte). */
export const HARD_MAX_FILE_BYTES = 100 * 1024 * 1024

export const CODE_PATTERN = /^[a-z][a-z0-9_]{1,59}$/
export const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/
export const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const OOXML_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

/** Tipos aceites e a forma como o conteúdo real é reconhecido. */
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip',
  ...OOXML_TYPES,
] as const

const startsWith = (head: Uint8Array, bytes: readonly number[], offset = 0): boolean =>
  head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b)

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

/** Tipo detectado pelos primeiros bytes (`null` quando não é um formato binário conhecido). */
export function sniffBinary(head: Uint8Array): string | null {
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
  return null
}

/** Texto: UTF-8 válido, sem bytes nulos nem controlo (além de tabulação, quebras de linha). */
export function looksLikeText(head: Uint8Array): boolean {
  for (const byte of head) {
    if (byte === 0) return false
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) return false
  }
  // O corte do buffer pode partir um carácter multi-byte no fim: ignora só uma sequência incompleta final.
  let end = head.length
  for (let i = head.length - 1; i >= Math.max(0, head.length - 3); i--) {
    const byte = head[i] as number
    if ((byte & 0xc0) === 0x80) continue
    if (byte >= 0xc2 && byte <= 0xf4) {
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
      if (head.length - i < needed) end = i
    }
    break
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, end))
    return true
  } catch {
    return false
  }
}

export type ContentVerdict =
  { ok: true; mimeType: string } | { ok: false; code: 'MIME_NOT_ALLOWED' | 'MIME_MISMATCH' }

/**
 * Compara o tipo declarado com o conteúdo real. Um `.exe` com `Content-Type: application/pdf` é recusado; um zip só
 * passa como zip ou como um dos formatos Office, que são zips.
 */
export function verifyContent(head: Uint8Array, declared: string): ContentVerdict {
  const type = declared.toLowerCase()
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: 'MIME_NOT_ALLOWED' }
  }
  if (type === 'text/plain' || type === 'text/csv') {
    return looksLikeText(head) ? { ok: true, mimeType: type } : { ok: false, code: 'MIME_MISMATCH' }
  }
  const detected = sniffBinary(head)
  if (!detected) return { ok: false, code: 'MIME_MISMATCH' }
  if (
    detected === 'application/zip' &&
    (type === 'application/zip' || OOXML_TYPES.includes(type))
  ) {
    return { ok: true, mimeType: type }
  }
  return detected === type ? { ok: true, mimeType: type } : { ok: false, code: 'MIME_MISMATCH' }
}

/** Nome apresentado: nunca é usado como caminho. Remove separadores, controlo e nomes vazios. */
export function sanitizeFileName(raw: string): string {
  const printable = [...raw].filter((c) => {
    const code = c.charCodeAt(0)
    return code > 31 && code !== 127
  })
  const cleaned = printable
    .join('')
    .replace(/[\\/]+/g, '_')
    .trim()
  const noDots = cleaned.replace(/^\.+/, '')
  return noDots.slice(0, 255)
}

export interface PrepareInput {
  fileName: string
  mimeType: string
  sizeBytes: number
  checksum: string
}

export function normalizePrepare(
  input: { fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown; checksum?: unknown },
  maxBytes: number
): { value?: PrepareInput; issues: Issue[] } {
  const issues: Issue[] = []
  const fileName = typeof input.fileName === 'string' ? sanitizeFileName(input.fileName) : ''
  if (!fileName) issues.push(issue('fileName', 'REQUIRED', 'Indique o nome do ficheiro.'))
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : ''
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    issues.push(issue('mimeType', 'MIME_NOT_ALLOWED', 'Tipo de ficheiro não permitido.'))
  }
  const sizeBytes = input.sizeBytes
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    issues.push(issue('sizeBytes', 'INVALID', 'Indique o tamanho em bytes (inteiro, mínimo 1).'))
  } else if (sizeBytes > maxBytes) {
    issues.push(
      issue('sizeBytes', 'FILE_TOO_LARGE', `O ficheiro excede o limite de ${maxBytes} bytes.`)
    )
  }
  const checksum = typeof input.checksum === 'string' ? input.checksum.trim().toLowerCase() : ''
  if (!SHA256_PATTERN.test(checksum)) {
    issues.push(issue('checksum', 'INVALID', 'Indique o SHA-256 do ficheiro (64 caracteres hex).'))
  }
  if (issues.length) return { issues }
  return {
    value: { fileName, mimeType, sizeBytes: sizeBytes as number, checksum },
    issues,
  }
}

export interface DocumentInput {
  title: string
  categoryCode: string
  visibility: Visibility
  resourceType: string | null
  resourceId: string | null
  retentionUntil: string | null
}

const isoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function normalizeDocument(
  input: {
    title?: unknown
    categoryCode?: unknown
    visibility?: unknown
    resourceType?: unknown
    resourceId?: unknown
    retentionUntil?: unknown
  },
  partial = false
): { value: Partial<DocumentInput>; issues: Issue[] } {
  const issues: Issue[] = []
  const value: Partial<DocumentInput> = {}
  if (input.title !== undefined || !partial) {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title || title.length > 200) {
      issues.push(issue('title', 'REQUIRED', 'Indique o título (até 200 caracteres).'))
    } else value.title = title
  }
  if (input.categoryCode !== undefined || !partial) {
    const code = typeof input.categoryCode === 'string' ? input.categoryCode.trim() : 'general'
    if (!CATEGORY_PATTERN.test(code)) {
      issues.push(issue('categoryCode', 'INVALID', 'Categoria inválida (a-z, 0-9 e _).'))
    } else value.categoryCode = code
  }
  if (input.visibility !== undefined || !partial) {
    const visibility = input.visibility ?? 'PRIVATE'
    if (!(VISIBILITIES as readonly unknown[]).includes(visibility)) {
      issues.push(issue('visibility', 'INVALID', 'Visibilidade inválida.'))
    } else value.visibility = visibility as Visibility
  }
  if (input.resourceType !== undefined || input.resourceId !== undefined || !partial) {
    const type = typeof input.resourceType === 'string' ? input.resourceType.trim() : null
    const id = typeof input.resourceId === 'string' ? input.resourceId.trim() : null
    if ((type === null) !== (id === null)) {
      issues.push(issue('resourceId', 'INCOMPLETE', 'Indique o tipo e o id do recurso, ou nenhum.'))
    } else if (id !== null && !UUID_PATTERN.test(id)) {
      issues.push(issue('resourceId', 'INVALID', 'O id do recurso tem de ser um UUID.'))
    } else {
      value.resourceType = type
      value.resourceId = id
    }
  }
  if (input.retentionUntil !== undefined) {
    if (input.retentionUntil === null) value.retentionUntil = null
    else if (typeof input.retentionUntil === 'string' && isoDate(input.retentionUntil)) {
      value.retentionUntil = input.retentionUntil
    } else
      issues.push(issue('retentionUntil', 'INVALID', 'Data de retenção inválida (AAAA-MM-DD).'))
  } else if (!partial) value.retentionUntil = null
  if (
    value.visibility === 'RESOURCE' &&
    (value.resourceType === null || value.resourceType === undefined)
  ) {
    issues.push(
      issue('resourceType', 'REQUIRED', 'Um documento de recurso tem de indicar o recurso.')
    )
  }
  return { value, issues }
}

// --- templates ---------------------------------------------------------------------------------------

export const VARIABLE_TYPES = ['string', 'number', 'date', 'decimal'] as const
export type VariableType = (typeof VARIABLE_TYPES)[number]

export interface VariableDef {
  name: string
  label: string
  type: VariableType
  required: boolean
}

export interface VariableSchema {
  variables: VariableDef[]
}

const VARIABLE_NAME = /^[a-z][A-Za-z0-9_]{0,59}$/
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g
export const MAX_VALUE_LENGTH = 2000
export const MAX_BODY_LENGTH = 50_000

export function normalizeSchema(raw: unknown): { value?: VariableSchema; issues: Issue[] } {
  const issues: Issue[] = []
  const list = (raw as { variables?: unknown } | null)?.variables
  if (!Array.isArray(list) || list.length > 100) {
    return {
      issues: [issue('variableSchema', 'INVALID', 'O esquema tem de listar até 100 variáveis.')],
    }
  }
  const seen = new Set<string>()
  const variables: VariableDef[] = []
  list.forEach((entry, index) => {
    const e = entry as Record<string, unknown>
    const path = `variableSchema.variables.${index}`
    const name = typeof e['name'] === 'string' ? e['name'] : ''
    if (!VARIABLE_NAME.test(name)) {
      issues.push(
        issue(`${path}.name`, 'INVALID', 'Nome de variável inválido (letras, números e _).')
      )
      return
    }
    if (seen.has(name)) {
      issues.push(issue(`${path}.name`, 'DUPLICATE', 'Variável repetida.'))
      return
    }
    seen.add(name)
    const type = e['type'] ?? 'string'
    if (!(VARIABLE_TYPES as readonly unknown[]).includes(type)) {
      issues.push(issue(`${path}.type`, 'INVALID', 'Tipo de variável inválido.'))
      return
    }
    const label = typeof e['label'] === 'string' && e['label'].trim() ? e['label'].trim() : name
    variables.push({
      name,
      label: label.slice(0, 120),
      type: type as VariableType,
      required: e['required'] === undefined ? true : e['required'] === true,
    })
  })
  return issues.length ? { issues } : { value: { variables }, issues }
}

/**
 * O corpo só admite `{{nome}}` de variáveis declaradas. Nada de funções, filtros, blocos, includes ou URLs: qualquer
 * outra coisa entre chaves duplas, ou chaves soltas, é um erro de sintaxe.
 */
export function validateTemplateBody(body: string, schema: VariableSchema): Issue[] {
  const issues: Issue[] = []
  if (!body.trim()) return [issue('body', 'REQUIRED', 'O corpo do modelo não pode ser vazio.')]
  if (body.length > MAX_BODY_LENGTH) {
    return [issue('body', 'TOO_LONG', `O corpo excede ${MAX_BODY_LENGTH} caracteres.`)]
  }
  const declared = new Set(schema.variables.map((v) => v.name))
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? '').trim()
    if (!VARIABLE_NAME.test(name)) {
      issues.push(issue('body', 'TEMPLATE_SYNTAX', `Expressão não permitida: {{${name}}}.`))
    } else if (!declared.has(name)) {
      issues.push(issue('body', 'TEMPLATE_UNKNOWN_VARIABLE', `Variável não declarada: ${name}.`))
    }
  }
  if (body.replace(PLACEHOLDER, '').match(/\{\{|\}\}/)) {
    issues.push(issue('body', 'TEMPLATE_SYNTAX', 'Há chaves duplas sem fecho ou sem variável.'))
  }
  return issues
}

const decimal = /^-?\d{1,15}(\.\d{1,6})?$/

export function validateValues(
  schema: VariableSchema,
  values: Record<string, unknown>
): { value?: Record<string, string>; issues: Issue[] } {
  const issues: Issue[] = []
  const out: Record<string, string> = {}
  for (const def of schema.variables) {
    const raw = values[def.name]
    const path = `variables.${def.name}`
    if (raw === undefined || raw === null || raw === '') {
      if (def.required) issues.push(issue(path, 'REQUIRED', `Falta a variável ${def.label}.`))
      else out[def.name] = ''
      continue
    }
    let text: string
    if (def.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        issues.push(issue(path, 'INVALID', `${def.label} tem de ser um número.`))
        continue
      }
      text = String(raw)
    } else if (typeof raw !== 'string') {
      issues.push(issue(path, 'INVALID', `${def.label} tem de ser texto.`))
      continue
    } else if (def.type === 'date' && !isoDate(raw)) {
      issues.push(issue(path, 'INVALID', `${def.label} tem de ser uma data AAAA-MM-DD.`))
      continue
    } else if (def.type === 'decimal' && !decimal.test(raw)) {
      issues.push(issue(path, 'INVALID', `${def.label} tem de ser um decimal.`))
      continue
    } else text = raw
    if (text.length > MAX_VALUE_LENGTH) {
      issues.push(issue(path, 'TOO_LONG', `${def.label} excede ${MAX_VALUE_LENGTH} caracteres.`))
      continue
    }
    out[def.name] = text
  }
  for (const key of Object.keys(values)) {
    if (!schema.variables.some((v) => v.name === key)) {
      issues.push(issue(`variables.${key}`, 'UNKNOWN', `Variável não declarada: ${key}.`))
    }
  }
  return issues.length ? { issues } : { value: out, issues }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * Substitui numa só passagem: um valor que contenha `{{x}}` fica literal (não se volta a interpretar). Em `html` os
 * valores e o texto do modelo saem escapados; em `text` só se limpam caracteres de controlo.
 */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
  mode: 'text' | 'html'
): string {
  let out = ''
  let last = 0
  for (const match of body.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0
    const literal = body.slice(last, index)
    out += mode === 'html' ? escapeHtml(literal) : literal
    const value = values[(match[1] ?? '').trim()] ?? ''
    out += mode === 'html' ? escapeHtml(value) : value.replace(CONTROL, '')
    last = index + match[0].length
  }
  const tail = body.slice(last)
  out += mode === 'html' ? escapeHtml(tail) : tail
  return mode === 'html' ? out : out.replace(CONTROL, '')
}
