import redis from '@adonisjs/redis/services/main'
import type { ReadinessProbe } from '#core/health/application/readiness'

export class RedisProbe implements ReadinessProbe {
  readonly name = 'redis'

  async check() {
    const reply = await redis.ping()
    if (reply !== 'PONG') throw new Error('unexpected reply')
  }
}
