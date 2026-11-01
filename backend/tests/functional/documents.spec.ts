import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { documentServices, registerDocumentResource } from '#modules/documents/index'
import { EICAR } from '#modules/documents/infrastructure/signature_scanner'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, getWithSession, newActor, type Actor } from '#tests/support/api_fixture'
import { license, syncTestRegistry } from '#tests/support/modules_fixture'
import type { Tenant } from '#platform/tenants/index'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const owner = <T>(sql: string, tenant: Tenant) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const http = api(client, tenant, admin)
  await syncTestRegistry()
  await license(tenant, ['documents'])
  const enabled = await http.post('/api/v1/tenant/modules/documents/enable', {})
  if (enabled.status() !== 200) throw new Error(JSON.stringify(enabled.body()))
  return { client, tenant, admin, http }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function memberWith(ctx: Ctx, permissions: string[]) {
  const actor = await newActor(ctx.client, ctx.tenant)
  const role = await must<{ id: string }>(
    await ctx.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  await must(
    await ctx.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return { actor, http: api(ctx.client, ctx.tenant, actor) }
}

interface Uploaded {
  id: string
  status: string
  rejectCode: string | null
}

/** Prepara, envia e conclui. Devolve a resposta de cada passo. */
async function upload(
  http: Http,
  data: Buffer,
  options: { name?: string; mime?: string; declaredSize?: number; checksum?: string } = {}
) {
  const prepared = await http.post('/api/v1/attachments/prepare', {
    fileName: options.name ?? 'nota.txt',
    mimeType: options.mime ?? 'text/plain',
    sizeBytes: options.declaredSize ?? data.length,
    checksum: options.checksum ?? sha(data),
  })
  if (prepared.status() !== 201) return { prepared }
  const view = prepared.body().data as { id: string; uploadPath: string }
  const sent = await http.putRaw(view.uploadPath, data)
  const completed =
    sent.status === 200 ? await http.post(`/api/v1/attachments/${view.id}/complete`, {}) : null
  return { prepared, view, sent, completed }
}

async function available(http: Http, text = 'conteúdo do ficheiro\n', name = 'nota.txt') {
  const result = await upload(http, Buffer.from(text), { name })
  return (await must<Uploaded>(result.completed as any, 200)).id
}

const createDocument = async (
  http: Http,
  attachmentId: string,
  extra: Record<string, unknown> = {}
) =>
  must<any>(
    await http.post('/api/v1/documents', {
      title: 'Contrato de teste',
      attachmentId,
      visibility: 'TENANT',
      ...extra,
    }),
    201
  )

const hooks = (group: any) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    const limits = documentServices().limits
    const before = { ...limits }
    return async () => {
      Object.assign(limits, before)
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })
}

test.group('documentos | upload, verificação e descarga', (group) => {
  hooks(group)

  test('preparar → enviar → concluir; só então se descarrega, sempre como anexo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const data = Buffer.from('Olá, mundo — ação\n')
    const { prepared, sent, completed } = await upload(ctx.http, data, { name: 'relatório.txt' })
    const view = await must<any>(prepared, 201)
    assert.equal(view.status, 'PENDING')
    assert.notProperty(view, 'storageKey')
    assert.equal(sent!.status, 200)
    assert.equal(sent!.json().data.status, 'PENDING')
    const done = await must<any>(completed as any, 200)
    assert.equal(done.status, 'AVAILABLE')
    assert.isTrue(done.downloadable)
    assert.notProperty(done, 'storageKey')

    const download = await ctx.http.getRaw(`/api/v1/attachments/${view.id}/download`)
    assert.equal(download.status, 200)
    assert.isTrue(download.buffer.equals(data))
    assert.include(download.headers.get('content-disposition') ?? '', 'attachment;')
    assert.include(
      download.headers.get('content-disposition') ?? '',
      "filename*=UTF-8''relat%C3%B3rio.txt"
    )
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(download.headers.get('cache-control'), 'private, no-store')
    // Concluir outra vez devolve o mesmo estado; já não aceita mais conteúdo.
    assert.equal((await ctx.http.post(`/api/v1/attachments/${view.id}/complete`, {})).status(), 200)
    const again = await ctx.http.putRaw(view.uploadPath, data)
    assert.equal(again.status, 409)
  })

  test('antes de concluir não se descarrega: PENDING dá 409 ATTACHMENT_UNAVAILABLE', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const data = Buffer.from('ainda por concluir')
    const view = await must<any>(
      await ctx.http.post('/api/v1/attachments/prepare', {
        fileName: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: data.length,
        checksum: sha(data),
      }),
      201
    )
    await ctx.http.putRaw(view.uploadPath, data)
    const blocked = await ctx.http.getRaw(`/api/v1/attachments/${view.id}/download`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json().error.code, 'ATTACHMENT_UNAVAILABLE')
    const url = await ctx.http.post(`/api/v1/attachments/${view.id}/download-url`, {})
    assert.equal(url.status(), 409)
  })

  test('upload acima da quota do tenant é rejeitado; acima do limite por ficheiro também', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const limits = documentServices().limits
    limits.tenantQuotaBytes = 100
    limits.maxFileBytes = 80
    const prepare = (size: number) =>
      ctx.http.post('/api/v1/attachments/prepare', {
        fileName: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: size,
        checksum: 'a'.repeat(64),
      })
    assert.equal(code(await prepare(81)), 'FILE_TOO_LARGE')
    assert.equal((await prepare(60)).status(), 201)
    const over = await prepare(60)
    assert.equal(over.status(), 422)
    assert.equal(code(over), 'QUOTA_EXCEEDED')
    assert.equal((await prepare(40)).status(), 201)
    // Um pedido que expirou deixa de ocupar quota.
    await owner(
      `update attachments set upload_expires_at = now() - interval '1 minute'`,
      ctx.tenant
    )
    assert.equal((await prepare(80)).status(), 201)
  })

  test('quota: pedidos concorrentes nunca ultrapassam o limite', async ({ client, assert }) => {
    const ctx = await setup(client)
    documentServices().limits.tenantQuotaBytes = 100
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx.http.post('/api/v1/attachments/prepare', {
          fileName: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 40,
          checksum: 'b'.repeat(64),
        })
      )
    )
    assert.equal(results.filter((r) => r.status() === 201).length, 2)
    assert.equal(results.filter((r) => r.status() === 422).length, 4)
  })

  test('tamanho e SHA-256 conferidos: o ficheiro que não bate certo é rejeitado e apagado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    // Mais bytes do que o declarado: recusado ao enviar.
    const big = await upload(ctx.http, Buffer.from('muito mais comprido do que o declarado'), {
      declaredSize: 5,
    })
    assert.equal(big.sent?.status, 422)
    assert.equal(big.sent?.json().error.details[0].code, 'SIZE_MISMATCH')
    const bigState = await must<any>(await ctx.http.get(`/api/v1/attachments/${big.view?.id}`), 200)
    assert.equal(bigState.status, 'REJECTED')

    // Menos bytes do que o declarado: recusado ao concluir.
    const short = await upload(ctx.http, Buffer.from('curto'), { declaredSize: 50 })
    assert.equal(short.completed?.status(), 422)
    assert.equal(code(short.completed), 'SIZE_MISMATCH')

    // O mesmo tamanho com outro conteúdo: SHA-256 diferente.
    const wrong = await upload(ctx.http, Buffer.from('conteudo-real'), {
      checksum: sha(Buffer.from('outro-conteudo')),
    })
    assert.equal(code(wrong.completed), 'CHECKSUM_MISMATCH')
    const state = await must<any>(await ctx.http.get(`/api/v1/attachments/${wrong.view?.id}`), 200)
    assert.deepInclude(state, {
      status: 'REJECTED',
      rejectCode: 'CHECKSUM_MISMATCH',
      downloadable: false,
    })
    assert.equal(
      (await ctx.http.getRaw(`/api/v1/attachments/${wrong.view?.id}/download`)).status,
      409
    )
  })

  test('MIME falso: um executável declarado como PDF é rejeitado', async ({ client, assert }) => {
    const ctx = await setup(client)
    const fake = await upload(ctx.http, Buffer.from('MZ\x90\x00 isto não é um PDF'), {
      name: 'fatura.pdf',
      mime: 'application/pdf',
    })
    assert.equal(code(fake.completed), 'MIME_MISMATCH')
    const state = await must<any>(await ctx.http.get(`/api/v1/attachments/${fake.view?.id}`), 200)
    assert.equal(state.status, 'REJECTED')
    // Um tipo fora da lista nem chega a ser preparado.
    const refused = await upload(ctx.http, Buffer.from('x'), {
      name: 'a.exe',
      mime: 'application/x-msdownload',
    })
    assert.equal(code(refused.prepared), 'MIME_NOT_ALLOWED')
    // Um PDF verdadeiro passa.
    const real = await upload(ctx.http, Buffer.from('%PDF-1.4\n%%EOF\n'), {
      name: 'f.pdf',
      mime: 'application/pdf',
    })
    assert.equal(real.completed?.body().data.status, 'AVAILABLE')
  })

  test('ficheiro infectado fica em quarentena: indisponível e não se liga a nada', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const result = await upload(ctx.http, Buffer.from(`inofensivo\n${EICAR}\n`), {
      name: 'virus.txt',
    })
    const done = await must<any>(result.completed as any, 200)
    assert.deepInclude(done, { status: 'QUARANTINED', downloadable: false })
    const blocked = await ctx.http.getRaw(`/api/v1/attachments/${done.id}/download`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json().error.details[0].code, 'QUARANTINED')
    assert.equal(
      (await ctx.http.post(`/api/v1/attachments/${done.id}/download-url`, {})).status(),
      409
    )
    const doc = await ctx.http.post('/api/v1/documents', { title: 'x', attachmentId: done.id })
    assert.equal(doc.status(), 422)
    assert.equal(code(doc), 'ATTACHMENT_NOT_AVAILABLE')
    const events = await db
      .connection('owner')
      .from('security_events')
      .where('tenant_id', ctx.tenant.id)
      .where('event_type', 'ATTACHMENT_QUARANTINED')
    assert.lengthOf(events, 1)
    assert.equal(events[0].metadata.detection, 'EICAR-Test-File')
  })

  test('só quem preparou envia e conclui; um pedido expirado não aceita conteúdo', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const other = await memberWith(ctx, ['document.manage', 'document.read'])
    const data = Buffer.from('meu')
    const view = await must<any>(
      await ctx.http.post('/api/v1/attachments/prepare', {
        fileName: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: data.length,
        checksum: sha(data),
      }),
      201
    )
    assert.equal((await other.http.putRaw(view.uploadPath, data)).status, 404)
    assert.equal(
      (await other.http.post(`/api/v1/attachments/${view.id}/complete`, {})).status(),
      404
    )
    assert.equal((await ctx.http.post(`/api/v1/attachments/${view.id}/complete`, {})).status(), 409)
    await owner(
      `update attachments set upload_expires_at = now() - interval '1 minute'`,
      ctx.tenant
    )
    const late = await ctx.http.putRaw(view.uploadPath, data)
    assert.equal(late.status, 409)
    assert.equal(late.json().error.code, 'UPLOAD_EXPIRED')
    // O corpo tem de ser o ficheiro em bruto.
    const json = await ctx.http.put(view.uploadPath, { a: 1 })
    assert.equal(json.status(), 415)
  })

  test('sem document.manage não se prepara; sem document.read não se descarrega', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const reader = await memberWith(ctx, ['document.read'])
    const id = await available(ctx.http)
    const body = {
      fileName: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      checksum: 'a'.repeat(64),
    }
    assert.equal((await reader.http.post('/api/v1/attachments/prepare', body)).status(), 403)
    const nobody = await memberWith(ctx, ['member.read'])
    assert.equal(
      (await nobody.http.post(`/api/v1/attachments/${id}/download-url`, {})).status(),
      403
    )
  })
})

test.group('documentos | biblioteca, versões e acesso', (group) => {
  hooks(group)

  test('criar documento, acrescentar versões imutáveis e um anexo só serve uma versão', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const first = await available(ctx.http, 'versão um', 'v1.txt')
    const doc = await createDocument(ctx.http, first)
    assert.equal(doc.current.revision, 1)
    assert.equal(doc.current.fileName, 'v1.txt')

    const second = await available(ctx.http, 'versão dois', 'v2.txt')
    const version = await must<any>(
      await ctx.http.post(`/api/v1/documents/${doc.id}/versions`, {
        attachmentId: second,
        changeNote: 'Corrigido o prazo',
      }),
      201
    )
    assert.equal(version.revision, 2)
    const detail = await must<any>(await ctx.http.get(`/api/v1/documents/${doc.id}`), 200)
    assert.equal(detail.document.current.revision, 2)
    assert.deepEqual(
      detail.versions.map((v: any) => [v.revision, v.fileName]),
      [
        [2, 'v2.txt'],
        [1, 'v1.txt'],
      ]
    )
    // Reutilizar o mesmo anexo noutra versão: 409.
    const reuse = await ctx.http.post(`/api/v1/documents/${doc.id}/versions`, {
      attachmentId: second,
    })
    assert.equal(reuse.status(), 409)
    assert.equal(code(reuse), 'ATTACHMENT_ALREADY_LINKED')
    // As versões são imutáveis, até por SQL.
    await assert.rejects(
      () => owner(`update document_versions set change_note = 'x'`, ctx.tenant),
      /DOCUMENT_VERSION_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`delete from document_versions`, ctx.tenant),
      /DOCUMENT_VERSION_IMMUTABLE/
    )
    // Cada versão continua descarregável.
    const old = await ctx.http.getRaw(
      `/api/v1/attachments/${detail.versions[1].attachmentId}/download`
    )
    assert.equal(old.buffer.toString(), 'versão um')
  })

  test('um anexo de outro membro, de outro tenant ou inexistente não se liga', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const other = await setup(client)
    const mine = await available(ctx.http)
    const theirs = await available(other.http)
    const member = await memberWith(ctx, ['document.manage', 'document.read'])
    const refused = async (http: Http, attachmentId: string) => {
      const r = await http.post('/api/v1/documents', { title: 'x', attachmentId })
      assert.equal(r.status(), 422)
      assert.equal(code(r), 'ATTACHMENT_NOT_FOUND')
    }
    await refused(ctx.http, theirs)
    await refused(member.http, mine)
    await refused(ctx.http, '00000000-0000-4000-8000-000000000000')
    const missing = await ctx.http.post('/api/v1/documents', { title: 'x' })
    assert.equal(missing.status(), 422)
  })

  test('visibilidade: privado só do dono, tenant com document.read, 404 para ids alheios', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const reader = await memberWith(ctx, ['document.read'])
    const noRead = await memberWith(ctx, ['member.read'])
    const priv = await createDocument(ctx.http, await available(ctx.http, 'privado'), {
      visibility: 'PRIVATE',
      title: 'Privado',
    })
    const shared = await createDocument(ctx.http, await available(ctx.http, 'partilhado'), {
      title: 'Partilhado',
    })
    assert.equal((await reader.http.get(`/api/v1/documents/${priv.id}`)).status(), 404)
    assert.equal((await reader.http.get(`/api/v1/documents/${shared.id}`)).status(), 200)
    assert.equal((await noRead.http.get(`/api/v1/documents/${shared.id}`)).status(), 403)
    const listed = await must<any[]>(await reader.http.get('/api/v1/documents'), 200)
    assert.deepEqual(
      listed.map((d) => d.title),
      ['Partilhado']
    )
    // O anexo de um documento privado também não se vê nem descarrega.
    const privateAttachment = priv.current.attachmentId
    assert.equal((await reader.http.get(`/api/v1/attachments/${privateAttachment}`)).status(), 404)
    assert.equal(
      (await reader.http.getRaw(`/api/v1/attachments/${privateAttachment}/download`)).status,
      404
    )
    // Quem só tem document.read não cria nem altera.
    assert.equal(
      (
        await reader.http.patch(`/api/v1/documents/${shared.id}`, { version: 1, title: 'x' })
      ).status(),
      403
    )
    assert.equal((await ctx.http.get('/api/v1/documents/nao-e-um-uuid')).status(), 404)
  })

  test('pesquisa, categoria e paginação da biblioteca', async ({ client, assert }) => {
    const ctx = await setup(client)
    for (const [title, categoryCode] of [
      ['Contrato Alfa', 'contratos'],
      ['Contrato Beta', 'contratos'],
      ['Relatório 100%_final', 'relatorios'],
    ] as const) {
      await createDocument(ctx.http, await available(ctx.http, title), { title, categoryCode })
    }
    const titles = async (query: string) =>
      (await must<any[]>(await ctx.http.get(`/api/v1/documents${query}`), 200))
        .map((d) => d.title)
        .sort()
    assert.deepEqual(await titles('?search=contrato'), ['Contrato Alfa', 'Contrato Beta'])
    assert.deepEqual(await titles('?categoryCode=relatorios'), ['Relatório 100%_final'])
    // Os caracteres especiais do LIKE são literais.
    assert.deepEqual(await titles('?search=100%25_'), ['Relatório 100%_final'])
    assert.deepEqual(await titles('?search=%25'), ['Relatório 100%_final'])
    const page = await ctx.http.get('/api/v1/documents?limit=2&offset=0')
    assert.equal(page.body().meta.total, 3)
    assert.lengthOf(page.body().data, 2)
  })

  test('documento de recurso: herda o acesso do recurso e perde-o quando é revogado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const state = { allowed: true }
    registerDocumentResource('teste_recurso', {
      permission: 'customer.read',
      protected: false,
      exists: async () => state.allowed,
    })
    registerDocumentResource('teste_protegido', {
      permission: 'customer.read',
      protected: true,
      exists: async () => true,
    })
    const resourceId = '11111111-1111-4111-8111-111111111111'
    const member = await memberWith(ctx, ['document.read', 'customer.read'])
    const doc = await createDocument(ctx.http, await available(ctx.http, 'do recurso'), {
      visibility: 'RESOURCE',
      resourceType: 'teste_recurso',
      resourceId,
    })
    assert.equal((await member.http.get(`/api/v1/documents/${doc.id}`)).status(), 200)
    const attachmentId = doc.current.attachmentId
    assert.equal(
      (await member.http.getRaw(`/api/v1/attachments/${attachmentId}/download`)).status,
      200
    )
    // Sem a permissão do recurso, o documento desaparece para essa pessoa.
    const noResource = await memberWith(ctx, ['document.read'])
    assert.equal((await noResource.http.get(`/api/v1/documents/${doc.id}`)).status(), 404)
    assert.deepEqual(await must<any[]>(await noResource.http.get('/api/v1/documents'), 200), [])
    // O recurso deixa de existir ou de ser acessível: ninguém vê o documento.
    state.allowed = false
    assert.equal((await member.http.get(`/api/v1/documents/${doc.id}`)).status(), 404)
    assert.equal((await ctx.http.get(`/api/v1/attachments/${attachmentId}`)).status(), 404)
    assert.equal(
      (await ctx.http.getRaw(`/api/v1/attachments/${attachmentId}/download`)).status,
      404
    )
    state.allowed = true
    // Tipo desconhecido, recurso inexistente e recurso protegido com visibilidade mais larga.
    const unknown = await ctx.http.post('/api/v1/documents', {
      title: 'x',
      attachmentId: await available(ctx.http, 'u'),
      visibility: 'RESOURCE',
      resourceType: 'nao_registado',
      resourceId,
    })
    assert.equal(code(unknown), 'RESOURCE_TYPE_UNKNOWN')
    state.allowed = false
    const gone = await ctx.http.post('/api/v1/documents', {
      title: 'x',
      attachmentId: await available(ctx.http, 'g'),
      visibility: 'RESOURCE',
      resourceType: 'teste_recurso',
      resourceId,
    })
    assert.equal(code(gone), 'RESOURCE_NOT_FOUND')
    state.allowed = true
    const wide = await ctx.http.post('/api/v1/documents', {
      title: 'x',
      attachmentId: await available(ctx.http, 'w'),
      visibility: 'TENANT',
      resourceType: 'teste_protegido',
      resourceId,
    })
    assert.equal(wide.status(), 422)
    assert.equal(code(wide), 'VISIBILITY_WIDENS_ACCESS')
    // Alargar a visibilidade depois também é recusado.
    const strict = await createDocument(ctx.http, await available(ctx.http, 's'), {
      visibility: 'RESOURCE',
      resourceType: 'teste_protegido',
      resourceId,
    })
    const widen = await ctx.http.patch(`/api/v1/documents/${strict.id}`, {
      version: strict.version,
      visibility: 'TENANT',
    })
    assert.equal(code(widen), 'VISIBILITY_WIDENS_ACCESS')
  })

  test('URL assinada: curta, ligada ao tenant, ao anexo e à pessoa; o acesso volta a decidir-se', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const other = await setup(client)
    const state = { allowed: true }
    registerDocumentResource('teste_url', {
      permission: 'customer.read',
      protected: false,
      exists: async () => state.allowed,
    })
    const doc = await createDocument(ctx.http, await available(ctx.http, 'segredo do contrato'), {
      visibility: 'RESOURCE',
      resourceType: 'teste_url',
      resourceId: '22222222-2222-4222-8222-222222222222',
    })
    const issued = await must<any>(
      await ctx.http.post(`/api/v1/attachments/${doc.current.attachmentId}/download-url`, {}),
      200
    )
    assert.match(issued.url, /^\/api\/v1\/files\/[\w-]+\.[\w-]+$/)
    const ok = await getWithSession(ctx.admin, issued.url)
    assert.equal(ok.status, 200)
    assert.equal(ok.buffer.toString(), 'segredo do contrato')
    assert.include(ok.headers.get('content-disposition') ?? '', 'attachment;')

    // Sem sessão, com a sessão de outra pessoa ou de outro tenant: nada.
    const anonymous = await fetch(`http://127.0.0.1:${process.env['PORT'] ?? 3333}${issued.url}`)
    assert.equal(anonymous.status, 401)
    const member = await memberWith(ctx, ['document.read', 'customer.read'])
    assert.equal((await getWithSession(member.actor, issued.url)).status, 404)
    assert.equal((await getWithSession(other.admin, issued.url)).status, 404)
    // Token alterado (outro tenant, outra assinatura) ou lixo.
    const [body, mac] = issued.url.split('/').pop().split('.')
    const parts = JSON.parse(Buffer.from(body, 'base64url').toString())
    parts[0] = other.tenant.id
    const forged = Buffer.from(JSON.stringify(parts)).toString('base64url')
    assert.equal((await getWithSession(ctx.admin, `/api/v1/files/${forged}.${mac}`)).status, 404)
    assert.equal((await getWithSession(ctx.admin, `/api/v1/files/${body}.xxxx`)).status, 404)
    assert.equal((await getWithSession(ctx.admin, '/api/v1/files/lixo')).status, 404)

    // Um tenant não emite URLs para anexos de outro.
    const foreign = await other.http.post(
      `/api/v1/attachments/${doc.current.attachmentId}/download-url`,
      {}
    )
    assert.equal(foreign.status(), 404)

    // Acesso revogado depois de emitida: a URL deixa de servir.
    state.allowed = false
    assert.equal((await getWithSession(ctx.admin, issued.url)).status, 404)
    state.allowed = true
    assert.equal((await getWithSession(ctx.admin, issued.url)).status, 200)

    // Expirada.
    documentServices().limits.downloadTtlSeconds = -5
    const stale = await must<any>(
      await ctx.http.post(`/api/v1/attachments/${doc.current.attachmentId}/download-url`, {}),
      200
    )
    assert.equal((await getWithSession(ctx.admin, stale.url)).status, 404)
  })

  test('apagar: a retenção e a retenção legal bloqueiam, até por SQL; depois os ficheiros saem', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const doc = await createDocument(ctx.http, await available(ctx.http, 'a apagar'), {
      retentionUntil: '2999-01-01',
    })
    const blocked = await ctx.http.delete(`/api/v1/documents/${doc.id}`)
    assert.equal(blocked.status(), 409)
    assert.equal(code(blocked), 'DOCUMENT_RETENTION')
    await assert.rejects(
      () => owner(`update documents set status = 'DELETED' where id = '${doc.id}'`, ctx.tenant),
      /DOCUMENT_RETENTION/
    )
    let current = await must<any>(
      await ctx.http.patch(`/api/v1/documents/${doc.id}`, {
        version: doc.version,
        retentionUntil: null,
        legalHold: true,
      }),
      200
    )
    assert.isTrue(current.legalHold)
    assert.equal(code(await ctx.http.delete(`/api/v1/documents/${doc.id}`)), 'DOCUMENT_LEGAL_HOLD')
    current = await must<any>(
      await ctx.http.patch(`/api/v1/documents/${doc.id}`, {
        version: current.version,
        legalHold: false,
      }),
      200
    )
    // Versão desactualizada: 409.
    const stale = await ctx.http.patch(`/api/v1/documents/${doc.id}`, { version: 1, title: 'x' })
    assert.equal(stale.status(), 409)
    assert.equal(code(stale), 'STALE_VERSION')

    assert.equal((await ctx.http.delete(`/api/v1/documents/${doc.id}`)).status(), 204)
    assert.equal((await ctx.http.get(`/api/v1/documents/${doc.id}`)).status(), 404)
    assert.equal(
      (await ctx.http.getRaw(`/api/v1/attachments/${doc.current.attachmentId}/download`)).status,
      404
    )
    const row = await owner<any>(
      `select status from attachments where id = '${doc.current.attachmentId}'`,
      ctx.tenant
    )
    assert.equal(row[0].status, 'DELETED')
    await assert.rejects(() => owner(`delete from documents`, ctx.tenant), /DOCUMENT_IMMUTABLE/)
  })

  test('anexos de recursos: ligar (idempotente), listar e desligar; recurso alheio é recusado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const state = { allowed: true }
    registerDocumentResource('teste_anexos', {
      permission: 'customer.read',
      protected: false,
      exists: async () => state.allowed,
    })
    const resourceId = '33333333-3333-4333-8333-333333333333'
    const attachmentId = await available(ctx.http, 'pdf assinado')
    const body = { resourceType: 'teste_anexos', resourceId, attachmentId, category: 'assinado' }
    const created = await ctx.http.post('/api/v1/resource-attachments', body)
    assert.equal(created.status(), 201)
    const again = await ctx.http.post('/api/v1/resource-attachments', body)
    assert.equal(again.status(), 200)
    assert.equal(again.body().data.id, created.body().data.id)
    const listed = await must<any[]>(
      await ctx.http.get(
        `/api/v1/resource-attachments?resourceType=teste_anexos&resourceId=${resourceId}`
      ),
      200
    )
    assert.lengthOf(listed, 1)
    assert.equal(listed[0].fileName, 'nota.txt')
    // O anexo vê-se por quem vê o recurso.
    const member = await memberWith(ctx, ['document.read', 'customer.read'])
    assert.equal(
      (await member.http.getRaw(`/api/v1/attachments/${attachmentId}/download`)).status,
      200
    )
    const blind = await memberWith(ctx, ['document.read'])
    assert.equal(
      (await blind.http.getRaw(`/api/v1/attachments/${attachmentId}/download`)).status,
      404
    )
    assert.equal(
      (
        await blind.http.get(
          `/api/v1/resource-attachments?resourceType=teste_anexos&resourceId=${resourceId}`
        )
      ).status(),
      404
    )
    assert.equal(
      code(await ctx.http.post('/api/v1/resource-attachments', { ...body, resourceType: 'x' })),
      'RESOURCE_TYPE_UNKNOWN'
    )
    state.allowed = false
    assert.equal(
      code(
        await ctx.http.post('/api/v1/resource-attachments', {
          ...body,
          attachmentId: await available(ctx.http, 'b'),
        })
      ),
      'RESOURCE_NOT_FOUND'
    )
    state.allowed = true
    assert.equal(
      (await ctx.http.delete(`/api/v1/resource-attachments/${created.body().data.id}`)).status(),
      204
    )
    assert.equal(
      (await ctx.http.delete(`/api/v1/resource-attachments/${created.body().data.id}`)).status(),
      404
    )
  })

  test('as faturas, encomendas e clientes são recursos registados', async ({ client, assert }) => {
    const ctx = await setup(client)
    const id = '44444444-4444-4444-8444-444444444444'
    const attachmentId = await available(ctx.http, 'x')
    for (const resourceType of ['invoice', 'sales_order', 'customer']) {
      const r = await ctx.http.post('/api/v1/resource-attachments', {
        resourceType,
        resourceId: id,
        attachmentId,
      })
      // O módulo dono existe mas não está licenciado/activado neste tenant: o recurso não se encontra.
      assert.notEqual(r.status(), 500)
      assert.notEqual(code(r), 'RESOURCE_TYPE_UNKNOWN')
    }
  })
})

const schemaFor = (extra: unknown[] = []) => ({
  variables: [
    { name: 'cliente', label: 'Cliente', type: 'string' },
    { name: 'total', label: 'Total', type: 'decimal' },
    ...extra,
  ],
})

async function newTemplate(http: Http, extra: Record<string, unknown> = {}) {
  return must<any>(
    await http.post('/api/v1/templates', {
      code: `modelo_${Math.random().toString(36).slice(2, 8)}`,
      name: 'Modelo de teste',
      channel: 'DOCUMENT',
      ...extra,
    }),
    201
  )
}

const draft = (
  http: Http,
  templateId: string,
  body = 'Cliente: {{cliente}}\nTotal: {{total}} AOA',
  extra = {}
) =>
  http.post(`/api/v1/templates/${templateId}/versions`, {
    body,
    variableSchema: schemaFor(),
    locale: 'pt-AO',
    ...extra,
  })

test.group('documentos | modelos e geração de PDF', (group) => {
  hooks(group)

  test('o corpo só aceita variáveis declaradas; funções, includes e URLs são recusados', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const t = await newTemplate(ctx.http)
    for (const [body, expected] of [
      ['Olá {{cliente}} {{total}}', 201],
      ['{{ outra }}', 422],
      ['{{ now() }}', 422],
      ['{{> incluir }}', 422],
      ['{{ http://exemplo.invalid/x }}', 422],
      ['{{ cliente | upper }}', 422],
      ['{{#each itens}}', 422],
      ['{{ aberto', 422],
    ] as const) {
      const r = await draft(ctx.http, t.id, body)
      assert.equal(r.status(), expected, body)
    }
    const dup = await ctx.http.post('/api/v1/templates', {
      code: t.code,
      name: 'x',
      channel: 'DOCUMENT',
    })
    assert.equal(dup.status(), 409)
    assert.equal(code(dup), 'TEMPLATE_CODE_TAKEN')
    assert.equal(
      (
        await ctx.http.post('/api/v1/templates', { code: 'Mau Codigo', name: 'x', channel: 'FAX' })
      ).status(),
      422
    )
  })

  test('rascunhos editam-se; publicar torna a versão imutável (até por SQL) e retira a anterior', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const t = await newTemplate(ctx.http)
    const v1 = await must<any>(await draft(ctx.http, t.id), 201)
    assert.deepInclude(v1, { revision: 1, status: 'DRAFT' })
    const edited = await must<any>(
      await ctx.http.put(`/api/v1/templates/${t.id}/versions/${v1.id}`, {
        version: v1.version,
        body: 'Novo texto {{cliente}}',
        variableSchema: schemaFor(),
      }),
      200
    )
    assert.equal(edited.body, 'Novo texto {{cliente}}')
    const stale = await ctx.http.put(`/api/v1/templates/${t.id}/versions/${v1.id}`, {
      version: v1.version,
      body: 'x',
      variableSchema: schemaFor(),
    })
    assert.equal(stale.status(), 409)

    const published = await must<any>(
      await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v1.id}/publish`, {}),
      200
    )
    assert.equal(published.status, 'PUBLISHED')
    assert.isOk(published.publishedAt)
    const frozen = await ctx.http.put(`/api/v1/templates/${t.id}/versions/${v1.id}`, {
      version: published.version,
      body: 'x',
      variableSchema: schemaFor(),
    })
    assert.equal(frozen.status(), 409)
    assert.equal(code(frozen), 'TEMPLATE_VERSION_IMMUTABLE')
    assert.equal(
      (await ctx.http.delete(`/api/v1/templates/${t.id}/versions/${v1.id}`)).status(),
      409
    )
    await assert.rejects(
      () =>
        owner(`update template_versions set body = 'adulterado' where id = '${v1.id}'`, ctx.tenant),
      /TEMPLATE_VERSION_IMMUTABLE/
    )
    await assert.rejects(
      () => owner(`delete from template_versions where id = '${v1.id}'`, ctx.tenant),
      /TEMPLATE_VERSION_IMMUTABLE/
    )
    assert.equal(
      code(await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v1.id}/publish`, {})),
      'TEMPLATE_NOT_DRAFT'
    )

    const v2 = await must<any>(await draft(ctx.http, t.id, 'Segunda versão {{cliente}}'), 201)
    assert.equal(v2.revision, 2)
    await must(await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v2.id}/publish`, {}), 200)
    const detail = await must<any>(await ctx.http.get(`/api/v1/templates/${t.id}`), 200)
    assert.deepEqual(
      detail.versions.map((v: any) => [v.revision, v.status]),
      [
        [2, 'PUBLISHED'],
        [1, 'RETIRED'],
      ]
    )
    assert.equal(detail.template.publishedRevision, 2)
    // Um rascunho apaga-se.
    const v3 = await must<any>(await draft(ctx.http, t.id), 201)
    assert.equal(
      (await ctx.http.delete(`/api/v1/templates/${t.id}/versions/${v3.id}`)).status(),
      204
    )
  })

  test('publicar exige template.publish; gerir não basta', async ({ client, assert }) => {
    const ctx = await setup(client)
    const manager = await memberWith(ctx, ['template.read', 'template.manage'])
    const t = await newTemplate(manager.http)
    const v = await must<any>(await draft(manager.http, t.id), 201)
    assert.equal(
      (await manager.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/publish`, {})).status(),
      403
    )
    const reader = await memberWith(ctx, ['template.read'])
    assert.equal((await reader.http.get('/api/v1/templates')).status(), 200)
    assert.equal(
      (
        await reader.http.post('/api/v1/templates', { code: 'abc', name: 'x', channel: 'DOCUMENT' })
      ).status(),
      403
    )
    const publisher = await memberWith(ctx, ['template.publish'])
    assert.equal(
      (
        await publisher.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/publish`, {})
      ).status(),
      200
    )
  })

  test('a pré-visualização escapa HTML, não grava nada e valida os valores', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const t = await newTemplate(ctx.http, { channel: 'EMAIL' })
    const v = await must<any>(
      await draft(ctx.http, t.id, '<p>Olá {{cliente}}</p> total {{total}}'),
      201
    )
    const preview = await must<any>(
      await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/preview`, {
        variables: { cliente: '<script>alert(1)</script> {{total}}', total: '10.50' },
      }),
      200
    )
    assert.equal(
      preview.html,
      '&lt;p&gt;Olá &lt;script&gt;alert(1)&lt;/script&gt; {{total}}&lt;/p&gt; total 10.50'
    )
    assert.include(preview.text, '<script>alert(1)</script> {{total}}')
    const bad = await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/preview`, {
      variables: { cliente: 'x', total: 'dez' },
    })
    assert.equal(bad.status(), 422)
    const unknown = await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/preview`, {
      variables: { cliente: 'x', total: '1', outra: 'y' },
    })
    assert.equal(unknown.status(), 422)
    const versions = await must<any>(await ctx.http.get(`/api/v1/templates/${t.id}`), 200)
    assert.lengthOf(versions.versions, 1)
  })

  test('gerar PDF: guarda a versão do modelo e os valores; mudar o modelo não altera o PDF emitido', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const t = await newTemplate(ctx.http)
    // Sem versão publicada: 409.
    const none = await ctx.http.post(`/api/v1/templates/${t.id}/generate`, {
      title: 'Proposta',
      variables: { cliente: 'Ana', total: '10' },
    })
    assert.equal(code(none), 'TEMPLATE_NOT_PUBLISHED')
    const v1 = await must<any>(
      await draft(ctx.http, t.id, 'Proposta para {{cliente}}. Total: {{total}} AOA.'),
      201
    )
    await must(await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v1.id}/publish`, {}), 200)

    const generate = (title: string, variables: Record<string, unknown>, extra = {}) =>
      ctx.http.post(`/api/v1/templates/${t.id}/generate`, {
        title,
        variables,
        visibility: 'TENANT',
        ...extra,
      })
    const doc = await must<any>(
      await generate('Proposta Ana', { cliente: 'Ana Açúcar', total: '1500.50' }),
      201
    )
    assert.equal(doc.current.mimeType, 'application/pdf')
    assert.equal(doc.current.fileName, 'Proposta Ana.pdf')
    const pdfBefore = await ctx.http.getRaw(
      `/api/v1/attachments/${doc.current.attachmentId}/download`
    )
    assert.equal(pdfBefore.status, 200)
    assert.equal(pdfBefore.buffer.subarray(0, 5).toString(), '%PDF-')
    assert.include(
      pdfBefore.buffer.toString('latin1'),
      '(Proposta para Ana A\\347\\372car. Total: 1500.50 AOA.)'
    )
    const detailBefore = await must<any>(await ctx.http.get(`/api/v1/documents/${doc.id}`), 200)
    const snapshot = await owner<any>(
      `select template_version_id, generated_values from document_versions where document_id = '${doc.id}'`,
      ctx.tenant
    )
    assert.equal(snapshot[0].template_version_id, v1.id)
    assert.deepEqual(snapshot[0].generated_values, { cliente: 'Ana Açúcar', total: '1500.50' })

    // Publicar uma nova versão do modelo, com outro texto.
    const v2 = await must<any>(await draft(ctx.http, t.id, 'TEXTO NOVO {{cliente}} {{total}}'), 201)
    await must(await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v2.id}/publish`, {}), 200)
    const pdfAfter = await ctx.http.getRaw(
      `/api/v1/attachments/${doc.current.attachmentId}/download`
    )
    assert.isTrue(pdfAfter.buffer.equals(pdfBefore.buffer))
    const detailAfter = await must<any>(await ctx.http.get(`/api/v1/documents/${doc.id}`), 200)
    assert.deepEqual(detailAfter.versions, detailBefore.versions)
    const row = await owner<any>(
      `select a.checksum, a.size_bytes from attachments a where a.id = '${doc.current.attachmentId}'`,
      ctx.tenant
    )
    assert.equal(row[0].checksum, sha(pdfBefore.buffer))
    assert.equal(Number(row[0].size_bytes), pdfBefore.buffer.length)
    // O novo documento usa a versão nova.
    const doc2 = await must<any>(
      await generate('Proposta nova', { cliente: 'Rui', total: '2' }),
      201
    )
    const pdf2 = await ctx.http.getRaw(`/api/v1/attachments/${doc2.current.attachmentId}/download`)
    assert.include(pdf2.buffer.toString('latin1'), 'TEXTO NOVO Rui 2')
    // Gerar de novo num documento existente acrescenta uma versão.
    const again = await must<any>(
      await generate('Proposta Ana', { cliente: 'Ana', total: '3' }, { documentId: doc.id }),
      201
    )
    assert.equal(again.id, doc.id)
    assert.equal(again.current.revision, 2)
  })

  test('gerar valida valores, canal e recurso; o PDF não inclui o que não foi declarado', async ({
    client,
    assert,
  }) => {
    const ctx = await setup(client)
    const t = await newTemplate(ctx.http)
    const v = await must<any>(await draft(ctx.http, t.id), 201)
    await must(await ctx.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/publish`, {}), 200)
    const call = (body: Record<string, unknown>) =>
      ctx.http.post(`/api/v1/templates/${t.id}/generate`, body)
    assert.equal((await call({ title: '', variables: {} })).status(), 422)
    assert.equal((await call({ title: 'x', variables: { cliente: 'a' } })).status(), 422)
    assert.equal(
      (await call({ title: 'x', variables: { cliente: 'a', total: '1', extra: 'b' } })).status(),
      422
    )
    assert.equal(
      code(
        await call({
          title: 'x',
          variables: { cliente: 'a', total: '1' },
          resourceType: 'nada',
          resourceId: '55555555-5555-4555-8555-555555555555',
          visibility: 'RESOURCE',
        })
      ),
      'RESOURCE_TYPE_UNKNOWN'
    )
    // Só os modelos de documento geram PDF.
    const email = await newTemplate(ctx.http, { channel: 'EMAIL' })
    const ev = await must<any>(await draft(ctx.http, email.id), 201)
    await must(
      await ctx.http.post(`/api/v1/templates/${email.id}/versions/${ev.id}/publish`, {}),
      200
    )
    const refused = await ctx.http.post(`/api/v1/templates/${email.id}/generate`, {
      title: 'x',
      variables: { cliente: 'a', total: '1' },
    })
    assert.equal(code(refused), 'TEMPLATE_NOT_DOCUMENT')
    // Quota: o PDF gerado conta.
    documentServices().limits.tenantQuotaBytes = 10
    const over = await call({ title: 'x', variables: { cliente: 'a', total: '1' } })
    assert.equal(code(over), 'QUOTA_EXCEEDED')
    assert.equal((await owner<any>(`select count(*)::int as n from documents`, ctx.tenant))[0].n, 0)
  })

  test('modelos e documentos de um tenant não existem para outro', async ({ client, assert }) => {
    const a = await setup(client)
    const b = await setup(client)
    const t = await newTemplate(a.http)
    const v = await must<any>(await draft(a.http, t.id), 201)
    const doc = await createDocument(a.http, await available(a.http))
    assert.equal((await b.http.get(`/api/v1/templates/${t.id}`)).status(), 404)
    assert.equal(
      (await b.http.post(`/api/v1/templates/${t.id}/versions/${v.id}/publish`, {})).status(),
      404
    )
    assert.equal(
      (
        await b.http.post(`/api/v1/templates/${t.id}/generate`, { title: 'x', variables: {} })
      ).status(),
      404
    )
    assert.equal((await b.http.get(`/api/v1/documents/${doc.id}`)).status(), 404)
    assert.deepEqual(await must<any[]>(await b.http.get('/api/v1/documents'), 200), [])
    assert.deepEqual(await must<any[]>(await b.http.get('/api/v1/templates'), 200), [])
  })
})

export type { Actor }
