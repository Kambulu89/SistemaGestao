# Relatório — Prompt 07 (recursos humanos)

Estado: **7.1 a 7.3 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Blocos 7.4 a 7.13 seguem, um de
cada vez. Decisões D-024 a D-026.

Nada aqui alega conformidade com a legislação laboral ou fiscal angolana: taxas de IRT e INSS não estão no código e
terão de ser configuradas pela empresa e confirmadas na legislação em vigor quando chegarem os blocos de processamento.

## Matriz AS-IS / TO-BE

| Bloco                       | AS-IS (fim do Prompt 06)                                        | TO-BE                                                                                                                                                                                                                                                     | Estado |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 7.1 Colaborador             | Estrutura organizacional e memberships; nenhuma ficha de pessoa | Ficha 360 (identificação, organização, dados pessoais, morada, emergência, formação, banco, anexos), âmbitos de RH (empresa/entidade/filial/departamento/próprio), visibilidade por campo, auditoria reservada                                            | Feito  |
| 7.2 Recrutamento/onboarding | Nada                                                            | Vaga com remuneração autorizada aprovada (directa ou workflow), candidatos, candidaturas por etapas, entrevistas, avaliações, proposta aprovada e respondida, contratação que cria o colaborador e a checklist (documentos, conta, acessos, equipamentos) | Feito  |
| 7.3 Contratos/carreira      | Colocação só na ficha, sem histórico; sem contratos             | Contrato (tipo, datas, experiência, jornada, remuneração, estado) com adendas e renovações datadas, suspensão, retoma e termo com histórico; condições numa data; histórico de cargos, transferências e promoções com vigência                            | Feito  |

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

### 7.2 Recrutamento e onboarding

- Migração `0023_create_hr_recruitment`: `hr_settings`, `job_requisitions`, `candidates`, `job_applications`,
  `job_interviews`, `job_evaluations`, `job_offers`, `onboarding_tasks` (todas de tenant, com RLS e FKs compostas).
- `GET|PUT /hr/settings` (`hr.settings`): workflows de aprovação das vagas e propostas.
- `GET|POST /hr/requisitions`, `GET|PATCH /hr/requisitions/:id`, `POST …/submit`, `…/decision`, `…/close`, `…/cancel`.
- `GET|POST /hr/candidates`, `GET|PATCH /hr/candidates/:id`.
- `GET|POST /hr/applications`, `GET /hr/applications/:id`, `POST …/stage`, `…/interviews`, `…/evaluations`, `…/offers`.
- `GET /hr/interviews/mine`, `PATCH /hr/interviews/:id`.
- `PATCH /hr/offers/:id`, `POST …/submit`, `…/decision`, `…/response`, `…/cancel`, `…/hire`.
- `GET|POST /hr/employees/:id/onboarding`, `PATCH /hr/onboarding-tasks/:id`.
- Permissões novas: `hr.recruitment.read`, `hr.recruitment.manage`, `hr.recruitment.approve`, `hr.settings`. Tipos de
  assunto de aprovação novos: `job_requisition`, `job_offer`.
- Erros: `OUT_OF_SCOPE`, `SEGREGATION`, `USE_APPROVAL_WORKFLOW`, `INVALID_STATE`, `REQUISITION_NOT_OPEN`,
  `REQUISITION_FILLED`, `OUT_OF_RANGE`, `OFFER_IN_PROGRESS`, `OFFER_EXPIRED`, `PENDING_HIRE`, `ALREADY_APPLIED`,
  `ALREADY_EVALUATED`, `EMAIL_TAKEN`, `CODE_TAKEN`, `VERSION_CONFLICT`.

### 7.3 Contratos e carreira

- Migração `0024_create_hr_contracts`: `employment_contracts`, `employment_contract_amendments`,
  `employment_contract_events`, `employment_assignments`.
- `GET|POST /hr/employees/:id/contracts`, `GET|PATCH /hr/contracts/:id` (PATCH só em rascunho),
  `POST /hr/contracts/:id/activate|suspend|resume|terminate|cancel`, `POST /hr/contracts/:id/amendments`.
- `GET|POST /hr/employees/:id/assignments` (histórico e movimentos).
- Permissões novas: `hr.contracts.read`, `hr.contracts.manage`.
- Erros: `CONTRACT_OPEN`, `CONTRACT_OVERLAP`, `INVALID_STATE`, `NOT_RETROACTIVE`, `NOT_EXTENDED`, `NOT_FIXED_TERM`,
  `PERMANENT`, `BEFORE_HIRE`, `BEFORE_SUSPENSION`, `USE_MOVEMENT`, `USE_NEW_CONTRACT`, `FUTURE_DATE`,
  `NOT_AFTER_CURRENT`, `NO_CHANGE`, `POSITION_REQUIRED`, `CODE_TAKEN`.

## Ecrãs

Novo domínio "Pessoas e Talento" → Colaboradores (visível com `hr.read` em qualquer âmbito):

- Lista (EntityListPage): pesquisa, filtros de estado e departamento na URL, colunas configuráveis, exportação CSV,
  entidade legal da barra superior aplicada.
- Novo colaborador (EntityFormPage) com secções; as secções de dados pessoais só aparecem a quem os pode escrever.
- Ficha (PageDetail + barra de acções fixa): edição só do que mudou, suspender/reactivar com confirmação, resumo,
  anexos (só com acesso a dados pessoais) e histórico de auditoria. Sem acesso aos dados pessoais, um cartão
  "Dados reservados" substitui essas secções; sem `hr.manage`, a ficha é só de leitura.
- Sem rascunhos no browser (dados pessoais).

Recrutamento (7.2), no mesmo domínio:

- Vagas: lista com filtros na URL; formulário (remuneração em texto decimal); detalhe com pedir aprovação, aprovar ou
  recusar com motivo (só a quem pode e não pediu), ligação ao pedido quando há workflow, fechar e cancelar, e as
  candidaturas da vaga com "Adicionar candidato" (existente ou novo).
- Candidatos: lista e ficha com as candidaturas visíveis.
- Candidatura: mudar de etapa (recusar exige motivo), marcar entrevistas, avaliar, preparar proposta (aviso imediato fora
  do intervalo autorizado), pedir aprovação, aprovar/recusar, registar a resposta do candidato e contratar com a
  checklist sugerida e editável.
- As minhas entrevistas: o entrevistador marca como realizada e avalia.
- Ficha do colaborador: cartão de onboarding com progresso; tarefas por estado.
- Configuração de RH: workflows das vagas e propostas. O editor de workflows ganhou o tipo de assunto.

Contratos e carreira (7.3), na ficha do colaborador:

- Organização só de leitura depois de criada ("muda-se por movimento de carreira").
- Carreira: linha do tempo com vigência e "Registar movimento" (transferência, promoção, alteração; data e motivo).
- Contratos: lista com estado e aviso de termo ultrapassado; "Novo contrato" (rascunho) abre a página do contrato.
- Contrato: condições iniciais (editáveis só em rascunho), activar, nova adenda, renovar (só a termo certo), suspender,
  retomar e terminar com data e motivo; condições em vigor hoje, adendas, eventos do contrato e auditoria.

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

Testes do 7.2:

- Backend funcional `hr_recruitment.spec.ts` (4 testes): fluxo completo vaga → contratação com checklist e auditoria sem
  contactos do candidato; workflow de aprovação de vaga e proposta (recusa e aprovação) e cancelamento da proposta ao
  recusar a candidatura; âmbitos (recrutador por departamento, aprovador por entidade, contratar exige `hr.manage`);
  concorrência (duas contratações do último posto: 201 e 409, um só colaborador).
- Backend unitário `hr_recruitment_domain.spec.ts` (4 testes): montantes exactos, normalização da vaga, etapas, datas.
- `isolation_matrix` (vaga, candidato, candidatura, entrevista, proposta, onboarding e listas de outra empresa → 404 ou
  vazias), `routes_protection` (30 rotas justificadas).
- Frontend `hr/recruitment-model.spec.ts` (6 testes) e navegação.
- Browser (Playwright, 8 passos, dois utilizadores): criar vaga com intervalo inválido recusado; quem pede não vê
  "Aprovar"; o aprovador aprova; candidato novo; triagem; entrevista atribuída ao aprovador, que a marca realizada e
  avalia em "As minhas entrevistas"; proposta fora do intervalo assinalada, aprovada pelo outro utilizador e aceite;
  contratação abre a ficha com 4 tarefas de onboarding e cargo da vaga; a vaga fica preenchida; 390 px sem deslocamento
  horizontal. Sem erros na consola.

Testes do 7.3:

- Backend funcional `hr_career.spec.ts` (3 testes): ciclo do contrato (validações, activação, um em vigor, adendas sem
  retroactividade, renovação que estende, suspensão/retoma/termo, sem sobreposição, remuneração fora da auditoria);
  âmbitos (`hr.read` não vê contratos, leitura sem gestão, outro departamento, o próprio com OWN); carreira (período de
  admissão, ficha recusa colocação, datas futuras e anteriores, promoção exige cargo, transferência, ciclos de superior,
  colaborador anterior ao 7.3).
- Backend unitário `hr_contracts_domain.spec.ts` (3 testes): condições numa data, regras entre campos, véspera e termo.
- `isolation_matrix` (contratos, adendas, carreira de outra empresa → 404), `routes_protection` (12 rotas).
- Frontend `hr/contracts-model.spec.ts` (3 testes).
- Browser (5 passos): colocação bloqueada na ficha; promoção com histórico e ficha actualizada; contrato a termo criado,
  activado, adenda salarial reflectida nas condições de hoje, renovação inválida recusada junto do campo e válida;
  suspensão sem motivo recusada, retoma, termo e 6 eventos; 390 px sem deslocamento horizontal. Sem erros na consola.

## Pendências

- 7.4 a 7.13 (férias, compensação, adiantamentos, processamento salarial, IRT/INSS, recibos,
  formação, cessação, portais e relatórios).
- Recrutamento: sem portal público de candidaturas nem envio de emails aos candidatos (não pedido neste bloco).
- Taxas de IRT/INSS: configuráveis e confirmadas na legislação, nunca fixas no código.
- 6.9 SAF-T continua bloqueado pela especificação oficial.
- Contratos e carreira: limites legais (termo, renovações, período experimental) por confirmar na LGT 12/23; movimentos
  com data futura (agendados) e transferência entre entidades legais ficam por fazer; documento do contrato em PDF fica
  para o bloco de documentos/recibos.
