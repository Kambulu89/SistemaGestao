/** Resultado de verificar uma dependência. `detail` nunca inclui mensagens internas. */
export interface ProbeResult {
  name: string
  ok: boolean
}

/** Porta: uma dependência de que o serviço precisa para aceitar tráfego (base de dados, cache…). */
export interface ReadinessProbe {
  readonly name: string
  check(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 2000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Caso de uso: o serviço está pronto quando todas as dependências respondem dentro do limite.
 * As sondas correm em paralelo e uma falha numa não esconde as outras.
 */
export class CheckReadiness {
  constructor(
    private readonly probes: ReadinessProbe[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  async execute(): Promise<{ ready: boolean; checks: ProbeResult[] }> {
    const checks = await Promise.all(
      this.probes.map(async (probe): Promise<ProbeResult> => {
        try {
          await withTimeout(probe.check(), this.timeoutMs)
          return { name: probe.name, ok: true }
        } catch {
          return { name: probe.name, ok: false }
        }
      })
    )
    return { ready: checks.every((c) => c.ok), checks }
  }
}
