import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { effectivePermissions } from '#modules/rbac/index'
import { money, parseScaled } from '#modules/procurement/domain/requisitions'

/*
 * Etapas de aprovação das requisições de compra (9.2): por valor mínimo em moeda funcional, opcionalmente só para uma
 * entidade legal e exigindo um perfil. Ler com qualquer permissão de compras; alterar com `procurement.settings` (rota).
 * As requisições já submetidas guardam as etapas que lhes foram exigidas: mudar a configuração não as altera.
 */

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/
const view = (r: any) => ({
  id: r.id as string,
  version: Number(r.version),
  code: r.code as string,
  name: r.name as string,
  sequence: Number(r.sequence),
  minAmount: money(parseScaled(String(r.min_amount), 2) ?? 0n),
  legalEntity: r.legal_entity_id
    ? { id: r.legal_entity_id as string, code: r.le_code as string }
    : null,
  approverRole: r.approver_role_id
    ? { id: r.approver_role_id as string, code: r.role_code as string, name: r.role_name as string }
    : null,
  status: r.status as string,
})
const SELECT = `select a.*, le.code as le_code, ro.code as role_code, ro.name as role_name
  from purchase_approval_levels a
  left join legal_entities le on le.tenant_id = a.tenant_id and le.id = a.legal_entity_id
  left join roles ro on ro.tenant_id = a.tenant_id and ro.id = a.approver_role_id`

export class ApprovalLevelService {
  list(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const held = (await effectivePermissions(scope)).tenant
      const own = (await effectivePermissions(scope)).own
      if (![...held, ...own].some((p) => p.startsWith('procurement.')))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar a configuração das compras.')
      const r = await scope.trx.rawQuery(
        `${SELECT} where a.tenant_id = ? order by a.sequence, a.code`,
        [context.tenantId]
      )
      return (r.rows as any[]).map(view)
    })
  }

  save(context: TenantContext, id: string | null, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const issues: ErrorDetail[] = []
      const v: Record<string, unknown> = {}
      const creating = id === null
      if (creating) {
        const c = typeof input.code === 'string' ? input.code.trim() : ''
        if (!CODE.test(c))
          issues.push({
            path: 'code',
            code: 'INVALID_CODE',
            message: 'Código: até 30 letras, dígitos ou . _ -.',
          })
        else v.code = c.toUpperCase()
      } else if ('code' in input)
        issues.push({ path: 'code', code: 'FIXED', message: 'O código não muda.' })
      if ('name' in input || creating) {
        const n = typeof input.name === 'string' ? input.name.trim() : ''
        if (n.length < 2 || n.length > 120)
          issues.push({ path: 'name', code: 'LENGTH', message: 'Nome: 2 a 120 caracteres.' })
        else v.name = n
      }
      if ('sequence' in input || creating) {
        const n = Number(input.sequence)
        if (!Number.isInteger(n) || n < 1 || n > 99)
          issues.push({ path: 'sequence', code: 'INVALID', message: 'Ordem: 1 a 99.' })
        else v.sequence = n
      }
      if ('minAmount' in input || creating) {
        const m = parseScaled(input.minAmount, 2)
        if (m === null)
          issues.push({
            path: 'minAmount',
            code: 'INVALID',
            message: 'Valor mínimo ≥ 0, até 2 casas, em texto.',
          })
        else v.min_amount = money(m)
      }
      if ('legalEntityId' in input) {
        if (input.legalEntityId === null || input.legalEntityId === '') v.legal_entity_id = null
        else if (
          !isUuid(input.legalEntityId) ||
          !(
            await scope.trx.rawQuery(
              `select 1 from legal_entities where tenant_id = ? and id = ?`,
              [t, input.legalEntityId]
            )
          ).rows.length
        )
          issues.push({
            path: 'legalEntityId',
            code: 'NOT_FOUND',
            message: 'Entidade legal inexistente.',
          })
        else v.legal_entity_id = input.legalEntityId
      }
      if ('approverRoleId' in input) {
        if (input.approverRoleId === null || input.approverRoleId === '') v.approver_role_id = null
        else if (
          !isUuid(input.approverRoleId) ||
          !(
            await scope.trx.rawQuery(`select 1 from roles where tenant_id = ? and id = ?`, [
              t,
              input.approverRoleId,
            ])
          ).rows.length
        )
          issues.push({ path: 'approverRoleId', code: 'NOT_FOUND', message: 'Perfil inexistente.' })
        else v.approver_role_id = input.approverRoleId
      }
      if ('status' in input) {
        if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
          issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
        else v.status = input.status
      }
      if (issues.length) throw ApiError.validation(issues)
      let rowId = id
      let before: any = null
      if (creating) {
        const keys = Object.keys(v)
        await scope.trx.rawQuery('savepoint level_write')
        try {
          const r = await scope.trx.rawQuery(
            `insert into purchase_approval_levels (tenant_id, created_by, updated_by, ${keys.join(', ')})
             values (?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
            [t, context.userId, context.userId, ...keys.map((k) => v[k])] as never[]
          )
          rowId = (r.rows[0] as { id: string }).id
          await scope.trx.rawQuery('release savepoint level_write')
        } catch (error) {
          await scope.trx.rawQuery('rollback to savepoint level_write')
          if (String((error as Error).message).includes('purchase_approval_levels_code_unique'))
            throw ApiError.conflict('CODE_TAKEN', 'Já existe uma etapa com este código.')
          throw error
        }
      } else {
        if (!isUuid(id)) throw ApiError.notFound()
        const b = await scope.trx.rawQuery(
          `${SELECT} where a.tenant_id = ? and a.id = ? for update of a`,
          [t, id]
        )
        before = b.rows[0]
        if (!before) throw ApiError.notFound()
        if (Number(before.version) !== Number(input.expectedVersion))
          throw ApiError.versionConflict(Number(before.version))
        const keys = Object.keys(v)
        if (keys.length)
          await scope.trx.rawQuery(
            `update purchase_approval_levels set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
               version = version + 1 where tenant_id = ? and id = ?`,
            [...keys.map((k) => v[k]), context.userId, t, id] as never[]
          )
      }
      const after = (
        await scope.trx.rawQuery(`${SELECT} where a.tenant_id = ? and a.id = ?`, [
          t,
          rowId,
        ] as never[])
      ).rows[0]
      const a = view(after)
      const b = before ? view(before) : null
      await audit(scope, {
        action: `purchase_approval_level.${creating ? 'created' : 'updated'}`,
        entityType: 'purchase_approval_level',
        entityId: a.id,
        changes: Object.fromEntries(
          (['code', 'name', 'sequence', 'minAmount', 'status'] as const)
            .filter((k) => (b?.[k] ?? null) !== a[k])
            .map((k) => [k, { from: b?.[k] ?? null, to: a[k] }])
        ),
      })
      return a
    })
  }
}
