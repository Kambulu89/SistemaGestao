import { computed, inject, Injectable, signal } from '@angular/core';
import { type Observable, tap } from 'rxjs';
import { AuthGateway } from './auth.gateway';
import type { Credentials, Session } from './auth.model';

/**
 * Estado da sessão. Responsabilidade única: quem está autenticado.
 * A sessão vive num cookie `HttpOnly` gerido pelo servidor; aqui só há estado em memória
 * (utilizador e token anti-CSRF). Nada é guardado em `localStorage`/`sessionStorage`; ao recarregar
 * a página, `restore()` recupera a sessão do servidor.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly gateway = inject(AuthGateway);

  private readonly _session = signal<Session | null>(null);

  readonly session = this._session.asReadonly();
  readonly user = computed(() => this._session()?.user ?? null);
  readonly csrfToken = computed(() => this._session()?.csrfToken ?? null);
  readonly isAuthenticated = computed(() => this._session() !== null);

  login(credentials: Credentials): Observable<Session> {
    return this.gateway.login(credentials).pipe(tap((session) => this._session.set(session)));
  }

  /** Arranque da aplicação: recupera a sessão do cookie, se existir. */
  restore(): Observable<Session | null> {
    return this.gateway.restore().pipe(tap((session) => this._session.set(session)));
  }

  /**
   * Termina a sessão: pede ao servidor para a revogar e limpa o estado local de imediato. O pedido
   * é emitido antes de limpar, para ainda levar o token anti-CSRF.
   */
  logout(): void {
    this.gateway.logout().subscribe({ error: () => undefined });
    this._session.set(null);
  }

  /** O servidor já não reconhece a sessão (401): limpa só o estado local, sem outro pedido. */
  expireLocally(): void {
    this._session.set(null);
  }

  requestPasswordReset(email: string): Observable<void> {
    return this.gateway.requestPasswordReset(email);
  }

  resetPassword(token: string, newPassword: string): Observable<void> {
    return this.gateway.resetPassword(token, newPassword);
  }
}
