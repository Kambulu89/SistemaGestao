import { SimplePdf } from '#shared/pdf/simple_pdf'

/**
 * Recibo de vencimento em PDF (7.9): empresa, colaborador, linhas do recibo (abonos e descontos), totais, encargos da
 * empresa, estado do pagamento e as regras usadas. Só texto: sem dados que não estejam no recibo fechado.
 */

export interface PayslipData {
  company: { legalName: string; taxId: string }
  employee: {
    code: string
    fullName: string
    taxId: string | null
    socialSecurityNumber: string | null
    position: string | null
    bankIban: string | null
  }
  run: { code: string; kindLabel: string; periodLabel: string; closedAt: string | null }
  currency: string
  lines: { name: string; kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER'; amount: string }[]
  totals: { gross: string; net: string; employerCost: string }
  bases: { inss: string | null; irt: string | null }
  payment: string
  rules: string | null
  generatedAt: string
}

/** Montante canónico ("1234.50") → "1 234,50". */
export function money(v: string) {
  const neg = v.startsWith('-')
  const [int, frac = ''] = v.replace('-', '').split('.')
  return `${neg ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${frac.padEnd(2, '0')}`
}

/** IBAN mascarado: só os últimos 4 caracteres. */
export function maskIban(iban: string | null) {
  if (!iban) return null
  const clean = iban.replace(/\s/g, '')
  return `${'•'.repeat(Math.max(0, clean.length - 4))}${clean.slice(-4)}`
}

export function payslipPdf(d: PayslipData): Buffer {
  const pdf = new SimplePdf(`Recibo ${d.run.code} ${d.employee.code}`)
  const L = 50
  const R = pdf.width - 50
  let y = 60
  pdf.text(L, y, d.company.legalName, { size: 14, bold: true })
  pdf.text(R, y, 'Recibo de vencimento', { size: 14, bold: true, align: 'right' })
  y += 16
  pdf.text(L, y, `NIF ${d.company.taxId}`, { size: 9, gray: true })
  pdf.text(R, y, `${d.run.kindLabel} · ${d.run.periodLabel}`, { size: 10, align: 'right' })
  y += 13
  pdf.text(R, y, `Lote ${d.run.code}`, { size: 9, gray: true, align: 'right' })
  y += 14
  pdf.line(L, y, R, y)
  y += 20

  const field = (x: number, label: string, value: string | null) => {
    pdf.text(x, y, label, { size: 8, gray: true })
    pdf.text(x, y + 12, value ?? '—', { size: 10 })
  }
  field(L, 'Colaborador', `${d.employee.code} — ${d.employee.fullName}`)
  field(320, 'Cargo', d.employee.position)
  y += 30
  field(L, 'NIF', d.employee.taxId)
  field(190, 'N.º de segurança social', d.employee.socialSecurityNumber)
  field(370, 'Conta (IBAN)', maskIban(d.employee.bankIban))
  y += 34
  pdf.line(L, y, R, y)
  y += 16

  const col = { earn: R - 110, ded: R }
  pdf.text(L, y, 'Descrição', { size: 9, bold: true })
  pdf.text(col.earn, y, 'Abonos', { size: 9, bold: true, align: 'right' })
  pdf.text(col.ded, y, 'Descontos', { size: 9, bold: true, align: 'right' })
  y += 6
  pdf.line(L, y, R, y)
  y += 14
  for (const l of d.lines.filter((x) => x.kind !== 'EMPLOYER')) {
    if (y > pdf.height - 160) {
      pdf.addPage()
      y = 60
    }
    pdf.text(L, y, l.name.slice(0, 70), { size: 10 })
    if (l.kind === 'EARNING') pdf.text(col.earn, y, money(l.amount), { size: 10, align: 'right' })
    else pdf.text(col.ded, y, money(l.amount), { size: 10, align: 'right' })
    y += 15
  }
  y += 2
  pdf.line(L, y, R, y)
  y += 16
  const deductions = d.lines
    .filter((l) => l.kind === 'DEDUCTION')
    .reduce(
      (a, l) =>
        a +
        BigInt(l.amount.replace('.', '').replace('-', '')) * (l.amount.startsWith('-') ? -1n : 1n),
      0n
    )
  const dedText = (() => {
    const s = (deductions < 0n ? -deductions : deductions).toString().padStart(3, '0')
    return `${deductions < 0n ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`
  })()
  pdf.text(L, y, 'Totais', { size: 10, bold: true })
  pdf.text(col.earn, y, money(d.totals.gross), { size: 10, bold: true, align: 'right' })
  pdf.text(col.ded, y, money(dedText), { size: 10, bold: true, align: 'right' })
  y += 22
  pdf.text(L, y, `Líquido a receber (${d.currency})`, { size: 12, bold: true })
  pdf.text(R, y, money(d.totals.net), { size: 12, bold: true, align: 'right' })
  y += 26

  pdf.text(L, y, 'Bases e encargos da empresa', { size: 9, bold: true })
  y += 14
  const info = [
    d.bases.inss ? `Base de INSS: ${money(d.bases.inss)}` : null,
    d.bases.irt ? `Base de IRT: ${money(d.bases.irt)}` : null,
    ...d.lines.filter((l) => l.kind === 'EMPLOYER').map((l) => `${l.name}: ${money(l.amount)}`),
    `Custo para a empresa: ${money(d.totals.employerCost)}`,
  ].filter(Boolean) as string[]
  for (const t of info) {
    pdf.text(L, y, t, { size: 9, gray: true })
    y += 12
  }
  y += 10
  pdf.text(L, y, `Pagamento: ${d.payment}`, { size: 10 })
  y += 14
  if (d.rules) {
    pdf.text(L, y, `Regras de cálculo: ${d.rules}`.slice(0, 110), { size: 8, gray: true })
    y += 11
  }
  pdf.text(
    L,
    pdf.height - 40,
    `Documento gerado em ${d.generatedAt}${d.run.closedAt ? ` · lote fechado em ${d.run.closedAt}` : ''}. Confidencial.`,
    { size: 8, gray: true }
  )
  return pdf.toBuffer()
}
