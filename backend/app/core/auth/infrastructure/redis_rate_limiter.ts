import redis from '@adonisjs/redis/services/main'
import type { RateLimiter, RateLimitResult } from '#core/auth/application/ports'

const PREFIX = 'ratelimit:'

/**
 * Contador de janela fixa. INCR e EXPIRE não são atómicos, mas o contador auto-repara-se: se o
 * processo morrer entre os dois, a chave fica sem validade e o pedido seguinte volta a defini-la
 * (`ttl < 0`), por isso nunca bloqueia uma conta para sempre. Não se usa scripting do Redis para
 * manter a regra R5 (nada de eval) sem excepções.
 */
export class RedisRateLimiter implements RateLimiter {
  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = PREFIX + key
    const count = await redis.incr(redisKey)
    let ttl = await redis.ttl(redisKey)
    if (count === 1 || ttl < 0) {
      await redis.expire(redisKey, windowSeconds)
      ttl = windowSeconds
    }
    return { allowed: count <= limit, retryAfterSeconds: ttl }
  }

  async reset(key: string) {
    await redis.del(PREFIX + key)
  }
}
