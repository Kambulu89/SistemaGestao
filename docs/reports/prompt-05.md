# Relatório — Prompt 05 (administração empresarial)

Estado: **5.1 a 5.8 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Decisão D-013. Sem cálculo
fiscal nem tesouraria: o regime fiscal é identificação; as contas bancárias são cadastro com aprovação.

## Matriz AS-IS / TO-BE

| Área                     | AS-IS (fim do Prompt 04)                                     | TO-BE (Prompt 05)                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 Perfil da empresa    | Só nome, código, idioma, fuso e moeda do tenant (plataforma) | Perfil próprio (nome a apresentar, referências, sector, contactos, morada, logótipo) separado da identidade fiscal; idioma, fuso e moeda editáveis pela empresa; anexos e histórico                                          |
| 5.2 Entidades e filiais  | Código, denominação, NIF, país, moeda; filial com tipo       | Regime fiscal, IVA, início do exercício, contactos, morada, representante; filial com contactos, morada, responsável e centro de custo; inactivação bloqueada com dependentes activos (painel de dependências)               |
| 5.3 Departamentos/cargos | Árvore de departamentos; cargo com família, categoria, nível | Responsável e centro de custo no departamento; organograma; cargo com função, requisitos e responsabilidades                                                                                                                 |
| 5.4 Centros de custo     | Árvore por entidade legal                                    | Responsável; organograma; bloqueio com dependentes (filiais e departamentos que o usam)                                                                                                                                      |
| 5.5 Membros/RBAC         | Convites de 7 dias; perfis editados um a um                  | Validade configurável e visível; reenviar e revogar convites; matriz perfis × permissões com confirmação; sessões e histórico já existiam (perfil do utilizador e auditoria)                                                 |
| 5.6 Configurações        | Nada                                                         | Precisões e arredondamento; câmbios exactos com consulta em vigor; séries documentais sem lacunas; calendários com feriados e dias úteis; contas bancárias com IBAN validado e aprovação; segurança (convites); notificações |
| 5.7 Workflows            | Aprovações só de pedidos manuais                             | Assuntos registados por módulos (`bank_account`), efeito na transacção da decisão (aprovar, rejeitar, cancelar); notificações de aprovação desligáveis; tudo auditado e com documentos                                       |
| 5.8 Qualidade            | 72 testes de backend, 35 de frontend                         | 83 de backend (incl. matriz de isolamento com os novos registos), 44 de frontend, cenário de browser de 11 passos                                                                                                            |

Cada ecrã tem listagem com filtros e exportação, formulário com campos explícitos, detalhe com edição, estado,
auditoria e permissões. Documentos (anexos) existem onde o servidor os permite: entidades organizacionais, perfil da
empresa e contas bancárias; câmbios, séries e calendários não são assunto de anexos (ver pendências).

## Contratos com os outros módulos

Todos estes são exportados por `#modules/settings/index` ou `#modules/organization/index` e usam-se dentro de
`runInTenant`, na transacção de quem chama.

| Consumidor            | Usa                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facturação            | `reserveDocumentNumber(scope, seriesId, data)` (número sem lacunas e formatado); `tenantSettings` (casas decimais, arredondamento); entidade legal (identificação fiscal, morada); conta bancária por omissão por moeda |
| Compras               | `reserveDocumentNumber` (encomendas a fornecedor); `rateOn` para documentos em moeda estrangeira; centros de custo                                                                                                      |
| Inventário            | `tenantSettings.quantityScale`; `reserveDocumentNumber` (guias); filiais como locais                                                                                                                                    |
| Finanças / tesouraria | `bank_accounts` activas (nunca pendentes ou rejeitadas); `rateOn`; `tenantSettings`                                                                                                                                     |
| Contabilidade         | entidade legal (moeda funcional, início do exercício); centros de custo; `rateOn`; séries `JOURNAL`                                                                                                                     |
| RH                    | departamentos, cargos (função, requisitos, responsabilidades), responsáveis; calendários                                                                                                                                |
| Assiduidade           | calendários: dias de descanso, feriados, `workingDaysBetween`                                                                                                                                                           |
| Performance           | organograma (responsáveis por departamento e centro de custo), cargos                                                                                                                                                   |

## Testes executados

| Lado                                                                  | Resultado                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend (`npm test`)                                                  | 83/83; lint, formatação, tipos e build sem erros. Novo `enterprise_admin.spec.ts` (11 testes) e matriz de isolamento com câmbios, séries, calendários, feriados, contas bancárias, perfil e dependências                                                                               |
| Frontend (`npm test`)                                                 | 44/44; lint (incl. acessibilidade dos templates), formatação e build sem erros                                                                                                                                                                                                         |
| Browser (Playwright contra o backend real; guião fora do repositório) | 11/11 passos, 0 erros na consola: perfil, configurações, calendário com feriado e 4 dias úteis numa semana, série com próximo número, câmbio com consulta, IBAN inválido recusado e válido agrupado, organograma, entidade com secções e dependências, matriz, tema escuro e telemóvel |

Defeitos encontrados e corrigidos neste bloco: o efeito da aprovação só corria no cancelamento (não ao aprovar nem ao
rejeitar); painel de anexos mostrado em tipos que não aceitam anexos; o perfil `tenant_admin` das empresas existentes
não tinha as permissões novas até `node ace catalog:sync` (passo já previsto no README).

## Pendências

- Anexos em câmbios, séries e calendários: exigem novos tipos de assunto nos anexos; só se justificam com um caso de uso.
- Fonte automática de câmbios (BNA) e listas oficiais de províncias/municípios: dependem de integração e validação.
- Emissão real de documentos (facturas, guias) com `reserveDocumentNumber`: Prompts de Facturação, Compras e Inventário.
- Regras fiscais (IVA, retenções) e laborais: só depois de validação oficial, nos módulos próprios.
- O cenário de browser ainda não corre no CI (precisa de dados preparados).
