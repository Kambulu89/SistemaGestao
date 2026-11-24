import { randomUUID } from 'node:crypto'
import { ApiError } from '#shared/http/api_error'
import type { TenantScope } from '#modules/tenancy/index'
import {
  type FiscalPayload,
  type PollResult,
  PROVIDER_INFO,
  type ProviderCode,
  type Scenario,
  type SubmitResult,
} from '#modules/sales/domain/fiscal_integration'

/**
 * Adaptadores de integração fiscal (10.9). O contrato `FiscalIntegrationProvider` é o que um adaptador oficial terá de
 * cumprir: envio idempotente (chave por documento) que devolve um identificador de pedido, e consulta assíncrona do
 * resultado. Hoje só existe o SIMULADOR LOCAL; o adaptador da AGT está registado como indisponível e recusa qualquer
 * chamada — não há endpoints, assinaturas nem QR inventados.
 */
export interface FiscalIntegrationProvider {
  readonly code: ProviderCode
  availability(): { available: boolean; reason: string | null }
  submit(
    scope: TenantScope,
    req: { idempotencyKey: string; payload: FiscalPayload; payloadHash: string; scenario: Scenario }
  ): Promise<SubmitResult>
  poll(scope: TenantScope, req: { requestId: string; scenario: Scenario }): Promise<PollResult>
}

/**
 * Simulador local: guarda os pedidos recebidos na própria base (por chave de idempotência) e responde conforme o
 * cenário configurado — aceitar, rejeitar, aceitar com atraso (uma consulta pendente) ou indisponível. Tudo o que
 * devolve é marcado `SIM-…` e "simulação".
 */
class LocalSimulator implements FiscalIntegrationProvider {
  readonly code = 'LOCAL_SIMULATOR' as const
  availability() {
    return { available: true, reason: null }
  }

  async submit(
    scope: TenantScope,
    req: { idempotencyKey: string; payload: FiscalPayload; payloadHash: string; scenario: Scenario }
  ): Promise<SubmitResult> {
    if (req.scenario === 'UNAVAILABLE')
      return {
        outcome: 'TRANSIENT',
        code: 'SIM-503',
        message: 'Simulador indisponível (cenário de teste).',
      }
    const t = scope.context.tenantId
    const prev = (
      await scope.trx.rawQuery(
        `select request_id, payload_hash from fiscal_simulator_requests where tenant_id = ? and idempotency_key = ?`,
        [t, req.idempotencyKey]
      )
    ).rows[0] as any
    if (prev) {
      if (prev.payload_hash !== req.payloadHash)
        return {
          outcome: 'REJECTED',
          code: 'SIM-409',
          message: 'Simulação: a mesma chave já foi usada com outro conteúdo.',
        }
      return {
        outcome: 'RECEIVED',
        requestId: prev.request_id,
        code: 'SIM-202',
        message: 'Simulação: pedido já recebido (idempotente).',
      }
    }
    const requestId = `SIM-${randomUUID()}`
    await scope.trx.rawQuery(
      `insert into fiscal_simulator_requests (tenant_id, idempotency_key, request_id, payload_hash, scenario, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        req.idempotencyKey,
        requestId,
        req.payloadHash,
        req.scenario,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
    return {
      outcome: 'RECEIVED',
      requestId,
      code: 'SIM-202',
      message: 'Simulação: pedido recebido.',
    }
  }

  async poll(
    scope: TenantScope,
    req: { requestId: string; scenario: Scenario }
  ): Promise<PollResult> {
    const t = scope.context.tenantId
    const r = (
      await scope.trx.rawQuery(
        `update fiscal_simulator_requests set polls = polls + 1, version = version + 1, updated_at = now()
          where tenant_id = ? and request_id = ? returning polls, scenario`,
        [t, req.requestId]
      )
    ).rows[0] as any
    if (!r)
      return { outcome: 'REJECTED', code: 'SIM-404', message: 'Simulação: pedido desconhecido.' }
    const scenario = r.scenario as Scenario
    if (scenario === 'DELAYED' && Number(r.polls) < 2)
      return { outcome: 'PENDING', code: 'SIM-102', message: 'Simulação: em processamento.' }
    if (scenario === 'REJECT')
      return {
        outcome: 'REJECTED',
        code: 'SIM-422',
        message: 'Simulação: documento rejeitado (cenário de teste).',
      }
    return {
      outcome: 'ACCEPTED',
      code: 'SIM-000',
      message: 'Simulação: documento aceite. Não é uma validação da AGT.',
    }
  }
}

/** Adaptador oficial: registado para o contrato, bloqueado até haver especificação verificada e certificação. */
class AgtOfficial implements FiscalIntegrationProvider {
  readonly code = 'AGT_OFFICIAL' as const
  availability() {
    return { available: false, reason: PROVIDER_INFO.AGT_OFFICIAL.reason }
  }
  private refuse(): never {
    throw ApiError.conflict('PROVIDER_UNAVAILABLE', PROVIDER_INFO.AGT_OFFICIAL.reason!)
  }
  async submit(): Promise<SubmitResult> {
    this.refuse()
  }
  async poll(): Promise<PollResult> {
    this.refuse()
  }
}

const REGISTRY: Record<ProviderCode, FiscalIntegrationProvider> = {
  LOCAL_SIMULATOR: new LocalSimulator(),
  AGT_OFFICIAL: new AgtOfficial(),
}

export const fiscalProvider = (code: ProviderCode) => REGISTRY[code]
