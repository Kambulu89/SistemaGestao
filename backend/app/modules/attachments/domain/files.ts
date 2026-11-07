/**
 * Tipos aceites, decididos pela extensão **e** confirmados pelo conteúdo (assinatura): o tipo enviado pelo cliente é
 * ignorado. Sem executáveis, HTML ou SVG (risco de script).
 */
interface FileType {
  contentType: string
  matches: (head: Buffer) => boolean
}

const startsWith = (head: Buffer, bytes: number[]) => bytes.every((b, i) => head[i] === b)
const ZIP = [0x50, 0x4b, 0x03, 0x04]
const isPlainText = (head: Buffer) => {
  if (head.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)))
    return true
  } catch {
    return false
  }
}

export const FILE_TYPES: Record<string, FileType> = {
  pdf: {
    contentType: 'application/pdf',
    matches: (h) => h.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  png: {
    contentType: 'image/png',
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  jpg: { contentType: 'image/jpeg', matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  jpeg: { contentType: 'image/jpeg', matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  webp: {
    contentType: 'image/webp',
    matches: (h) =>
      h.subarray(0, 4).toString('latin1') === 'RIFF' &&
      h.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  txt: { contentType: 'text/plain; charset=utf-8', matches: isPlainText },
  csv: { contentType: 'text/csv; charset=utf-8', matches: isPlainText },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (h) => startsWith(h, ZIP),
  },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: (h) => startsWith(h, ZIP),
  },
  odt: {
    contentType: 'application/vnd.oasis.opendocument.text',
    matches: (h) => startsWith(h, ZIP),
  },
  ods: {
    contentType: 'application/vnd.oasis.opendocument.spreadsheet',
    matches: (h) => startsWith(h, ZIP),
  },
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Nome apresentável: sem caminho, controlo nem separadores; até 200 caracteres, mantendo a extensão. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim()
  if (cleaned.length <= 200) return cleaned || 'ficheiro'
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 ? cleaned.slice(dot) : ''
  return cleaned.slice(0, 200 - ext.length) + ext
}

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
