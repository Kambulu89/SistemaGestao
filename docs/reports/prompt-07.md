# Relatório — Prompt 07 (recursos humanos)

Estado: **7.1 implementado e verificado** no branch `claude/pensive-clarke-5gm075`. Blocos 7.2 a 7.13 seguem, um de
cada vez. Decisão D-024.

Nada aqui alega conformidade com a legislação laboral ou fiscal angolana: taxas de IRT e INSS não estão no código e
terão de ser configuradas pela empresa e confirmadas na legislação em vigor quando chegarem os blocos de processamento.

## Matriz AS-IS / TO-BE

| Bloco           | AS-IS (fim do Prompt 06)                                        | TO-BE                                                                                                                                                                                                          | Estado |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 7.1 Colaborador | Estrutura organizacional e memberships; nenhuma ficha de pessoa | Ficha 360 (identificação, organização, dados pessoais, morada, emergência, formação, banco, anexos), âmbitos de RH (empresa/entidade/filial/departamento/próprio), visibilidade por campo, auditoria reservada | Feito  |

## Modelo

- Migração `0022_create_hr_employees`: tabela `employees` (tenant, RLS) com referências à estrutura (entidade legal,
  filial, departamento, cargo, centro de custo), superior (auto-referência), membership opcional; dados pessoais em
  colunas próprias. Únicos: código, NIF, INSS e membership (parciais). Checks: estado, não ser o próprio superior,
  nascimento antes da admissão.
- Colaborador ≠ utilizador: a membership é opcional e serve só para self-service futuro.

## Endpoints (todos com `auth`, `tenant` e a funcionalidade `hr`; âmbito verificado no serviço)

- `GET /hr/employees` (`hr.read`, filtrado pelo âmbito; pesquisa, estado, entidade, filial, departamento, cargo,
  superior; ordenação por código, nome, admissão, estado; nunca dados pessoais)
- `POST /hr/employees` (`hr.manage` no âmbito da colocação; dados pessoais exigem `hr.sensitive`)
- `GET /hr/employees/:id` (`hr.read`; dados pessoais só com `hr.sensitive` no âmbito; `access` e `directReports`)
- `PATCH /hr/employees/:id` (`hr.manage` na colocação antiga e na nova; `expectedVersion`)
- `POST /hr/employees/:id/status` (`hr.manage`; activo ↔ suspenso, motivo opcional; cessação fica para 7.11)
- Anexos: `entityType=employee` nas rotas de anexos existentes, com acesso aos dados pessoais.

Erros: `OUT_OF_SCOPE`, `SENSITIVE_FORBIDDEN`, `OTHER_LEGAL_ENTITY`, `OTHER_BRANCH`, `INACTIVE`, `CYCLE` (superior),
`CODE_TAKEN`, `TAX_ID_TAKEN`, `SOCIAL_SECURITY_TAKEN`, `MEMBERSHIP_TAKEN`, `USE_STATUS_ACTION`, `INVALID_TRANSITION`,
`VERSION_CONFLICT`; validação por campo (`INVALID_IBAN`, `FUTURE_DATE`, …).

## Ecrãs

Novo domínio "Pessoas e Talento" → Colaboradores (visível com `hr.read` em qualquer âmbito):

- Lista (EntityListPage): pesquisa, filtros de estado e departamento na URL, colunas configuráveis, exportação CSV,
  entidade legal da barra superior aplicada.
- Novo colaborador (EntityFormPage) com secções; as secções de dados pessoais só aparecem a quem os pode escrever.
- Ficha (PageDetail + barra de acções fixa): edição só do que mudou, suspender/reactivar com confirmação, resumo,
  anexos (só com acesso a dados pessoais) e histórico de auditoria. Sem acesso aos dados pessoais, um cartão
  "Dados reservados" substitui essas secções; sem `hr.manage`, a ficha é só de leitura.
- Sem rascunhos no browser (dados pessoais).

## Testes e evidências

- Backend funcional `hr_employees.spec.ts`: ficha (criação, coerência com a estrutura, unicidade, versão, ciclos,
  estado); âmbitos (chefia por departamento com subdepartamentos, RH por entidade, próprio, dados pessoais); anexos.
- Backend unitário `hr_domain.spec.ts`: normalização e erros por campo, auditoria reservada, âmbitos.
- `isolation_matrix` (colaborador e anexos de outra empresa → 404), `routes_protection` (5 rotas justificadas),
  esquema e arquitectura.
- Frontend: `hr/model.spec.ts` (payload de criação/edição, nunca campos sensíveis sem acesso) e navegação.
- Browser (Playwright, 5 passos): activar `hr` na empresa; criar com IBAN inválido recusado junto do campo e depois
  normalizado; alterar e suspender; filtro de estado na URL sem dados pessoais na tabela; leitor sem `hr.sensitive`
  vê a ficha só de leitura com dados reservados. Sem erros na consola.

## Pendências

- 7.2 a 7.13 (contratos, cargos/salários, assiduidade, férias, processamento salarial, etc.).
- Taxas de IRT/INSS: configuráveis e confirmadas na legislação, nunca fixas no código.
- 6.9 SAF-T continua bloqueado pela especificação oficial.
