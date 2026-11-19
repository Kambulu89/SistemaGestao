/**
 * Gerador mínimo de PDF 1.4 (texto e linhas, fontes padrão Helvetica/Helvetica-Bold em WinAnsi). Sem dependências: o
 * suficiente para documentos administrativos (recibos, declarações). Coordenadas em pontos, origem no canto superior
 * esquerdo (convertidas para o referencial do PDF).
 */

/** Larguras Helvetica (1/1000 em) para alinhar à direita; caracteres em falta usam a média. */
const WIDTH: Record<string, number> = {
  ' ': 278,
  ',': 278,
  '.': 278,
  '-': 333,
  '/': 278,
  ':': 278,
  '%': 889,
  '(': 333,
  ')': 333,
  '0': 556,
  '1': 556,
  '2': 556,
  '3': 556,
  '4': 556,
  '5': 556,
  '6': 556,
  '7': 556,
  '8': 556,
  '9': 556,
}
const AVERAGE = 556
const BOLD_FACTOR = 1.04

/** Caracteres fora de Latin-1 com equivalente em WinAnsi (ou substituto legível). */
const WIN_ANSI: Record<string, number> = {
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
  '−': 0x2d,
  '\u202f': 0x20,
}

/** Texto → bytes WinAnsi, com os parênteses e a barra escapados para uma string literal do PDF. */
export function encodeText(text: string): Buffer {
  const out: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    const b = WIN_ANSI[ch] ?? (code < 256 ? code : 0x3f)
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c)
    out.push(b)
  }
  return Buffer.from(out)
}

export function textWidth(text: string, size: number, bold = false) {
  let w = 0
  for (const ch of text) w += WIDTH[ch] ?? AVERAGE
  return (w * size * (bold ? BOLD_FACTOR : 1)) / 1000
}

interface TextOptions {
  size?: number
  bold?: boolean
  align?: 'left' | 'right'
  gray?: boolean
}

export class SimplePdf {
  readonly width = 595.28
  readonly height = 841.89
  private pages: Buffer[][] = []

  constructor(private readonly title: string) {
    this.addPage()
  }

  addPage() {
    this.pages.push([])
  }

  private get current() {
    return this.pages[this.pages.length - 1]
  }

  private op(s: string | Buffer) {
    this.current.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : s)
  }

  /** Escreve texto; com `align: 'right'`, `x` é a margem direita. */
  text(x: number, y: number, text: string, o: TextOptions = {}) {
    const size = o.size ?? 10
    const px = o.align === 'right' ? x - textWidth(text, size, o.bold) : x
    const color = o.gray ? '0.35 g' : '0 g'
    this.op(
      `BT ${color} /${o.bold ? 'F2' : 'F1'} ${size} Tf ${px.toFixed(2)} ${(this.height - y).toFixed(2)} Td (`
    )
    this.op(encodeText(text))
    this.op(') Tj ET\n')
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5) {
    this.op(
      `${width} w 0.6 G ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S\n`
    )
  }

  toBuffer(): Buffer {
    const objects: Buffer[] = []
    const add = (body: Buffer | string) => {
      objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body)
      return objects.length
    }
    const catalog = add('') // reservado
    const pagesId = add('')
    const f1 = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
    )
    const f2 = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
    )
    const kids: number[] = []
    for (const ops of this.pages) {
      const content = Buffer.concat(ops)
      const contentId = add(
        Buffer.concat([
          Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'),
          content,
          Buffer.from('\nendstream', 'latin1'),
        ])
      )
      kids.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] ` +
            `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`
        )
      )
    }
    objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1')
    objects[pagesId - 1] = Buffer.from(
      `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
      'latin1'
    )
    const info = add(
      Buffer.concat([
        Buffer.from('<< /Title (', 'latin1'),
        encodeText(this.title),
        Buffer.from(') /Producer (Sistema de Gestao) >>', 'latin1'),
      ])
    )
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
    const offsets: number[] = []
    let length = parts[0].length
    objects.forEach((body, i) => {
      offsets.push(length)
      const chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
        body,
        Buffer.from('\nendobj\n', 'latin1'),
      ])
      parts.push(chunk)
      length += chunk.length
    })
    const xref =
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`
    parts.push(Buffer.from(xref, 'latin1'))
    return Buffer.concat(parts)
  }
}
