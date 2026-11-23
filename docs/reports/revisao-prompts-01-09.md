# Revisão dos Prompts 01–09 contra o plano (antes do Prompt 10)

Feita com o plano "ERP SaaS Multiempresa — 36 Prompts" reanexado. Compara cada bloco pedido com o código, as migrações, os
testes e os relatórios do repositório. Base: `main` em `c9df748`.

Verificação executada nesta revisão (resultados reais, no fecho do 9.12):

| Verificação                     | Resultado                        |
| ------------------------------- | -------------------------------- |
| Backend lint, formatação, tipos | sem erros                        |
| Backend testes                  | 364 passados (53 migrações)      |
| Frontend lint e formatação      | sem erros                        |
| Frontend testes                 | 194 passados                     |
| Builds                          | concluídos                       |
| Browser (Prompt 09)             | 63 passos passados em 10 scripts |

## 1. Estado por prompt

| Prompt                       | Estado                   | Evidência                                                                                                                                                                                                                                                                             | Falta (por desenho, dependência ou bloqueio)                                                                                                                           |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 Regras permanentes        | Cumprido                 | `CLAUDE.md` (regras), `docs/architecture.md`, `docs/decisions.md`; entregas em 8 partes por bloco                                                                                                                                                                                     | —                                                                                                                                                                      |
| 02 Auditoria                 | Feito, sem ficheiro      | Auditoria de leitura da versão anterior (commit `3c8c7c8`, "ERP E0: diagnóstico…"); a aplicação actual foi reconstruída a partir da Fundação 3.1                                                                                                                                      | O relatório de 10 partes não está no repositório (o prompt pedia apresentá-lo antes de criar ficheiros)                                                                |
| 03 Fundação SaaS             | Concluído                | Tenants com RLS e `X-Tenant-Id` só como selector, identidade/membership, RBAC com âmbitos e anti-escalada, organização, planos/entitlements, aprovações com delegações, auditoria, anexos, notificações; `isolation_matrix`, `routes_protection`; `README.md`, `backend/.env.example` | —                                                                                                                                                                      |
| 04 Design system e UX        | Concluído com pendências | Tokens claro/escuro com teste de contraste, AppShell por domínios, componentes, painel, pesquisa, notificações (`docs/design-system.md`, `docs/reports/interface.md`)                                                                                                                 | Verificação automática axe/leitor de ecrã real; gráficos avançados (Prompt 26); browser no CI (Prompt 16)                                                              |
| 05 Administração empresarial | Concluído                | Perfil (morada até comuna, logótipo), entidades e filiais, departamentos/cargos com organograma, centros de custo, convites/sessões, câmbios, séries, calendários, contas bancárias com aprovação                                                                                     | Câmbios automáticos (BNA) e listas oficiais de províncias/municípios                                                                                                   |
| 06 Contabilidade             | 6.1–6.8, 6.10            | Plano, lançamentos, motor de contabilização, abertura/razão/balancete, analítica, activos, regularizações, demonstrações, fecho                                                                                                                                                       | **6.9 SAF-T bloqueado** pela especificação oficial; fluxos de caixa (precisam do Prompt 11); abates parciais, reavaliações e transferências de activos entre entidades |
| 07 RH e Payroll              | Concluído (QA 7.13)      | 7.1–7.12, `docs/reports/prompt-07-qa.md`                                                                                                                                                                                                                                              | Valores legais (LGT 12/23, IRT, INSS) configurados e confirmados pela empresa, nunca pré-carregados                                                                    |
| 08 Inventário                | Concluído (QA 8.12)      | 8.1–8.11, `docs/reports/prompt-08-qa.md`; código de barras, mínimos/máximos, lotes, séries, FEFO, valorização                                                                                                                                                                         | Notificações automáticas de alertas (sem agendador)                                                                                                                    |
| 09 Compras                   | Concluído (QA 9.12)      | 9.1–9.11, `docs/reports/prompt-09-qa.md`; critério Requisição→…→Obrigação única verificado                                                                                                                                                                                            | Tesouraria (Prompt 11); portal do fornecedor (Prompt 25); agendador de avisos                                                                                          |

## 2. Achados e acções

### 2.1 Corrigido nesta revisão

**Relatórios desactualizados.**

- `prompt-06.md` dizia que nenhum módulo emitia eventos contabilísticos e que os terceiros eram texto. Hoje:
  - emitem eventos o Inventário (8.10), o RH (7.9) e as Compras (9.10);
  - os terceiros existem no módulo `partners`.
- `prompt-08.md` dizia que Compras não existia. Hoje as Compras chamam `receivePurchase` e `returnToSupplier`.

Acrescentei uma nota de actualização nos dois relatórios, sem reescrever o histórico.

### 2.2 Dívidas de arquitectura a pagar no Prompt 11 (Finanças)

- **Liquidações fora do Finance.** O plano diz "Finance dono de liquidações". Hoje os pagamentos de salários
  (`payrollObligations`, D-032) e de fornecedores (`procurementPayables`, D-056) estão nos seus módulos, com permissão
  de tesouraria e um contrato publicado. O Prompt 11 tem de passar o registo de pagamentos para o Finance, usando esses
  contratos e sem duplicar obrigações. A Facturação (10.10) segue o mesmo caminho: só o contrato das contas a receber.
- **Terceiro na contabilidade.** Os lançamentos levam o terceiro como referência de texto (`thirdPartyRef`, com o código
  do fornecedor). Ligá-lo ao `business_partners` exige uma migração no Accounting.

### 2.3 Transversais (Prompts 14–16)

- Os scripts de browser estão fora do repositório (palavras-passe de desenvolvimento) e não correm no CI.
- Não houve teste de carga com vários processos.
- Com várias séries activas para o mesmo tipo de documento usa-se a primeira por código (Compras e RH). **Na Facturação
  (10.5) não pode ser assim:** as séries fiscais têm de ser escolhidas explicitamente e ter uma sequência segura e
  auditável.

### 2.4 Conformidade

Nenhum relatório declara conformidade legal ou fiscal. As normas (SAF-T, LGT 12/23, IRT, INSS) ficam por confirmar nas
fontes oficiais. Este cuidado mantém-se no Prompt 10: o Decreto Presidencial n.º 71/25 e a AGT exigem validação, e qualquer
integração usa apenas um simulador identificado como tal.

## 3. Conclusão

Os Prompts 01–09 estão implementados dentro do que o plano permite hoje. Ficam:

- o bloqueio do 6.9 (especificação oficial do SAF-T);
- as pendências documentadas em cada relatório;
- as dívidas que dependem do Prompt 11 (Finanças).

Nenhuma bloqueia o Prompt 10. O 10.10 (cobranças) e o 10.12 (integração) devem seguir o padrão de contratos já usado e
não criar um Finance provisório.
