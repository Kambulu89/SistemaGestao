import { signal } from '@angular/core';
import { ApiError } from '../core/api';

/** Estado de um carregamento (a carregar / erro / valor) com recarga explícita. */
export class Loadable<T> {
  readonly value = signal<T | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal<ApiError | null>(null);

  private seq = 0;

  constructor(private readonly fn: () => Promise<T>) {}

  /** Só a resposta do último pedido conta (pesquisa rápida não mostra resultados antigos). */
  async load() {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const value = await this.fn();
      if (seq === this.seq) this.value.set(value);
    } catch (error) {
      if (seq === this.seq) this.error.set(ApiError.from(error));
    } finally {
      if (seq === this.seq) this.loading.set(false);
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
