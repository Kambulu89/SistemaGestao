import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, ApiError } from './api';

export interface User {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
}

export interface TenantLink {
  id: string;
  code: string;
  name: string;
  status: string;
  membershipStatus: string;
  available: boolean;
}

/** Sessão do utilizador (cookie HttpOnly no servidor; aqui só o que a API devolve em `/auth/me`). */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly user = signal<User | null>(null);
  readonly tenants = signal<TenantLink[]>([]);
  readonly available = computed(() => this.tenants().filter((t) => t.available));
  private loaded: Promise<boolean> | null = null;

  /** Carrega a sessão uma vez (ou de novo com `force`); `false` se não houver sessão válida. */
  ensure(force = false): Promise<boolean> {
    if (!this.loaded || force) {
      this.loaded = this.api
        .get<{ user: User; tenants: TenantLink[] }>('auth/me')
        .then((me) => {
          this.set(me);
          return true;
        })
        .catch((error: unknown) => {
          if (ApiError.from(error).status === 401) {
            this.clear();
            return false;
          }
          this.loaded = null;
          throw error;
        });
    }
    return this.loaded;
  }

  async login(email: string, password: string) {
    const me = await this.api.post<{ user: User; tenants: TenantLink[] }>('auth/login', {
      email,
      password,
    });
    this.set(me);
    this.loaded = Promise.resolve(true);
    return me;
  }

  async logout() {
    try {
      await this.api.post('auth/logout');
    } finally {
      this.clear();
    }
  }

  clear() {
    this.user.set(null);
    this.tenants.set([]);
    this.loaded = Promise.resolve(false);
  }

  private set(me: { user: User; tenants: TenantLink[] }) {
    this.user.set(me.user);
    this.tenants.set(me.tenants);
  }
}
