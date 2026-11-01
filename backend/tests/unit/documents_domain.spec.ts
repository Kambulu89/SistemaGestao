import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from '@japa/runner'
import {
  escapeHtml,
  looksLikeText,
  normalizeDocument,
  normalizePrepare,
  normalizeSchema,
  renderTemplate,
  sanitizeFileName,
  sniffBinary,
  validateTemplateBody,
  validateValues,
  verifyContent,
} from '#modules/documents/domain/documents'
import { renderPdf } from '#modules/documents/domain/pdf'
import { StorageLimitError } from '#modules/documents/application/ports'
import { HmacUrlSigner } from '#modules/documents/infrastructure/hmac_signer'
import { LocalObjectStorage } from '#modules/documents/infrastructure/local_storage'
import { EICAR, SignatureScanner } from '#modules/documents/infrastructure/signature_scanner'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PDF = new TextEncoder().encode('%PDF-1.4\n')
const bytes = (text: string) => new TextEncoder().encode(text)

test.group('documentos | tipo real do conteúdo', () => {
  test('reconhece formatos binários pelos primeiros bytes', ({ assert }) => {
    assert.equal(sniffBinary(PDF), 'application/pdf')
    assert.equal(sniffBinary(PNG), 'image/png')
    assert.equal(sniffBinary(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.equal(sniffBinary(bytes('GIF89a....')), 'image/gif')
    assert.equal(sniffBinary(bytes('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
    assert.equal(sniffBinary(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), 'application/zip')
    assert.isNull(sniffBinary(bytes('MZ executável')))
  })

  test('o tipo declarado tem de coincidir com o conteúdo', ({ assert }) => {
    assert.deepEqual(verifyContent(PDF, 'application/pdf'), {
      ok: true,
      mimeType: 'application/pdf',
    })
    assert.deepEqual(verifyContent(PNG, 'application/pdf'), { ok: false, code: 'MIME_MISMATCH' })
    assert.deepEqual(verifyContent(bytes('MZ'), 'image/png'), { ok: false, code: 'MIME_MISMATCH' })
    assert.deepEqual(verifyContent(PDF, 'application/x-msdownload'), {
      ok: false,
      code: 'MIME_NOT_ALLOWED',
    })
  })

  test('formatos Office são zips; texto não pode ter bytes nulos nem controlo', ({ assert }) => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    assert.isTrue(verifyContent(zip, docx).ok)
    assert.isTrue(verifyContent(zip, 'application/zip').ok)
    assert.isFalse(verifyContent(zip, 'application/pdf').ok)
    assert.isTrue(verifyContent(bytes('Olá, ação\n'), 'text/plain').ok)
    assert.isFalse(verifyContent(Uint8Array.from([0x41, 0, 0x42]), 'text/plain').ok)
    assert.isFalse(looksLikeText(Uint8Array.from([0xff, 0xfe, 0xfd])))
    // Um carácter multi-byte cortado no fim do buffer não torna o texto inválido.
    assert.isTrue(looksLikeText(bytes('ação').subarray(0, 4)))
  })

  test('o nome do ficheiro nunca serve de caminho', ({ assert }) => {
    assert.notMatch(sanitizeFileName('../../etc/passwd'), /[\\/]/)
    assert.notMatch(sanitizeFileName('../../etc/passwd'), /^\./)
  })
})

test.group('documentos | pedido de upload e documento', () => {
  const valid = {
    fileName: 'contrato.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    checksum: 'a'.repeat(64),
  }

  test('valida nome, tipo, tamanho e SHA-256', ({ assert }) => {
    assert.isOk(normalizePrepare(valid, 5000).value)
    const codes = (input: Record<string, unknown>) =>
      normalizePrepare({ ...valid, ...input }, 5000).issues.map((i) => i.code)
    assert.include(codes({ fileName: '  ' }), 'REQUIRED')
    assert.include(codes({ mimeType: 'application/x-sh' }), 'MIME_NOT_ALLOWED')
    assert.include(codes({ sizeBytes: 5001 }), 'FILE_TOO_LARGE')
    assert.include(codes({ sizeBytes: 0 }), 'INVALID')
    assert.include(codes({ sizeBytes: 1.5 }), 'INVALID')
    assert.include(codes({ checksum: 'xyz' }), 'INVALID')
  })

  test('o nome é saneado: sem separadores, controlo nem ponto inicial', ({ assert }) => {
    assert.equal(sanitizeFileName('a/b\\c.txt'), 'a_b_c.txt')
    assert.equal(sanitizeFileName('..\u0000segredo.txt'), 'segredo.txt')
    assert.equal(sanitizeFileName('x'.repeat(400)).length, 255)
  })

  test('o documento exige título, recurso completo e retenção válida', ({ assert }) => {
    assert.isOk(normalizeDocument({ title: 'Contrato' }).value.title)
    const codes = (input: Record<string, unknown>) =>
      normalizeDocument({ title: 'x', ...input }).issues.map((i) => i.code)
    assert.include(codes({ title: '' }), 'REQUIRED')
    assert.include(codes({ visibility: 'PUBLIC' }), 'INVALID')
    assert.include(codes({ resourceType: 'invoice' }), 'INCOMPLETE')
    assert.include(codes({ visibility: 'RESOURCE' }), 'REQUIRED')
    assert.include(codes({ retentionUntil: '2026-02-30' }), 'INVALID')
    assert.include(codes({ categoryCode: 'Maiúsculas' }), 'INVALID')
  })
})

test.group('documentos | modelos', () => {
  const schema = normalizeSchema({
    variables: [
      { name: 'cliente', label: 'Cliente', type: 'string' },
      { name: 'total', label: 'Total', type: 'decimal' },
      { name: 'data', label: 'Data', type: 'date', required: false },
    ],
  }).value!

  test('o esquema valida nomes, tipos e repetições', ({ assert }) => {
    assert.isOk(schema)
    const codes = (variables: unknown[]) => normalizeSchema({ variables }).issues.map((i) => i.code)
    assert.include(codes([{ name: 'Nome Inválido' }]), 'INVALID')
    assert.include(codes([{ name: 'a' }, { name: 'a' }]), 'DUPLICATE')
    assert.include(codes([{ name: 'a', type: 'script' }]), 'INVALID')
  })

  test('só variáveis declaradas; nada de funções, blocos ou includes', ({ assert }) => {
    assert.deepEqual(validateTemplateBody('Olá {{cliente}}, total {{ total }}.', schema), [])
    const codes = (body: string) => validateTemplateBody(body, schema).map((i) => i.code)
    assert.include(codes('{{ outra }}'), 'TEMPLATE_UNKNOWN_VARIABLE')
    assert.include(codes('{{ now() }}'), 'TEMPLATE_SYNTAX')
    assert.include(codes('{{ cliente | upper }}'), 'TEMPLATE_SYNTAX')
    assert.include(codes('{{> parcial }}'), 'TEMPLATE_SYNTAX')
    assert.include(codes('{{#each x}}'), 'TEMPLATE_SYNTAX')
    assert.include(codes('{{ http://x.pt/a }}'), 'TEMPLATE_SYNTAX')
    assert.include(codes('texto {{ aberto'), 'TEMPLATE_SYNTAX')
    assert.include(codes('texto }} solto'), 'TEMPLATE_SYNTAX')
    assert.include(codes('   '), 'REQUIRED')
  })

  test('valida os valores pelo tipo e recusa variáveis a mais', ({ assert }) => {
    assert.deepEqual(validateValues(schema, { cliente: 'Ana', total: '12.50' }).value, {
      cliente: 'Ana',
      total: '12.50',
      data: '',
    })
    const codes = (values: Record<string, unknown>) =>
      validateValues(schema, values).issues.map((i) => i.code)
    assert.include(codes({ total: '1' }), 'REQUIRED')
    assert.include(codes({ cliente: 'Ana', total: '1,5' }), 'INVALID')
    assert.include(codes({ cliente: 'Ana', total: '1', data: '2026-13-01' }), 'INVALID')
    assert.include(codes({ cliente: 'Ana', total: '1', extra: 'x' }), 'UNKNOWN')
    assert.include(codes({ cliente: 'x'.repeat(2001), total: '1' }), 'TOO_LONG')
  })

  test('a substituição é de uma só passagem e escapa HTML', ({ assert }) => {
    const values = { cliente: '<b>"A&B"</b> {{total}}', total: '9', data: '' }
    const html = renderTemplate('Para: {{cliente}} <i>{{total}}</i>', values, 'html')
    assert.equal(
      html,
      'Para: &lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt; {{total}} &lt;i&gt;9&lt;/i&gt;'
    )
    // Um valor com {{total}} não volta a ser interpretado.
    assert.include(renderTemplate('{{cliente}}', values, 'text'), '{{total}}')
    assert.equal(escapeHtml("'"), '&#39;')
    assert.notInclude(
      renderTemplate('{{cliente}}', { ...values, cliente: 'a\u0007b' }, 'text'),
      '\u0007'
    )
  })
})

test.group('documentos | PDF', () => {
  const input = {
    title: 'Contrato – Açúcar',
    body: Array.from(
      { length: 150 },
      (_, i) => `Linha ${i + 1} ação “cedilha” ${'palavra '.repeat(i % 15)}`
    ).join('\n'),
    generatedAt: new Date('2026-10-29T10:00:00Z'),
  }

  test('gera um PDF válido, paginado e determinístico', ({ assert }) => {
    const a = renderPdf(input)
    const b = renderPdf(input)
    assert.isTrue(a.equals(b))
    assert.equal(a.subarray(0, 5).toString('latin1'), '%PDF-')
    assert.isTrue(a.toString('latin1').trimEnd().endsWith('%%EOF'))
    const text = a.toString('latin1')
    const pages = Number(/\/Count (\d+)/.exec(text)?.[1])
    assert.isAbove(pages, 1)
    assert.include(text, `Página ${pages} de ${pages}`.replace('á', '\\341'))
  })

  test('o texto dos metadados e o conteúdo não escapam das suas strings', ({ assert }) => {
    const pdf = renderPdf({ title: 'a) /Type /X (', body: 'x\\) (y', generatedAt: new Date() })
    const text = pdf.toString('latin1')
    // Os parênteses do título e do corpo ficam escapados dentro do literal: nada fecha a string.
    assert.include(text, '/Title (a\\) /Type /X \\()')
    assert.include(text, '(x\\\\\\) \\(y)')
  })

  test('uma palavra mais larga do que a página parte-se em vez de sair dela', ({ assert }) => {
    const pdf = renderPdf({ title: 't', body: 'W'.repeat(400), generatedAt: new Date() })
    assert.isAbove((pdf.toString('latin1').match(/ Tj ET/g) ?? []).length, 3)
  })
})

test.group('documentos | assinatura, análise e armazenamento', (group) => {
  let dir: string
  group.each.setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docs-'))
    return () => rm(dir, { recursive: true, force: true })
  })

  test('o token assinado recusa alterações e expira', ({ assert }) => {
    const signer = new HmacUrlSigner('segredo-de-teste-com-pelo-menos-32-caracteres!')
    const now = new Date('2026-10-29T10:00:00Z')
    const payload = {
      tenantId: 't1',
      attachmentId: 'a1',
      membershipId: 'm1',
      userId: 'u1',
      expiresAt: Math.floor(now.getTime() / 1000) + 60,
    }
    const token = signer.sign(payload)
    assert.deepEqual(signer.verify(token, now), payload)
    const [body, mac] = token.split('.') as [string, string]
    const forged = Buffer.from(
      JSON.stringify(['t2', 'a1', 'm1', 'u1', payload.expiresAt])
    ).toString('base64url')
    assert.isNull(signer.verify(`${forged}.${mac}`, now))
    assert.isNull(signer.verify(`${body}.${mac.slice(0, -2)}xx`, now))
    assert.isNull(signer.verify(`${body}`, now))
    assert.isNull(signer.verify(`${body}.${mac}.extra`, now))
    assert.isNull(signer.verify(token, new Date(now.getTime() + 61_000)))
    assert.isNull(
      new HmacUrlSigner('outro-segredo-diferente-com-32-caracteres!!').verify(token, now)
    )
  })

  test('o analisador encontra a assinatura mesmo partida entre blocos', async ({ assert }) => {
    const scanner = new SignatureScanner()
    const half = Math.floor(EICAR.length / 2)
    const parts = [
      Buffer.from('x'.repeat(100)),
      Buffer.from(EICAR.slice(0, half)),
      Buffer.from(EICAR.slice(half)),
    ]
    const dirty = await scanner.scan(() => Readable.from(parts))
    assert.deepEqual(dirty, { clean: false, signature: 'EICAR-Test-File' })
    const clean = await scanner.scan(() => Readable.from([Buffer.from('conteúdo normal')]))
    assert.isTrue(clean.clean)
  })

  test('o armazenamento grava, mede, recusa excessos e não sai da raiz', async ({ assert }) => {
    const storage = new LocalObjectStorage(dir)
    const saved = await storage.put(
      't/2026/a',
      Readable.from([Buffer.from('olá '), Buffer.from('mundo')]),
      100
    )
    assert.equal(saved.size, 'olá mundo'.length + 1)
    assert.equal((await readFile(join(dir, 't/2026/a'))).toString(), 'olá mundo')
    assert.equal((await storage.head('t/2026/a', 3)).length, 3)
    await assert.rejects(
      () => storage.put('t/2026/b', Readable.from([Buffer.alloc(50)]), 10),
      new StorageLimitError().message
    )
    // O parcial não fica na chave definitiva nem no disco.
    await assert.rejects(() => readFile(join(dir, 't/2026/b')))
    await assert.rejects(
      () => storage.put('../fora', Readable.from([Buffer.from('x')]), 10),
      'Chave de armazenamento inválida.'
    )
    await storage.remove('t/2026/a')
    await assert.rejects(() => readFile(join(dir, 't/2026/a')))
  })
})
