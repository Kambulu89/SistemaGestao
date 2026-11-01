export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** Permissões ao nível da plataforma (vazio = não é administrador global). */
  readonly platformPermissions: readonly string[];
}

/**
 * Sessão autenticada. O token da sessão é um cookie `HttpOnly` que o JavaScript não vê: aqui só
 * ficam o utilizador, o token anti-CSRF (em memória, nunca em storage) e a expiração.
 */
export interface Session {
  readonly user: User;
  readonly csrfToken: string;
  /** Data ISO 8601. */
  readonly expiresAt: string;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}
