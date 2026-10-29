import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from '@japa/runner'
import {
  MAX_ATTEMPTS,
  canDisable,
  maskDestination,
  minimizeError,
  normalizeManualRequest,
  normalizeQuietHours,
  quietUntil,
  render,
  renderType,
  retryAt,
  typeOf,
  type Issue,
} from '#modules/notifications/domain/notifications'
import { ProviderError } from '#modules/notifications/application/ports'
import { AesGcmCipher } from '#modules/notifications/infrastructure/cipher'
import { HttpGatewayProvider } from '#modules/notifications/infrastructure/http_gateway_provider'

test.group('notificações | texto e classificação', () => {
  test('o template só substitui campos: sem expressões nem código', ({ assert }) => {
    assert.equal(render('Olá {{name}}, {{n}}!', { name: 'Ana', n: 3 }), 'Olá Ana, 3!')
    assert.equal(render('{{missing}}|{{ obj }}', { obj: { x: 1 } }), '|')
    // Nomes herdados do protótipo e expressões não se resolvem: o que não é um campo do payload fica vazio ou literal.
    assert.equal(render('{{constructor}}|{{__proto__}}|{{a.b}}', {}), '|{{__proto__}}|{{a.b}}')
    const type = typeOf('crm.campaign.message')
    assert.deepEqual(renderType(type!, { subject: 'Assunto', message: 'Corpo' }), {
      title: 'Assunto',
      body: 'Corpo',
    })
  })

  test('só o aviso obrigatório não se desactiva; só os tipos manuais se pedem à mão', ({
    assert,
  }) => {
    assert.isFalse(canDisable(typeOf('system.mandatory')!))
    assert.isTrue(canDisable(typeOf('system.message')!))
    assert.isTrue(canDisable(typeOf('crm.campaign.message')!))
    assert.equal(typeOf('crm.campaign.message')!.classification, 'PROMOTIONAL')
    const issues: Issue[] = []
    assert.isNull(
      normalizeManualRequest(
        { typeCode: 'crm.lead.converted', recipientMembershipIds: ['a'], title: 't', body: 'b' },
        issues
      )
    )
    assert.equal(issues[0]?.code, 'INVALID_TYPE')
    const ok = normalizeManualRequest(
      {
        typeCode: 'system.message',
        recipientMembershipIds: ['a', 'a', 'b'],
        title: ' T ',
        body: 'B',
      },
      []
    )
    assert.deepEqual(ok?.recipientMembershipIds, ['a', 'b'])
    assert.equal(ok?.title, 'T')
  })
})

test.group('notificações | horas de silêncio, recuo e máscara', () => {
  const at = (hhmm: string) => new Date(`2026-10-29T${hhmm}:00Z`)

  test('a janela pode atravessar a meia-noite e respeita o fuso', ({ assert }) => {
    const night = { start: '22:00', end: '07:00', utcOffsetMinutes: 60 }
    assert.isNull(quietUntil(night, at('12:00')))
    // 23:30 UTC = 00:30 locais: dentro; termina às 07:00 locais = 06:00 UTC.
    assert.equal(quietUntil(night, at('23:30'))?.toISOString(), '2026-10-30T06:00:00.000Z')
    assert.equal(quietUntil(night, at('03:00'))?.toISOString(), '2026-10-29T06:00:00.000Z')
    const day = { start: '09:00', end: '17:00', utcOffsetMinutes: 0 }
    assert.equal(quietUntil(day, at('10:15'))?.toISOString(), '2026-10-29T17:00:00.000Z')
    assert.isNull(quietUntil(day, at('17:00')))
    assert.isNull(quietUntil(null, at('10:00')))
  })

  test('valida as horas de silêncio', ({ assert }) => {
    const codes = (input: unknown) => {
      const issues: Issue[] = []
      normalizeQuietHours(input, issues)
      return issues.map((i) => i.code)
    }
    assert.deepEqual(codes({ start: '22:00', end: '07:00' }), [])
    assert.deepEqual(codes({ start: '25:00', end: '07:00' }), ['INVALID_QUIET_HOURS'])
    assert.deepEqual(codes({ start: '08:00', end: '08:00' }), ['INVALID_QUIET_HOURS'])
    assert.deepEqual(codes({ start: '08:00', end: '09:00', utcOffsetMinutes: 2000 }), [
      'INVALID_QUIET_HOURS',
    ])
    assert.deepEqual(codes(null), [])
  })

  test('o recuo cresce e a máscara nunca mostra o destino completo', ({ assert }) => {
    const now = new Date('2026-10-29T10:00:00Z')
    assert.equal(retryAt(1, now).getTime() - now.getTime(), 60_000)
    assert.equal(retryAt(3, now).getTime() - now.getTime(), 15 * 60_000)
    assert.equal(retryAt(99, now).getTime() - now.getTime(), 240 * 60_000)
    assert.equal(MAX_ATTEMPTS, 5)
    assert.equal(maskDestination('EMAIL', 'ana.silva@exemplo.pt'), 'a***@exemplo.pt')
    assert.equal(maskDestination('SMS', '+244 923 456 789'), '+•••789')
    assert.equal(
      minimizeError('Falhou para ana@x.pt e +244 923 456 789'),
      'Falhou para [email] e [número]'
    )
  })
})

test.group('notificações | cifra do destino', () => {
  test('cifra e decifra; cada cifra é diferente e a adulteração falha', ({ assert }) => {
    const cipher = new AesGcmCipher('uma-chave-de-aplicacao-com-mais-de-32-caracteres')
    const a = cipher.encrypt('ana@exemplo.pt')
    const b = cipher.encrypt('ana@exemplo.pt')
    assert.notEqual(a, b)
    assert.notInclude(a, 'ana')
    assert.equal(cipher.decrypt(a), 'ana@exemplo.pt')
    const parts = a.split(':')
    parts[3] = Buffer.from('adulterado').toString('base64')
    assert.throws(() => cipher.decrypt(parts.join(':')))
    assert.throws(() => new AesGcmCipher('outra-chave-completamente-diferente-xxxxxxxx').decrypt(a))
    assert.throws(() => cipher.decrypt('lixo'))
  })
})

test.group('notificações | conector HTTP', (group) => {
  let server: Server
  let url = ''
  let status = 200
  const seen: { headers: IncomingMessage['headers']; body: any }[] = []

  group.setup(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        seen.push({ headers: req.headers, body: JSON.parse(raw) })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'abc-123' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`
    return () => new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const provider = (token: string | null = 'segredo') =>
    new HttpGatewayProvider({
      channel: 'EMAIL',
      name: 'email_http',
      url,
      token,
      supportsDedupe: true,
    })
  const message = {
    channel: 'EMAIL' as const,
    destination: 'ana@exemplo.pt',
    title: 'Assunto',
    body: 'Corpo',
    dedupeKey: 'entrega-1',
  }

  test('envia o pedido com o token e a chave de idempotência e devolve o identificador', async ({
    assert,
  }) => {
    status = 200
    seen.length = 0
    const result = await provider().send(message)
    assert.equal(result.providerMessageId, 'abc-123')
    assert.equal(seen[0]!.headers['idempotency-key'], 'entrega-1')
    assert.equal(seen[0]!.headers.authorization, 'Bearer segredo')
    assert.deepEqual(seen[0]!.body, {
      to: 'ana@exemplo.pt',
      subject: 'Assunto',
      body: 'Corpo',
      dedupeKey: 'entrega-1',
    })
  })

  test('4xx é uma recusa (429 repete-se); outras falhas têm resultado desconhecido', async ({
    assert,
  }) => {
    status = 400
    const refused = await provider()
      .send(message)
      .catch((e) => e)
    assert.instanceOf(refused, ProviderError)
    assert.isFalse(refused.retryable)
    status = 429
    assert.isTrue(
      (
        await provider()
          .send(message)
          .catch((e) => e)
      ).retryable
    )
    status = 503
    const unknown = await provider()
      .send(message)
      .catch((e) => e)
    assert.notInstanceOf(unknown, ProviderError)
    assert.instanceOf(unknown, Error)
    // Sem resposta (ligação recusada): também desconhecido, nunca uma recusa.
    const dead = new HttpGatewayProvider({
      channel: 'EMAIL',
      name: 'x',
      url: 'http://127.0.0.1:1/send',
      token: null,
      supportsDedupe: false,
      timeoutMs: 500,
    })
    assert.notInstanceOf(await dead.send(message).catch((e) => e), ProviderError)
  })
})
