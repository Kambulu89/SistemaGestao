import db from '@adonisjs/lucid/services/db'

/**
 * Contador de janela fixa no PostgreSQL (sem Redis): uma só instrução incrementa ou, se a janela acabou, recomeça; por
 * isso dois pedidos simultâneos nunca contam o mesmo valor. As chaves não levam dados pessoais em claro.
 */
export async function hitRateLimit(key: string, limit: number, windowSeconds: number) {
  const result = await db.connection('runtime').rawQuery(
    `insert into rate_limit_counters (key, hits, window_ends_at)
     values (?, 1, now() + make_interval(secs => ?))
     on conflict (key) do update set
       hits = case when rate_limit_counters.window_ends_at <= now() then 1 else rate_limit_counters.hits + 1 end,
       window_ends_at = case when rate_limit_counters.window_ends_at <= now()
                             then now() + make_interval(secs => ?) else rate_limit_counters.window_ends_at end,
       updated_at = now()
     returning hits, greatest(1, ceil(extract(epoch from window_ends_at - now())))::int as retry_after`,
    [key, windowSeconds, windowSeconds]
  )
  const row = result.rows[0] as { hits: number; retry_after: number }
  return { allowed: row.hits <= limit, retryAfterSeconds: row.retry_after }
}

export async function resetRateLimit(key: string) {
  await db.connection('runtime').rawQuery('delete from rate_limit_counters where key = ?', [key])
}
