export const REASON_TEXT: Readonly<Record<string, string>> = {
  GRANTED: 'Um perfil concede a permissão e nenhuma política a impede.',
  NO_PERMISSION: 'Nenhum perfil atribuído (e válido) concede esta permissão.',
  UNIT_MISMATCH: 'O perfil que concede a permissão está limitado a outra unidade.',
  UNIT_OUT_OF_SCOPE: 'A unidade do recurso está fora do âmbito de acesso do membro.',
  POLICY_DENY: 'Uma política activa nega este acesso.',
  POLICY_ERROR: 'Uma política de «negar» não pôde ser avaliada: na dúvida, nega.',
  NO_ALLOW_POLICY_MATCHED: 'Há políticas «permitir», mas nenhuma se cumpre para este recurso.',
};

export type ResourceResult =
  | { readonly ok: true; readonly value: Record<string, unknown> | null }
  | { readonly ok: false; readonly message: string };

/** O recurso opcional do simulador: vazio, ou um objecto JSON (nunca outro tipo de valor). */
export function parseResource(text: string): ResourceResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: 'O recurso não é JSON válido.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'O recurso tem de ser um objecto JSON, p. ex. {"amount": 1500}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
