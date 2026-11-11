# Zelo API (MVP)

Back-end em Node + TypeScript e banco PostgreSQL do Zelo. Segue o que o app
já espera em `src/services/*`: os nomes, os campos e as regras são os mesmos
(nomes em inglês, mensagens e comentários em português).

> Em desenvolvimento. O app (`src_mvp`) já está integrado a esta API; veja `MVP.md` no app.

## Como rodar

Requisitos: Node 22+ e PostgreSQL 16.

```bash
npm install
cp .env.example .env          # preencha DATABASE_URL e os dois segredos
createdb zelo                 # ou crie o banco como preferir
npm run db:migrate            # aplica database/schema.sql (só em banco novo)
npm run dev                   # http://localhost:3333  (GET /health)
```

Produção: `npm run build && npm start`.

Testes (`npm test`): recriam o banco `zelo_test`, aplicam o schema e chamam a
API de ponta a ponta. Precisam do `psql` e das variáveis `PGHOST`/`PGUSER`
(e `PGPASSWORD`, se houver). **Apagam o banco `zelo_test` a cada execução.**

## Estrutura

```
database/schema.sql      tabelas do MVP (12 tabelas)
src/server.ts            sobe o HTTP e a rotina que roda a cada minuto
src/app.ts               monta as rotas
src/http.ts              roteador mínimo, erros, CORS, limite de tentativas
src/security.ts          senha (scrypt), hash de CPF/código, JWT
src/routes/*.ts          uma rota por função dos services do app
src/domain/doses.ts      gera as doses do dia e marca as atrasadas
test/                    testes de ponta a ponta
```

## Rotas x services do app

Todas devolvem JSON. Erros vêm como `{ "message": "..." }` (já em português,
pronto para o `throw new Error(message)` do app). Rotas protegidas usam
`Authorization: Bearer <token>`; o token vem do login/cadastro.

| Service do app | Rota | Quem |
|---|---|---|
| `signInCaregiver` | `POST /auth/caregiver/sign-in` `{email,password}` → `{token,user}` | público |
| `registerCaregiver` | `POST /auth/caregiver/register` `{name,email,phone,cpf,password}` → `{token,user}` | público |
| `signInPatient` | `POST /auth/patient/sign-in` `{code}` → `{token,user}` | público |
| `getPatients` | `GET /patients` | cuidador |
| `createPatient` | `POST /patients` `{fullName,nickname,birthDate,cpf}` → `{patient,pairingCode}` | cuidador (vira master) |
| `getPatient` | `GET /patients/:id` | cuidador |
| `updatePatient` | `PATCH /patients/:id` | master |
| `deletePatient` | `DELETE /patients/:id` | master |
| `inviteCaregiver` | `POST /patients/:id/invites` `{name,email}` → `{caregiver,link}` | master |
| `resendCaregiverInvite` | `POST /patients/:id/invites/:inviteId/resend` | master |
| `cancelCaregiverInvite` | `DELETE /patients/:id/invites/:inviteId` | master |
| `getMedications` | `GET /patients/:id/medications` | cuidador |
| `createMedication` | `POST /patients/:id/medications` | cuidador |
| `endMedication` | `DELETE /medications/:id` | cuidador |
| `getHistory` | `GET /patients/:id/history?date=AAAA-MM-DD&medicationId=` | cuidador |
| `getHistoryMedications` | `GET /patients/:id/history/medications?month=0-11&year=` | cuidador |
| `getMissedDoses` | `GET /patients/:id/doses/missed` | cuidador |
| `confirmDose` | `POST /doses/:id/confirm` `{status,time,notes}` | cuidador |
| `getNotifications` | `GET /notifications` | cuidador |
| `getUserProfile` | `GET /profile` | cuidador |
| `getPendingDoses` | `GET /patient/doses/pending` | paciente |
| `takeDose` | `POST /patient/doses/:id/take` → `{time}` | paciente |
| `skipDose` | `POST /patient/doses/:id/skip` `{reason}` | paciente |
| `reportSymptom` | `POST /patient/symptoms` `{symptom}` | paciente |
| `getPatientProfile` | `GET /patient/profile` (o paciente vem do token) | paciente |

Rotas extras, que o app ainda não tem tela para usar:

- `POST /patients/:id/pairing-codes`: novo código de pareamento (o primeiro vence em 24 h ou é usado uma vez; sem isso o paciente que sair do app não consegue entrar de novo).
- `GET /invites/:token` e `POST /invites/:token/accept`: tela do link de convite.
- `POST /notifications/:id/read` e `POST /notifications/read-all`.
- `GET /health`.

## Regras de negócio implementadas

- **Master:** quem cadastra o paciente. Só ele convida, reenvia/cancela convites, edita e exclui o paciente. Os outros cuidadores veem tudo e cuidam normalmente.
- **CPF:** validado (dígitos verificadores) e guardado só como hash (HMAC-SHA256 com `HASH_PEPPER`). Evita paciente e cuidador duplicados. Senha em scrypt.
- **Pareamento:** 6 números, 24 h, uso único, gerar outro revoga o anterior. Só o hash fica no banco.
- **Convite:** link com token aleatório, 7 dias. Reenviar gera link novo e invalida o antigo. Quem aceita precisa estar logado com o **mesmo e-mail** do convite.
- **Doses:** cada horário do medicamento vira uma dose do dia (`pending`).
  - Paciente toca "Tomei": até 15 min depois do horário = `taken`; depois = `taken_late`.
  - Sem resposta 30 min depois do horário = `missed` + notificação "Dose não confirmada" para todos os cuidadores.
  - "Não tomei": `skipped` com o motivo. "Estou passando mal" gera notificação de sintoma; "O remédio acabou" gera notificação de dose.
  - O paciente ainda pode confirmar uma dose `missed` do dia (vira `taken_late`).
  - Medicamento cadastrado hoje não gera dose de horário que já passou.
- **Histórico:** doses respondidas + relatos de sintoma (etiqueta "Anormalidade") do dia, no fuso `APP_TIMEZONE`. O bloco "Alterações" vem de `dose_events` (ex.: "o app marcou como Não tomou, sem confirmação").
- **Datas do tratamento:** `start_date` e `end_date` (nulo = uso contínuo) já estão no banco.
- Paciente excluído: o banco apaga tudo dele em cascata e o token do paciente deixa de valer na hora.

## O que o app precisa ajustar na integração

1. **Token:** o login devolve `{ token, user }`. O app guarda o token e manda no header de todas as chamadas.
2. **`confirmDose`:** o campo `medicationId` deve receber o `id` devolvido por `getMissedDoses`, que é o **id da dose** (hoje o mock mistura os dois).
3. **`getPatientProfile(patientId)`:** a rota usa o paciente do token; o parâmetro pode ser ignorado.
4. **`getHistory`:** mandar `date` como `AAAA-MM-DD` (data local), não o `Date` inteiro.
5. **`isMaster` por paciente:** `GET /patients` devolve `isMaster` em cada paciente (campo a mais). `UserProfile.isMaster` diz se a pessoa é master de algum paciente.
6. **`inviteCaregiver`:** o `caregiver.id` do convite pendente é o id do convite; é ele que vai em reenviar/cancelar.

## Decisões e pontos em aberto

- **Sem envio de e-mail/push:** o convite devolve o link para o app compartilhar. Push (Expo) e e-mail ficam para depois; as notificações já são gravadas por cuidador.
- **Login do paciente:** como o código é de uso único, se o paciente sair do app o cuidador precisa gerar outro (rota extra acima). Sem revogação de sessão no servidor (logout é só no app).
- **Limite de tentativas** do login e do código de pareamento é em memória, por IP: vale para uma instância só.
- **Doses só são geradas para hoje** (a rotina roda a cada minuto). Se o servidor ficar fora do ar um dia inteiro, esse dia não tem doses.
- **Fora do MVP** (existem no modelo v2 completo): planos, catálogo de bulas, edição/anulação do histórico, pedido de ajuda, push, saúde do paciente.
- Antes de ir para produção: HTTPS, `CORS_ORIGIN` restrito, backup do banco e guardar `HASH_PEPPER` com segurança (se mudar, os CPFs já cadastrados deixam de bater).

## O que foi verificado

- O schema foi aplicado em PostgreSQL 16 real e os 30 testes de ponta a ponta passam (cadastro, login, CPF duplicado, pareamento, convite, master, medicamentos nas 4 frequências, doses, atrasos, notificações, histórico, exclusão).
- Os testes usaram o `psql` no lugar do driver `pg` (o registro npm estava bloqueado onde isto foi escrito). Todas as 64 queries com parâmetros também passaram em `PREPARE` (mesma inferência de tipos do driver). **Ainda não foi rodado com o `pg` de verdade nem contra o app**: o primeiro `npm install && npm run dev` é o teste que falta.
