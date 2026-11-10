# QA do Prompt 07 (recursos humanos) — bloco 7.13

Branch `claude/pensive-clarke-5gm075`. Base verificada: blocos 7.1 a 7.12. Este documento regista o que foi executado e
os resultados reais; o que não foi executado está em "Limites".

## 1. Rastreabilidade dos testes exigidos

| Exigido no Prompt 07                     | Onde está coberto                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Cálculo de férias e feriados             | `hr_leave.spec.ts` (feriado da empresa, dias úteis vs. de calendário, direito proporcional, transporte), `hr_leave_domain.spec.ts` |
| Contrato temporal                        | `hr_career.spec.ts` (adendas com efeito, renovação, termo, sobreposição, movimentos com vigência), `hr_contracts_domain.spec.ts` |
| Salário/IRT/INSS com casos de referência | `hr_payroll_rules.spec.ts` (casos de teste com fonte que têm de passar ao cêntimo), `hr_payroll.spec.ts`, `hr_payroll_domain.spec.ts` |
| Arredondamento                           | `hr_payroll_domain.spec.ts`, `hr_loans_domain.spec.ts` (prestações ao cêntimo), `hr_compensation_domain.spec.ts`, `hr_termination_domain.spec.ts`, `hr_reports_domain.spec.ts` |
| Fechos                                   | `hr_payroll.spec.ts` (fecho imutável na base, período fechado), `hr_payroll_payments.spec.ts` (fechado ≠ pago), `hr_terminations.spec.ts` |
| Rectificações                            | `hr_payroll.spec.ts` (lote retroactivo sobre mês fechado), `hr_career.spec.ts`/`hr_compensation.spec.ts` (nada retroactivo sobre documentos finais) |
| Confidencialidade                        | `hr_employees.spec.ts` (dados pessoais por campo), `hr_leave.spec.ts` e `hr_portal.spec.ts` (tipo médico mascarado), `hr_discipline.spec.ts` (acesso restrito e leitura auditada) |
| Acesso de gestor                         | `hr_leave.spec.ts` (chefia directa decide), `hr_portal.spec.ts` (equipa por hierarquia, quem decide cada pedido, sem salários) |
| Multiempresa                             | `isolation_matrix.spec.ts` (todas as rotas de RH contra outra empresa e com `X-Tenant-Id` forjado), `routes_protection.spec.ts` |
| Contabilidade                            | `hr_payroll_payments.spec.ts` (eventos PAYROLL únicos, sem duplicar lançamentos)                                      |
| Regressão                                | **novo** `hr_lifecycle.spec.ts` (ciclo completo entre blocos) + regressão E2E de todos os scripts do Prompt 07        |

Contagem por ficheiro (testes funcionais/unitários de RH): employees 3, recruitment 4, career 3, leave 3, compensation 3,
loans 4, payroll 5, payroll_rules 3, payroll_payments 3, training 3, discipline 2, terminations 3, portal 3, lifecycle 1;
unitários: hr_domain 3, recruitment 4, contracts 3, leave 4, compensation 3, loans 4, payroll 9, termination 5, reports 3.

## 2. Regressão do ciclo completo (novo)

`backend/tests/functional/hr_lifecycle.spec.ts` encadeia: contrato → empréstimo aprovado por outra pessoa →
processamento regular do mês com a prestação descontada (líquido 154 600 = 200 000 − 6 000 − 9 400 − 30 000) →
pagamento do líquido → cessação no último dia do mês com 5 dias de férias pagos → aprovação segregada (contrato
terminado, saldo de férias a zero, tarefa de empréstimo criada, sem novo empréstimo) → lote extra da liquidação
(sem desconto de prestações) → checklist que só aceita "empréstimo tratado" depois de liquidadas as prestações →
conclusão → relatórios (1 admissão, 1 saída, efectivos no último dia, folha por tipo de lote) → prestações: 1 descontada
no salário e 2 pagas à parte, nenhuma duas vezes.

### Defeito encontrado e corrigido

- **Liquidação final recusada quando o mês da cessação já estava fechado e era o mês corrente** (`PERIOD_CLOSED`):
  o lote extra ia para o mês do último dia ou, se fechado, para o mês corrente — que era o mesmo. Agora vai para o
  primeiro mês aberto a partir do mês do último dia (ou do corrente, se posterior), até 12 meses
  (`termination_service.ts`). Prova: com o código anterior o teste falha com `PERIOD_CLOSED`; com a correcção passa.
  D-034 actualizada.

## 3. Execuções

| Verificação                         | Resultado                                                            |
| ----------------------------------- | -------------------------------------------------------------------- |
| Backend lint / formatação / tipos   | sem erros                                                            |
| Backend testes (`npm test`)         | **233 passados** (cada execução aplica as 32 migrações e reverte-as) |
| Backend build                       | concluído                                                            |
| Frontend lint / formatação          | sem erros                                                            |
| Frontend testes (`npm test`)        | **124 passados**                                                     |
| Frontend build                      | concluído                                                            |
| E2E no browser, 12 scripts (7.1–7.12) | **todos os passos OK**, sem erros na consola                       |

Regressão E2E (Playwright, servidores locais, dois utilizadores):
p071 5/5, p072 8/8, p073 5/5, p074 7/7, p075 5/5, p076 7/7, p077 5/5, p078 5/5, p079 6/6, p0710 7/7, p0711 8/8,
p0712 5/5.

Na primeira passagem falharam três scripts, todos por desactualização dos próprios scripts e não do produto:

- p073: contava os períodos de carreira antes de a ficha acabar de carregar (a ficha tem agora mais cartões); passou a
  esperar pelo primeiro período.
- p077 (escrito no 7.7): publicava regras sem casos de teste nem confirmação das normas, o que o 7.8 passou a exigir; o
  script regista agora o caso, confirma e publica, e abre a tabela de escalões (recolhida desde o 7.8).
- p079: a conta de teste estava ligada a uma ficha criada por outro script (`MEMBERSHIP_TAKEN`); o script desliga
  qualquer ficha ligada antes de começar, e o passo móvel trata a escolha de empresa quando aparece.

## 4. Revisão de segurança e invariantes (módulo de RH)

- SQL: todas as interpolações em `rawQuery` do módulo são fragmentos internos (selects, cláusulas de âmbito, colunas
  de listas fechadas, `order by` de campos validados); os valores vão sempre como parâmetros.
- Âmbito: rotas de RH sem `can()` têm justificação no `routes_protection` e verificação no serviço; a matriz de
  isolamento cobre leituras e escritas de cada tipo de registo de RH contra outra empresa.
- Imutabilidade na base: lotes e resultados fechados, regras publicadas e casos de teste, pagamentos, histórico de
  competências e cronologia disciplinar, processos disciplinares encerrados, cessações aprovadas/concluídas e linhas
  da liquidação — triggers verificados nos testes funcionais.
- Auditoria sem valores reservados: montantes, salários, factos disciplinares e dados pessoais auto-actualizados
  aparecem como `[RESERVADO]` ou só pelo nome do campo (verificado nos testes de cessação, disciplina e portal).
- Nenhum valor legal (IRT, INSS, dias de aviso, indemnizações, férias) no código: configurados com fonte pela empresa.

## 5. Limites e pendências

- Os scripts E2E vivem fora do repositório (scratchpad da sessão) porque usam contas e palavras-passe de
  desenvolvimento; integrá-los num runner versionado com credenciais por variável de ambiente fica por fazer.
- Não houve teste de carga nem de concorrência real com vários processos (a concorrência está coberta por versões
  optimistas e bloqueios `for update` nos testes funcionais).
- Normas angolanas (LGT n.º 12/23, IRT, INSS): o sistema não as valida; têm de ser introduzidas e confirmadas pela
  empresa. 6.9 SAF-T continua bloqueado pela especificação oficial.
