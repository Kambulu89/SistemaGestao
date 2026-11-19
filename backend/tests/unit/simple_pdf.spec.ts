import { test } from '@japa/runner'
import { encodeText, SimplePdf, textWidth } from '#shared/pdf/simple_pdf'
import { maskIban, money, payslipPdf } from '#modules/hr/application/payslip_pdf'

test.group('PDF mínimo e recibo', () => {
  test('texto em WinAnsi com escapes; larguras para alinhar', ({ assert }) => {
    assert.deepEqual([...encodeText('ç')], [0xe7])
    assert.deepEqual([...encodeText('—')], [0x97])
    assert.deepEqual([...encodeText('(a)\\')], [0x5c, 0x28, 0x61, 0x5c, 0x29, 0x5c, 0x5c])
    assert.deepEqual([...encodeText('漢')], [0x3f])
    assert.equal(textWidth('10', 10), 11.12)
  })

  test('estrutura do PDF: cabeçalho, objectos e tabela de referências coerente', ({ assert }) => {
    const pdf = new SimplePdf('Teste')
    pdf.text(50, 50, 'Olá, recibo')
    pdf.addPage()
    pdf.text(50, 50, 'Segunda página', { bold: true, align: 'right' })
    const buf = pdf.toBuffer()
    const s = buf.toString('latin1')
    assert.isTrue(s.startsWith('%PDF-1.4'))
    assert.isTrue(s.trimEnd().endsWith('%%EOF'))
    assert.include(s, '/Count 2')
    const start = Number(/startxref\n(\d+)/.exec(s)![1])
    assert.equal(s.slice(start, start + 4), 'xref')
    // Cada entrada da tabela aponta para "n 0 obj".
    const entries = s
      .slice(start)
      .split('\n')
      .slice(3)
      .filter((l) => / n $/.test(l))
    entries.forEach((line, i) => {
      const offset = Number(line.slice(0, 10))
      assert.equal(s.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`)
    })
    assert.include(s, 'Ol\xe1, recibo')
  })

  test('recibo: montantes formatados e IBAN mascarado', ({ assert }) => {
    assert.equal(money('184600.00'), '184 600,00')
    assert.equal(money('-1234.5'), '-1 234,50')
    assert.equal(maskIban('AO88 0040 0000 3514 2001 2345 6'), '•••••••••••••••••••••3456')
    assert.isNull(maskIban(null))
    const s = payslipPdf({
      company: { legalName: 'Empresa, Lda.', taxId: '5000000001' },
      employee: {
        code: 'C1',
        fullName: 'Ana',
        taxId: null,
        socialSecurityNumber: null,
        position: null,
        bankIban: null,
      },
      run: {
        code: 'PS-1',
        kindLabel: 'Processamento regular',
        periodLabel: 'outubro de 2026',
        closedAt: null,
      },
      currency: 'AOA',
      lines: [
        { name: 'Salário base', kind: 'EARNING', amount: '200000.00' },
        { name: 'IRT', kind: 'DEDUCTION', amount: '9400.00' },
        { name: 'INSS patronal', kind: 'EMPLOYER', amount: '16000.00' },
      ],
      totals: { gross: '200000.00', net: '190600.00', employerCost: '216000.00' },
      bases: { inss: '200000.00', irt: '194000.00' },
      payment: 'por pagar',
      rules: null,
      generatedAt: '09/11/2026',
    }).toString('latin1')
    for (const t of ['200 000,00', '9 400,00', '190 600,00', '216 000,00', 'Empresa, Lda.'])
      assert.include(s, t)
  })
})
