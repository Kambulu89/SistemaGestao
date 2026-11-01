/** Cabeçalho do selector de tenant. O servidor valida-o sempre contra a sessão e a membership activa. */
export const TENANT_HEADER = 'X-Tenant-Id';
/** Token anti-CSRF da sessão, exigido nos métodos de escrita. */
export const CSRF_HEADER = 'X-Csrf-Token';
