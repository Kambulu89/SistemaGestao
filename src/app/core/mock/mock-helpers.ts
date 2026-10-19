import { map, type Observable, timer } from 'rxjs';
import type { ApiError } from '../api/api-error.model';

/** Latência simulada das respostas; os testes põem-na a 0. */
export const mockSettings = { latencyMs: 300 };

/** Responde após uma latência simulada; excepções lançadas tornam-se erros do observable. */
export function respond<T>(produce: () => T): Observable<T> {
  return timer(mockSettings.latencyMs).pipe(map(produce));
}

export function mockError(status: number, message: string): ApiError {
  return { status, message };
}
