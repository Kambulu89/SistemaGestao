import type { Clock } from '#core/auth/application/ports'

export class SystemClock implements Clock {
  now() {
    return new Date()
  }
}
