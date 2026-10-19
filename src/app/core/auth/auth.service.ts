import { computed, inject, Injectable, signal } from '@angular/core';
import { type Observable, tap } from 'rxjs';
import { AuthGateway } from './auth.gateway';
import type { Credentials, Session } from './auth.model';

const STORAGE_KEY = 'sg-session';

/**
 * Estado da sessão. Responsabilidade única: quem está autenticado.
 * Nota de segurança: guardar o token em storage do browser expõe-o a XSS; quando existir
 * backend, preferir cookie httpOnly e remover a persistência do token daqui.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly gateway = inject(AuthGateway);

  private readonly _session = signal<Session | null>(this.restore());

  readonly session = this._session.asReadonly();
  readonly user = computed(() => this._session()?.user ?? null);
  readonly accessToken = computed(() => this._session()?.accessToken ?? null);
  readonly isAuthenticated = computed(() => this._session() !== null);

  login(credentials: Credentials): Observable<Session> {
    return this.gateway.login(credentials).pipe(
      tap((session) => {
        this._session.set(session);
        this.persist(session);
      }),
    );
  }

  logout(): void {
    this._session.set(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Sem storage: nada a limpar.
    }
  }

  requestPasswordReset(email: string): Observable<void> {
    return this.gateway.requestPasswordReset(email);
  }

  private persist(session: Session): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Sessão vale apenas em memória.
    }
  }

  private restore(): Session | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw) as Session;
      return new Date(session.expiresAt).getTime() > Date.now() ? session : null;
    } catch {
      return null;
    }
  }
}
