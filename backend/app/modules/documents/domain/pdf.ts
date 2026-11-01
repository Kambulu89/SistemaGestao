/**
 * Gerador de PDF mínimo e determinístico para texto (S01): A4, Helvetica, WinAnsi, quebra de linha e paginação, sem
 * dependências. Não faz tabelas, imagens nem estilos: é o documento emitido a partir de um modelo de texto. Dado o mesmo
 * texto e a mesma data de geração, os bytes são sempre os mesmos.
 */

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_X = 56
const MARGIN_TOP = 64
const MARGIN_BOTTOM = 64
const BODY_SIZE = 10.5
const TITLE_SIZE = 16
const LINE_HEIGHT = 14.5
const TITLE_LINE_HEIGHT = 22

// Larguras Helvetica (AFM) para 32..126, em milésimos de em.
const WIDTHS =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'
    .split(' ')
    .map(Number)

const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
}

/** Byte WinAnsi de um carácter (`?` quando não existe). */
function byteOf(char: string): number {
  const code = char.codePointAt(0) ?? 63
  if (code === 0x27) return 0x27
  if (code >= 32 && code <= 126) return code
  if (code >= 160 && code <= 255) return code
  return WIN_ANSI_EXTRA[char] ?? 63
}

function widthOf(char: string): number {
  const code = char.codePointAt(0) ?? 63
  if (code >= 32 && code <= 126) return WIDTHS[code - 32] ?? 556
  const base = char.normalize('NFD').charAt(0)
  const baseCode = base.codePointAt(0) ?? 63
  if (baseCode >= 32 && baseCode <= 126 && base !== char) return WIDTHS[baseCode - 32] ?? 556
  return 556
}

const textWidth = (text: string, size: number): number =>
  ([...text].reduce((sum, c) => sum + widthOf(c), 0) * size) / 1000

/** Texto → bytes WinAnsi escritos como literal PDF, só com ASCII (octais para o resto). */
function literal(text: string): string {
  let out = '('
  for (const char of text) {
    const byte = byteOf(char)
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`
    else if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte)
    else out += `\\${byte.toString(8).padStart(3, '0')}`
  }
  return `${out})`
}

/** Parte um parágrafo em linhas que cabem na largura (palavras longas partem-se). */
function wrap(paragraph: string, size: number, maxWidth: number): string[] {
  if (!paragraph.trim()) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    let piece = word
    while (textWidth(piece, size) > maxWidth) {
      let cut = piece.length
      while (cut > 1 && textWidth(piece.slice(0, cut), size) > maxWidth) cut--
      if (current) {
        lines.push(current)
        current = ''
      }
      lines.push(piece.slice(0, cut))
      piece = piece.slice(cut)
    }
    const candidate = current ? `${current} ${piece}` : piece
    if (textWidth(candidate, size) <= maxWidth) current = candidate
    else {
      lines.push(current)
      current = piece
    }
  }
  if (current) lines.push(current)
  return lines
}

export interface PdfInput {
  title: string
  body: string
  /** Fixa a data do documento nos metadados: parte do snapshot, não é «agora». */
  generatedAt: Date
}

const pdfDate = (date: Date): string =>
  `D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`

export function renderPdf(input: PdfInput): Buffer {
  const usable = PAGE_WIDTH - MARGIN_X * 2
  const pages: { lines: { y: number; text: string; size: number; font: 'F1' | 'F2' }[] }[] = [
    { lines: [] },
  ]
  let y = PAGE_HEIGHT - MARGIN_TOP
  const place = (text: string, size: number, font: 'F1' | 'F2', height: number) => {
    if (y - height < MARGIN_BOTTOM) {
      pages.push({ lines: [] })
      y = PAGE_HEIGHT - MARGIN_TOP
    }
    y -= height
    pages[pages.length - 1]?.lines.push({ y, text, size, font })
  }
  for (const line of wrap(input.title, TITLE_SIZE, usable)) {
    place(line, TITLE_SIZE, 'F2', TITLE_LINE_HEIGHT)
  }
  y -= 8
  for (const paragraph of input.body.replace(/\r\n?/g, '\n').split('\n')) {
    for (const line of wrap(paragraph, BODY_SIZE, usable)) place(line, BODY_SIZE, 'F1', LINE_HEIGHT)
  }

  // Objectos: 1 catálogo, 2 páginas, 3 e 4 fontes, 5 info; depois, por página, a página e o seu conteúdo.
  const chunks: string[] = []
  const offsets: number[] = []
  let length = 0
  const push = (text: string) => {
    chunks.push(text)
    length += text.length
  }
  const object = (id: number, content: string) => {
    offsets[id] = length
    push(`${id} 0 obj\n${content}\nendobj\n`)
  }

  push('%PDF-1.4\n%âãÏÓ\n')
  const total = pages.length
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`)
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  object(
    4,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  )
  object(
    5,
    `<< /Title ${literal(input.title.replace(/[^\x20-\x7e]/g, '?'))} /Producer (SistemaGestao) /CreationDate (${pdfDate(input.generatedAt)}) >>`
  )
  pages.forEach((page, index) => {
    const commands = page.lines.map(
      (l) => `BT /${l.font} ${l.size} Tf ${MARGIN_X} ${l.y.toFixed(2)} Td ${literal(l.text)} Tj ET`
    )
    const footer = `Página ${index + 1} de ${total}`
    commands.push(
      `BT /F1 8 Tf ${(PAGE_WIDTH / 2 - textWidth(footer, 8) / 2).toFixed(2)} 36 Td ${literal(footer)} Tj ET`
    )
    const stream = commands.join('\n')
    const pageId = 6 + index * 2
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`
    )
    object(pageId + 1, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  const count = 6 + total * 2
  const xrefAt = length
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  push(
    `${xref}trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  )
  return Buffer.from(chunks.join(''), 'latin1')
}
