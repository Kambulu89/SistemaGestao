# CLAUDE.md — instruções de desenvolvimento

Aplicação web nova: `frontend/` (Angular 22 + Tailwind CSS 4) e `backend/` (AdonisJS 7, kit API, PostgreSQL 16).
Estado: só a estrutura base (moldura da UI, `GET /api/v1/health`, autenticação por token do kit). O domínio do produto
ainda não foi definido: não inventar funcionalidades sem pedido.

## Comandos

- Frontend (`cd frontend`): `npm ci` · `npm run lint` · `npm run format:check` · `npm test` · `npm run build` · `npm start`
- Backend (`cd backend`): `npm ci` · `node ace migration:run` · `npm run lint` · `npm run format:check` ·
  `npm run typecheck` · `npm test` · `npm run build` · `npm run dev`
- Node 24. Os testes do backend usam a base `app_test` (`backend/.env.test`).

## Regras

- Nunca fazer commit de `.env` nem de segredos (só `*.example` e `backend/.env.test`, que não tem segredos).
- Sem Redis por agora; o estado partilhado fica no PostgreSQL.
- API em `/api/v1`, validação com VineJS nos controllers, regras de negócio fora dos controllers.
- Dinheiro e quantidades nunca em `float` (usar `numeric` e strings na API).
- Cada alteração vem com testes; antes de dar algo por concluído correr lint, formatação, tipos, testes e build nos dois
  lados e dizer o que não foi possível executar.
- Não fazer commit, push, merge, deploy nem operações destrutivas sem autorização explícita.
