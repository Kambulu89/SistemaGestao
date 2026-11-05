import { signal } from '@angular/core';
import { ApiError } from '../core/api';

/** Estado de um carregamento (a carregar / erro / valor) com recarga explícita. */
export class Loadable<T> {
  readonly value = signal<T | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal<ApiError | null>(null);

  constructor(private readonly fn: () => Promise<T>) {}

  async load() {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.value.set(await this.fn());
    } catch (error) {
      this.error.set(ApiError.from(error));
    } finally {
      this.loading.set(false);
    }
  }
}

/** Acção assíncrona com estado (a decorrer, erro do servidor). */
export class Action {
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);

  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.busy.set(true);
    this.error.set(null);
    try {
      return await fn();
    } catch (error) {
      this.error.set(ApiError.from(error));
      return undefined;
    } finally {
      this.busy.set(false);
    }
  }

  field(path: string) {
    return this.error()?.field(path) ?? null;
  }
}
