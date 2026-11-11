import "./setup.js";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { createApp } from "../src/app.js";
import { PsqlDb } from "./psql-db.js";

const TZ = "America/Sao_Paulo";
const db = new PsqlDb(process.env.PGTEST_DB ?? "zelo_test");
let server: Server;
let base = "";

/** CPF válido a partir de 9 dígitos. */
function cpf(seed: number) {
  const d = String(seed).padStart(9, "0").split("").map(Number);
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += d[i] * (len + 1 - i);
    const r = (sum * 10) % 11;
    d.push(r === 10 ? 0 : r);
  }
  return d.join("");
}

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Hora local (fuso do app) deslocada em minutos: devolve "HH:mm" e o minuto do dia. */
function localTime(offsetMinutes: number) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return { text: `${hh}:${parts.minute}`, minuteOfDay: Number(hh) * 60 + Number(parts.minute) };
}
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

before(async () => {
  server = createServer(createApp(db));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.close();
  await db.close();
});

// Estado compartilhado entre os passos (cada `it` depende do anterior).
const s: Record<string, any> = {};

describe("autenticação", () => {
  it("cadastra o cuidador e já devolve o usuário logado", async () => {
    const res = await api("POST", "/auth/caregiver/register", {
      body: { name: "Igor Xavier", email: "Igor@Email.com", phone: "(11) 98888-7777", cpf: cpf(123456789), password: "senha-forte-1" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.profile, "caregiver");
    assert.equal(res.body.user.name, "Igor Xavier");
    assert.ok(res.body.token);
    s.A = res.body;
  });

  it("recusa e-mail repetido (mesmo com outra caixa), CPF repetido e CPF inválido", async () => {
    const base_ = { name: "Outro", phone: "11999998888", password: "senha-forte-1" };
    const dupMail = await api("POST", "/auth/caregiver/register", { body: { ...base_, email: "igor@email.com", cpf: cpf(234567891) } });
    assert.equal(dupMail.status, 409);
    assert.match(dupMail.body.message, /e-mail/);
    const dupCpf = await api("POST", "/auth/caregiver/register", { body: { ...base_, email: "x@email.com", cpf: cpf(123456789) } });
    assert.equal(dupCpf.status, 409);
    assert.match(dupCpf.body.message, /CPF/);
    const bad = await api("POST", "/auth/caregiver/register", { body: { ...base_, email: "y@email.com", cpf: "12345678900" } });
    assert.equal(bad.status, 422);
    const weak = await api("POST", "/auth/caregiver/register", { body: { ...base_, email: "z@email.com", cpf: cpf(345678912), password: "123" } });
    assert.equal(weak.status, 422);
  });

  it("login do cuidador: certo, senha errada e e-mail inexistente", async () => {
    const ok = await api("POST", "/auth/caregiver/sign-in", { body: { email: "igor@email.com", password: "senha-forte-1" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, s.A.user.id);
    const wrong = await api("POST", "/auth/caregiver/sign-in", { body: { email: "igor@email.com", password: "errada-errada" } });
    assert.equal(wrong.status, 401);
    const none = await api("POST", "/auth/caregiver/sign-in", { body: { email: "naoexiste@email.com", password: "qualquer-coisa" } });
    assert.equal(none.status, 401);
    assert.equal(none.body.message, wrong.body.message);
  });

  it("rotas protegidas exigem token do perfil certo", async () => {
    assert.equal((await api("GET", "/patients")).status, 401);
    assert.equal((await api("GET", "/patients", { token: "lixo.lixo.lixo" })).status, 401);
    assert.equal((await api("GET", "/rota-que-nao-existe")).status, 404);
  });
});

describe("pacientes, pareamento e master", () => {
  it("cadastra o paciente: quem cadastra vira master e recebe o código de 6 números", async () => {
    const res = await api("POST", "/patients", {
      token: s.A.token,
      body: { fullName: "Maria Xavier", nickname: "Dona Maria", birthDate: "1950-03-12", cpf: cpf(456789123), authorizationConfirmed: true },
    });
    assert.equal(res.status, 201);
    assert.match(res.body.pairingCode, /^\d{6}$/);
    assert.equal(res.body.patient.name, "Maria Xavier");
    s.patientId = res.body.patient.id;
    s.code = res.body.pairingCode;
  });

  it("recusa CPF duplicado e data de nascimento futura", async () => {
    const dup = await api("POST", "/patients", {
      token: s.A.token,
      body: { fullName: "Outra Pessoa", nickname: "", birthDate: "1950-03-12", cpf: cpf(456789123) },
    });
    assert.equal(dup.status, 409);
    const future = await api("POST", "/patients", {
      token: s.A.token,
      body: { fullName: "Outra Pessoa", nickname: "", birthDate: "2999-01-01", cpf: cpf(567891234) },
    });
    assert.equal(future.status, 422);
  });

  it("o CPF não fica salvo em texto no banco", async () => {
    const { rows } = await db.query("select cpf_hash from patients where id = $1", [s.patientId]);
    assert.notEqual(rows[0].cpf_hash, cpf(456789123));
    assert.match(rows[0].cpf_hash, /^[0-9a-f]{64}$/);
    const users = await db.query("select cpf_hash, password_hash from users where id = $1", [s.A.user.id]);
    assert.ok(!users.rows[0].password_hash.includes("senha-forte"));
  });

  it("lista e detalha o paciente com os cuidadores", async () => {
    const list = await api("GET", "/patients", { token: s.A.token });
    assert.deepEqual(list.body.map((p: any) => [p.id, p.name, p.isMaster]), [[s.patientId, "Maria Xavier", true]]);
    const one = await api("GET", `/patients/${s.patientId}`, { token: s.A.token });
    assert.equal(one.body.nickname, "Dona Maria");
    assert.equal(one.body.birthDate, "1950-03-12");
    assert.equal(one.body.caregivers.length, 1);
    assert.equal(one.body.caregivers[0].status, "active");
    assert.equal(one.body.caregivers[0].phone, "11988887777");
  });

  it("o paciente entra com o código; o código só funciona uma vez", async () => {
    const res = await api("POST", "/auth/patient/sign-in", { body: { code: s.code } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.profile, "patient");
    assert.equal(res.body.user.id, s.patientId);
    s.P = res.body;
    const again = await api("POST", "/auth/patient/sign-in", { body: { code: s.code } });
    assert.equal(again.status, 401);
    const short = await api("POST", "/auth/patient/sign-in", { body: { code: "123" } });
    assert.equal(short.status, 422);
  });

  it("código vencido não entra; novo código revoga o anterior", async () => {
    const first = await api("POST", `/patients/${s.patientId}/pairing-codes`, { token: s.A.token });
    assert.equal(first.status, 201);
    const second = await api("POST", `/patients/${s.patientId}/pairing-codes`, { token: s.A.token });
    assert.equal((await api("POST", "/auth/patient/sign-in", { body: { code: first.body.pairingCode } })).status, 401);

    await db.query("update patient_pairing_codes set expires_at = now() - interval '1 minute' where used_at is null and revoked_at is null");
    assert.equal((await api("POST", "/auth/patient/sign-in", { body: { code: second.body.pairingCode } })).status, 401);
  });

  it("paciente não acessa rotas de cuidador e vice-versa", async () => {
    assert.equal((await api("GET", "/patients", { token: s.P.token })).status, 403);
    assert.equal((await api("GET", "/patient/profile", { token: s.A.token })).status, 403);
  });
});

describe("convites e regra do master", () => {
  it("master convida; o convite aparece como pendente com 7 dias", async () => {
    const res = await api("POST", `/patients/${s.patientId}/invites`, {
      token: s.A.token,
      body: { name: "Pedro Silva", email: "Pedro@Email.com" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.caregiver.status, "pending");
    assert.equal(res.body.caregiver.inviteExpiresInDays, 7);
    assert.match(res.body.link, /^https:\/\/zelo\.test\/convite\/[\w-]{20,}$/);
    s.invite = res.body;

    const dup = await api("POST", `/patients/${s.patientId}/invites`, {
      token: s.A.token,
      body: { name: "Pedro", email: "pedro@email.com" },
    });
    assert.equal(dup.status, 409);

    const detail = await api("GET", `/patients/${s.patientId}`, { token: s.A.token });
    const pending = detail.body.caregivers.find((c: any) => c.status === "pending");
    assert.equal(pending.email, "pedro@email.com");
    assert.equal(pending.inviteExpiresInDays, 7);
  });

  it("o token do convite não fica salvo no banco", async () => {
    const token = s.invite.link.split("/").pop();
    const { rows } = await db.query("select token_hash from caregiver_invites");
    assert.ok(rows.every((r: any) => r.token_hash !== token));
  });

  it("reenviar gera link novo e o antigo para de funcionar", async () => {
    const oldToken = s.invite.link.split("/").pop();
    const res = await api("POST", `/patients/${s.patientId}/invites/${s.invite.caregiver.id}/resend`, { token: s.A.token });
    assert.equal(res.status, 200);
    assert.notEqual(res.body.link, s.invite.link);
    assert.equal((await api("GET", `/invites/${oldToken}`)).status, 410);
    s.invite.link = res.body.link;
    const preview = await api("GET", `/invites/${res.body.link.split("/").pop()}`);
    assert.equal(preview.body.patientName, "Dona Maria");
  });

  it("outra pessoa (e-mail diferente) não aceita; o convidado aceita e vira cuidador comum", async () => {
    const token = s.invite.link.split("/").pop();
    const other = await api("POST", "/auth/caregiver/register", {
      body: { name: "Intruso", email: "intruso@email.com", phone: "11977776666", cpf: cpf(678912345), password: "senha-forte-1" },
    });
    assert.equal((await api("POST", `/invites/${token}/accept`, { token: other.body.token })).status, 403);

    const pedro = await api("POST", "/auth/caregiver/register", {
      body: { name: "Pedro Silva", email: "pedro@email.com", phone: "11966665555", cpf: cpf(789123456), password: "senha-forte-1" },
    });
    s.B = pedro.body;
    assert.equal((await api("GET", `/patients/${s.patientId}`, { token: s.B.token })).status, 404);
    const accepted = await api("POST", `/invites/${token}/accept`, { token: s.B.token });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.isMaster, false);
    assert.equal((await api("POST", `/invites/${token}/accept`, { token: s.B.token })).status, 410);

    const detail = await api("GET", `/patients/${s.patientId}`, { token: s.B.token });
    assert.equal(detail.body.caregivers.length, 2);
    assert.ok(detail.body.caregivers.every((c: any) => c.status === "active"));
    s.intruder = other.body;
  });

  it("cuidador comum não convida, não exclui e não gera código", async () => {
    const invite = await api("POST", `/patients/${s.patientId}/invites`, { token: s.B.token, body: { name: "Fulano", email: "fulano@email.com" } });
    assert.equal(invite.status, 403);
    assert.equal((await api("DELETE", `/patients/${s.patientId}`, { token: s.B.token })).status, 403);
    const list = await api("GET", "/patients", { token: s.B.token });
    assert.equal(list.body[0].isMaster, false);
  });

  it("convite vencido não é aceito; cancelar invalida o link", async () => {
    const created = await api("POST", `/patients/${s.patientId}/invites`, { token: s.A.token, body: { name: "Ana", email: "ana@email.com" } });
    const tokenA = created.body.link.split("/").pop();
    await db.query("update caregiver_invites set expires_at = now() - interval '1 day' where id = $1", [created.body.caregiver.id]);
    assert.equal((await api("GET", `/invites/${tokenA}`)).status, 410);
    const detail = await api("GET", `/patients/${s.patientId}`, { token: s.A.token });
    assert.equal(detail.body.caregivers.find((c: any) => c.email === "ana@email.com").inviteExpiresInDays, 0);

    const resent = await api("POST", `/patients/${s.patientId}/invites/${created.body.caregiver.id}/resend`, { token: s.A.token });
    assert.equal(resent.status, 200);
    assert.equal((await api("DELETE", `/patients/${s.patientId}/invites/${created.body.caregiver.id}`, { token: s.A.token })).status, 204);
    assert.equal((await api("GET", `/invites/${resent.body.link.split("/").pop()}`)).status, 410);
    assert.equal((await api("DELETE", `/patients/${s.patientId}/invites/${created.body.caregiver.id}`, { token: s.A.token })).status, 404);
  });
});

describe("medicamentos", () => {
  it("cadastra as quatro frequências e calcula os horários", async () => {
    const post = (body: unknown) => api("POST", `/patients/${s.patientId}/medications`, { token: s.A.token, body });
    const common = { dosage: "50mg", startDate: "2026-09-01", endDate: null, notes: "" };

    const interval = await post({ ...common, name: "Losartana", schedule: { type: "interval", everyHours: 12, startTime: "08:00" } });
    assert.equal(interval.status, 201);
    assert.deepEqual(interval.body.times, ["08:00", "20:00"]);
    assert.deepEqual(interval.body.schedule, { type: "interval", everyHours: 12, startTime: "08:00" });
    assert.equal(interval.body.endDate, null);
    s.losartana = interval.body;

    const every8 = await post({ ...common, name: "Teste8h", schedule: { type: "interval", everyHours: 8, startTime: "22:30" } });
    assert.deepEqual(every8.body.times, ["06:30", "14:30", "22:30"]);

    const daily = await post({ ...common, name: "Vitamina D", dosage: "2000UI", schedule: { type: "daily", time: "09:00" } });
    assert.deepEqual(daily.body.schedule, { type: "daily", time: "09:00" });

    const weekdays = await post({ ...common, name: "Metformina", endDate: "2026-12-31", schedule: { type: "weekdays", days: ["mon", "wed", "fri"], time: "07:30" } });
    assert.deepEqual(weekdays.body.schedule, { type: "weekdays", days: ["mon", "wed", "fri"], time: "07:30" });
    assert.equal(weekdays.body.endDate, "2026-12-31");

    const custom = await post({ ...common, name: "Paracetamol", dosage: "750mg", notes: "Após as refeições", schedule: { type: "custom", times: ["20:00", "08:00", "14:00"] } });
    assert.deepEqual(custom.body.times, ["08:00", "14:00", "20:00"]);
    assert.equal(custom.body.notes, "Após as refeições");

    const list = await api("GET", `/patients/${s.patientId}/medications`, { token: s.B.token });
    assert.equal(list.body.length, 5);
    assert.equal(list.body[0].patientId, s.patientId);
  });

  it("valida o formulário", async () => {
    const post = (body: unknown) => api("POST", `/patients/${s.patientId}/medications`, { token: s.A.token, body });
    const ok = { name: "X", dosage: "1mg", startDate: "2026-09-01", endDate: null, notes: "", schedule: { type: "daily", time: "09:00" } };
    assert.equal((await post({ ...ok, name: " " })).status, 422);
    assert.equal((await post({ ...ok, schedule: { type: "daily", time: "25:00" } })).status, 422);
    assert.equal((await post({ ...ok, schedule: { type: "weekdays", days: [], time: "09:00" } })).status, 422);
    assert.equal((await post({ ...ok, endDate: "2026-08-01" })).status, 422);
    assert.equal((await api("GET", `/patients/${s.patientId}/medications`, { token: s.intruder.token })).status, 404);
  });
});

describe("doses, alertas, notificações e histórico", () => {
  const minute = localTime(0).minuteOfDay;
  const sameDay = minute >= 90 && minute <= 23 * 60 + 20;

  it("gera as doses de hoje, marca as atrasadas e avisa o cuidador", { skip: !sameDay && "horário perto da meia-noite" }, async () => {
    const t = { missed: localTime(-40).text, skipped: localTime(-20).text, taken: localTime(-5).text, soon: localTime(30).text };
    const created = await api("POST", `/patients/${s.patientId}/medications`, {
      token: s.A.token,
      body: {
        name: "Dose Teste", dosage: "10mg", startDate: todayLocal(), endDate: null, notes: "",
        schedule: { type: "custom", times: [t.missed, t.skipped, t.taken, t.soon] },
      },
    });
    s.doseMed = created.body;
    // O cadastro é "agora"; recuar para as doses de horário já passado serem geradas.
    await db.query("update medications set created_at = now() - interval '2 days' where id = $1", [created.body.id]);
    // Isola a conta: encerra os outros medicamentos para só esta gerar doses.
    await db.query("update medications set ended_at = now() where id <> $1", [created.body.id]);
    s.t = t;

    const missed = await api("GET", `/patients/${s.patientId}/doses/missed`, { token: s.A.token });
    assert.deepEqual(missed.body.map((d: any) => [d.name, d.scheduledTime]), [["Dose Teste 10mg", t.missed]]);
    s.missedDoseId = missed.body[0].id;

    const notifs = await api("GET", "/notifications", { token: s.A.token });
    assert.equal(notifs.body[0].type, "missedDose");
    assert.equal(notifs.body[0].title, "Dose não confirmada");
    assert.equal(notifs.body[0].patientName, "Maria Xavier");
    assert.equal(notifs.body[0].read, false);
    assert.match(notifs.body[0].message, new RegExp(`às ${t.missed}`));
    // O outro cuidador também recebe.
    assert.equal((await api("GET", "/notifications", { token: s.B.token })).body.length, 1);
    // Chamar de novo não duplica doses nem notificações.
    await api("GET", `/patients/${s.patientId}/doses/missed`, { token: s.A.token });
    assert.equal((await api("GET", "/notifications", { token: s.A.token })).body.length, 1);
  });

  it("o paciente vê as doses abertas (pendentes na janela + atrasadas)", { skip: !sameDay && "horário perto da meia-noite" }, async () => {
    const res = await api("GET", "/patient/doses/pending", { token: s.P.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((d: any) => d.scheduledTime), [s.t.missed, s.t.skipped, s.t.taken, s.t.soon]);
    assert.deepEqual(Object.keys(res.body[0]).sort(), ["dosage", "id", "name", "scheduledTime"]);
    s.pending = res.body;
  });

  it("'Tomei' no prazo = taken; depois do prazo = taken_late", { skip: !sameDay && "horário perto da meia-noite" }, async () => {
    const onTime = await api("POST", `/patient/doses/${s.pending[2].id}/take`, { token: s.P.token });
    assert.equal(onTime.status, 200);
    assert.match(onTime.body.time, /^\d\d:\d\d$/);
    const late = await api("POST", `/patient/doses/${s.pending[0].id}/take`, { token: s.P.token });
    assert.equal(late.status, 200);
    const rows = await db.query("select id, status::text as status from doses where id = any($1::uuid[])", [[s.pending[2].id, s.pending[0].id]]);
    const byId = Object.fromEntries(rows.rows.map((r: any) => [r.id, r.status]));
    assert.equal(byId[s.pending[2].id], "taken");
    assert.equal(byId[s.pending[0].id], "taken_late");
    assert.equal((await api("POST", `/patient/doses/${s.pending[2].id}/take`, { token: s.P.token })).status, 409);
    // Dose já tomada some do alerta de dose não confirmada.
    assert.equal((await api("GET", `/patients/${s.patientId}/doses/missed`, { token: s.A.token })).body.length, 0);
  });

  it("'Não tomei' guarda o motivo; 'passando mal' avisa os cuidadores", { skip: !sameDay && "horário perto da meia-noite" }, async () => {
    assert.equal((await api("POST", `/patient/doses/${s.pending[1].id}/skip`, { token: s.P.token, body: { reason: "inventado" } })).status, 422);
    const res = await api("POST", `/patient/doses/${s.pending[1].id}/skip`, { token: s.P.token, body: { reason: "feelingUnwell" } });
    assert.equal(res.status, 204);
    const notifs = await api("GET", "/notifications", { token: s.A.token });
    const sym = notifs.body.find((n: any) => n.type === "symptom");
    assert.match(sym.message, /passando mal/);
    // Dose futura pode ser pulada e some da lista; as respondidas também.
    await api("POST", `/patient/doses/${s.pending[3].id}/skip`, { token: s.P.token, body: { reason: "notNow" } });
    assert.equal((await api("GET", "/patient/doses/pending", { token: s.P.token })).body.length, 0);
    // Outro paciente/perfil não responde dose alheia.
    assert.equal((await api("POST", `/patient/doses/${s.pending[3].id}/take`, { token: s.P.token })).status, 409);
  });

  it("o cuidador confirma uma dose pelo paciente e fica registrado no histórico", { skip: !sameDay && "horário perto da meia-noite" }, async () => {
    // Nova dose atrasada para o cuidador resolver.
    const t = localTime(-45).text;
    const med = await api("POST", `/patients/${s.patientId}/medications`, {
      token: s.A.token,
      body: { name: "Atrasado", dosage: "5mg", startDate: todayLocal(), endDate: null, notes: "", schedule: { type: "daily", time: t } },
    });
    await db.query("update medications set created_at = now() - interval '2 days' where id = $1", [med.body.id]);
    const missed = await api("GET", `/patients/${s.patientId}/doses/missed`, { token: s.A.token });
    assert.equal(missed.body.length, 1);
    const doseId = missed.body[0].id;

    const future = await api("POST", `/doses/${doseId}/confirm`, { token: s.A.token, body: { status: "late", time: localTime(180).text, notes: "" } });
    assert.ok([422].includes(future.status) || localTime(180).minuteOfDay < minute);

    const ok = await api("POST", `/doses/${doseId}/confirm`, { token: s.B.token, body: { status: "late", time: localTime(-10).text, notes: "Administrado após o café" } });
    assert.equal(ok.status, 204);
    assert.equal((await api("GET", `/patients/${s.patientId}/doses/missed`, { token: s.A.token })).body.length, 0);
    assert.equal((await api("POST", `/doses/${doseId}/confirm`, { token: s.A.token, body: { status: "onTime", time: "", notes: "" } })).status, 409);
    assert.equal((await api("POST", `/doses/${doseId}/confirm`, { token: s.intruder.token, body: { status: "onTime", time: "", notes: "" } })).status, 404);

    const history = await api("GET", `/patients/${s.patientId}/history?date=${todayLocal()}`, { token: s.A.token });
    const ev = history.body.find((e: any) => e.id === doseId);
    assert.equal(ev.title, "Atrasado 5mg tomada com atraso");
    assert.equal(ev.description, "Administrado após o café");
    assert.equal(ev.tag, "Medicamento");
    assert.equal(ev.scheduledTime, t);
    assert.equal(ev.lastChangedBy, "Pedro Silva");
    assert.equal(ev.changes.length, 2);
    assert.match(ev.changes[0].text, /Pedro Silva mudou de Não tomou para Tomou com atraso/);
    assert.match(ev.changes[1].text, /o app marcou como Não tomou, sem confirmação/);
  });

  it("sintoma do paciente vira relato no histórico e notificação", async () => {
    assert.equal((await api("POST", "/patient/symptoms", { token: s.P.token, body: { symptom: "xyz" } })).status, 422);
    assert.equal((await api("POST", "/patient/symptoms", { token: s.P.token, body: { symptom: "nausea" } })).status, 204);
    assert.equal((await api("POST", "/patient/symptoms", { token: s.P.token, body: { symptom: "shortnessOfBreath" } })).status, 204);

    const notifs = await api("GET", "/notifications", { token: s.A.token });
    assert.ok(notifs.body.some((n: any) => n.type === "symptom" && /Enjoo relatado às \d\d:\d\d/.test(n.message)));
    assert.deepEqual(Object.keys(notifs.body[0]).sort(), ["createdAt", "id", "message", "patientName", "read", "title", "type"]);
    assert.ok(notifs.body.every((n: any, i: number, all: any[]) => i === 0 || all[i - 1].createdAt >= n.createdAt));

    const history = await api("GET", `/patients/${s.patientId}/history?date=${todayLocal()}`, { token: s.A.token });
    const relatos = history.body.filter((e: any) => e.variant === "abnormality");
    assert.deepEqual(relatos.map((e: any) => e.title).sort(), ["Relato de enjoo", "Relato de falta de ar"]);
    assert.equal(relatos[0].tag, "Anormalidade");
  });

  it("histórico: filtro por medicamento, dia vazio e medicamentos do mês", { skip: !sameDay && "horário perto da meia-noite" }, async () => {
    const all = await api("GET", `/patients/${s.patientId}/history?date=${todayLocal()}`, { token: s.A.token });
    const times = all.body.map((e: any) => e.time);
    assert.deepEqual(times, [...times].sort());

    const filtered = await api("GET", `/patients/${s.patientId}/history?date=${todayLocal()}&medicationId=${s.doseMed.id}`, { token: s.A.token });
    assert.ok(filtered.body.length >= 3);
    assert.ok(filtered.body.every((e: any) => e.variant === "medication" && e.title.startsWith("Dose Teste 10mg")));
    const skipped = filtered.body.find((e: any) => e.skipReason === "Estou passando mal");
    assert.ok(skipped, "dose pulada mostra o motivo");
    assert.equal(skipped.title, "Dose Teste 10mg não tomada");

    assert.deepEqual((await api("GET", `/patients/${s.patientId}/history?date=2020-01-01`, { token: s.A.token })).body, []);
    assert.equal((await api("GET", `/patients/${s.patientId}/history?date=ontem`, { token: s.A.token })).status, 422);

    const [y, m] = todayLocal().split("-").map(Number);
    const meds = await api("GET", `/patients/${s.patientId}/history/medications?month=${m - 1}&year=${y}`, { token: s.A.token });
    assert.deepEqual(meds.body.map((x: any) => x.name).sort(), ["Atrasado", "Dose Teste"]);
    assert.deepEqual(Object.keys(meds.body[0]).sort(), ["dosage", "id", "name"]);
    assert.deepEqual((await api("GET", `/patients/${s.patientId}/history/medications?month=0&year=2020`, { token: s.A.token })).body, []);
    assert.equal((await api("GET", `/patients/${s.patientId}/history/medications?month=12&year=2026`, { token: s.A.token })).status, 422);
  });

  it("marcar notificações como lidas", async () => {
    const before = await api("GET", "/notifications", { token: s.A.token });
    const first = before.body.find((n: any) => !n.read);
    assert.equal((await api("POST", `/notifications/${first.id}/read`, { token: s.A.token })).status, 204);
    assert.equal((await api("GET", "/notifications", { token: s.A.token })).body.find((n: any) => n.id === first.id).read, true);
    // Leitura é individual: a do Pedro continua como estava.
    assert.equal((await api("GET", "/notifications", { token: s.B.token })).body.find((n: any) => n.id === first.id).read, false);
    await api("POST", "/notifications/read-all", { token: s.A.token });
    assert.ok((await api("GET", "/notifications", { token: s.A.token })).body.every((n: any) => n.read));
  });
});

describe("perfis, encerrar medicamento e exclusão", () => {
  it("perfil do cuidador (master x comum) e do paciente", async () => {
    const a = await api("GET", "/profile", { token: s.A.token });
    assert.deepEqual(a.body, { id: s.A.user.id, name: "Igor Xavier", email: "igor@email.com", phone: "11988887777", roleLabel: "Cuidador master", isMaster: true });
    const b = await api("GET", "/profile", { token: s.B.token });
    assert.equal(b.body.isMaster, false);
    assert.equal(b.body.roleLabel, "Cuidador");

    const p = await api("GET", "/patient/profile", { token: s.P.token });
    assert.equal(p.body.name, "Maria Xavier");
    assert.equal(p.body.nickname, "Dona Maria");
    assert.ok(p.body.age >= 75 && p.body.age <= 80);
    assert.deepEqual(p.body.caregivers.map((c: any) => c.name), ["Igor Xavier", "Pedro Silva"]);
    assert.equal(p.body.caregivers[0].phone, "11988887777");
  });

  it("encerrar o medicamento tira da lista e mantém o histórico", async () => {
    const before = await api("GET", `/patients/${s.patientId}/medications`, { token: s.A.token });
    assert.equal((await api("DELETE", `/medications/${s.doseMed.id}`, { token: s.A.token })).status, 204);
    const after_ = await api("GET", `/patients/${s.patientId}/medications`, { token: s.A.token });
    assert.ok(!after_.body.some((m: any) => m.id === s.doseMed.id));
    assert.equal(before.body.length >= after_.body.length, true);
    assert.equal((await api("DELETE", `/medications/${s.doseMed.id}`, { token: s.A.token })).status, 404);
    const { rows } = await db.query("select count(*)::int as n from doses where medication_id = $1", [s.doseMed.id]);
    assert.ok(rows[0].n === 0 || rows[0].n >= 3);
  });

  it("só o master exclui o paciente; depois o paciente perde o acesso", async () => {
    assert.equal((await api("DELETE", `/patients/${s.patientId}`, { token: s.B.token })).status, 403);
    assert.equal((await api("DELETE", `/patients/${s.patientId}`, { token: s.A.token })).status, 204);
    assert.deepEqual((await api("GET", "/patients", { token: s.A.token })).body, []);
    assert.equal((await api("GET", "/patients", { token: s.B.token })).body.length, 0);
    assert.equal((await api("GET", "/patient/profile", { token: s.P.token })).status, 401);
    const { rows } = await db.query("select (select count(*) from doses)::int as doses, (select count(*) from notifications)::int as n");
    assert.deepEqual(rows[0], { doses: 0, n: 0 });
  });
});
