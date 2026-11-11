-- =====================================================================
-- Zelo: banco de dados do MVP (PostgreSQL 16)
-- =====================================================================
-- Segue o que o app faz hoje (src/services/*). Nomes em inglês, como no
-- restante do projeto; comentários em português.
--
-- O que ficou de fora do MVP (existe no modelo v2, database/schema.sql
-- do projeto completo): planos e assinatura, catálogo de bulas e
-- interações, saúde do paciente, editar/anular histórico, pedido de
-- ajuda, tokens de push e lembretes do servidor.
--
-- Dados sensíveis (LGPD): o CPF NUNCA é guardado em texto. A API grava
-- só o hash (HMAC-SHA256 com um segredo do servidor).

create extension if not exists pgcrypto;  -- gen_random_uuid()

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- =====================================================================
-- 1. IDENTIDADE E ACESSO
-- =====================================================================

-- Cuidadores. O paciente não tem conta: entra com o código de pareamento.
create table users (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    email           text not null,
    phone           text,                       -- telefone com WhatsApp, só números
    cpf_hash        text not null unique,
    password_hash   text not null,              -- scrypt (formato "salt:hash")
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index users_email_key on users (lower(email));

create trigger users_updated_at before update on users
    for each row execute function set_updated_at();

create table patients (
    id              uuid primary key default gen_random_uuid(),
    full_name       text not null,
    nickname        text not null default '',   -- como o paciente gosta de ser chamado
    birth_date      date not null,
    cpf_hash        text not null unique,       -- evita cadastro duplicado
    -- Checkbox "tenho autorização para cadastrar este paciente"
    authorization_confirmed_at  timestamptz not null default now(),
    created_by      uuid not null references users(id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create trigger patients_updated_at before update on patients
    for each row execute function set_updated_at();

-- Vínculo N para N entre cuidador e paciente.
-- Quem cadastrou o paciente é o master (um único por paciente): só ele
-- convida cuidadores e exclui o paciente.
create table patient_caregivers (
    patient_id      uuid not null references patients(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    is_master       boolean not null default false,
    relationship    text,                       -- ex.: "Mãe" (opcional)
    created_at      timestamptz not null default now(),

    primary key (patient_id, user_id)
);

create unique index one_master_per_patient
    on patient_caregivers (patient_id) where is_master;
create index patient_caregivers_user_idx on patient_caregivers (user_id);

-- Convite de cuidador: o link vale 7 dias. O token só existe no link;
-- no banco fica o hash.
create type invite_status as enum ('pending', 'accepted', 'canceled');

create table caregiver_invites (
    id              uuid primary key default gen_random_uuid(),
    patient_id      uuid not null references patients(id) on delete cascade,
    invited_by      uuid not null references users(id),
    name            text not null,
    email           text not null,
    token_hash      text not null unique,
    status          invite_status not null default 'pending',
    expires_at      timestamptz not null,
    accepted_by     uuid references users(id) on delete set null,
    accepted_at     timestamptz,
    created_at      timestamptz not null default now(),
    last_sent_at    timestamptz not null default now()
);

-- Só um convite pendente por paciente e e-mail
create unique index one_pending_invite_per_email
    on caregiver_invites (patient_id, lower(email)) where status = 'pending';

-- Código de pareamento (6 números): vale 24 horas e só pode ser usado uma vez.
create table patient_pairing_codes (
    id              uuid primary key default gen_random_uuid(),
    patient_id      uuid not null references patients(id) on delete cascade,
    code_hash       text not null,
    created_by      uuid references users(id) on delete set null,
    expires_at      timestamptz not null,
    used_at         timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz not null default now()
);

-- Dois códigos ativos com o mesmo hash deixariam o login ambíguo
create unique index one_active_pairing_code
    on patient_pairing_codes (code_hash) where used_at is null and revoked_at is null;

-- =====================================================================
-- 2. MEDICAMENTOS E HORÁRIOS
-- =====================================================================

create type schedule_type as enum ('interval', 'daily', 'weekdays', 'custom');

create table medications (
    id                  uuid primary key default gen_random_uuid(),
    patient_id          uuid not null references patients(id) on delete cascade,
    name                text not null,          -- ex.: "Losartana"
    dosage              text not null,          -- ex.: "50mg"

    -- As quatro frequências do formulário:
    --   interval -> "a cada X horas": interval_hours + interval_start_time
    --   daily    -> uma vez ao dia (um horário)
    --   weekdays -> dias da semana (weekdays + um horário)
    --   custom   -> vários horários
    schedule_type       schedule_type not null,
    interval_hours      smallint,
    interval_start_time time,
    weekdays            smallint[],             -- ISO: 1=Seg ... 7=Dom

    start_date          date not null,
    end_date            date,                   -- nulo = uso contínuo
    notes               text not null default '',

    -- "Encerrar": sai da lista, mas as doses já registradas continuam
    ended_at            timestamptz,
    ended_by            uuid references users(id) on delete set null,

    created_by          uuid references users(id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    check (end_date is null or end_date >= start_date),
    check (interval_hours is null or interval_hours between 1 and 24),
    check (weekdays is null or weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
    check (
        (schedule_type = 'interval' and interval_hours is not null and interval_start_time is not null)
        or (schedule_type = 'weekdays' and weekdays is not null and cardinality(weekdays) > 0)
        or schedule_type in ('daily', 'custom')
    )
);

create index medications_patient_active_idx on medications (patient_id) where ended_at is null;

create trigger medications_updated_at before update on medications
    for each row execute function set_updated_at();

-- Horários de cada dose, já calculados (inclusive os do intervalo fixo).
-- Dão origem às doses do dia.
create table medication_schedule_times (
    medication_id   uuid not null references medications(id) on delete cascade,
    time_of_day     time not null,

    primary key (medication_id, time_of_day)
);

-- =====================================================================
-- 3. DOSES E SINTOMAS
-- =====================================================================

-- pending    : aguardando o paciente
-- taken      : tomada no horário
-- taken_late : tomada com atraso
-- missed     : passou do horário sem confirmação (ou o cuidador marcou "Não tomou")
-- skipped    : o paciente disse "Não tomei" e escolheu um motivo
create type dose_status as enum ('pending', 'taken', 'taken_late', 'missed', 'skipped');
create type actor_type as enum ('patient', 'caregiver', 'system');

-- Uma linha por dose esperada. A API gera as doses do dia a partir dos
-- horários do medicamento.
create table doses (
    id                      uuid primary key default gen_random_uuid(),
    patient_id              uuid not null references patients(id) on delete cascade,
    medication_id           uuid not null references medications(id) on delete cascade,
    scheduled_at            timestamptz not null,
    status                  dose_status not null default 'pending',
    taken_at                timestamptz,
    confirmed_by_type       actor_type,
    confirmed_by_user_id    uuid references users(id) on delete set null,
    note                    text,
    -- feelingUnwell | ranOut | notNow | other | noAnswer
    skip_reason             text,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    unique (medication_id, scheduled_at),       -- gerar duas vezes não duplica
    check ((status in ('taken', 'taken_late')) = (taken_at is not null)),
    check (skip_reason is null or status = 'skipped')
);

create index doses_patient_date_idx on doses (patient_id, scheduled_at);
create index doses_pending_idx on doses (scheduled_at) where status = 'pending';

create trigger doses_updated_at before update on doses
    for each row execute function set_updated_at();

-- Trilha de cada dose: alimenta o bloco "Alterações" do detalhe do histórico
-- (ex.: "o app marcou como Não tomou, sem confirmação").
create table dose_events (
    id              uuid primary key default gen_random_uuid(),
    dose_id         uuid not null references doses(id) on delete cascade,
    actor_type      actor_type not null,
    actor_user_id   uuid references users(id) on delete set null,
    from_status     dose_status,
    to_status       dose_status not null,
    note            text,
    created_at      timestamptz not null default now()
);

create index dose_events_dose_idx on dose_events (dose_id, created_at);

-- Diário de sintomas do paciente ("Como está se sentindo hoje?")
create type symptom_kind as enum ('pain', 'nausea', 'dizziness', 'fatigue', 'shortness_of_breath', 'other');

create table symptom_reports (
    id              uuid primary key default gen_random_uuid(),
    patient_id      uuid not null references patients(id) on delete cascade,
    kind            symptom_kind not null,
    reported_at     timestamptz not null default now()
);

create index symptom_reports_patient_date_idx on symptom_reports (patient_id, reported_at);

-- =====================================================================
-- 4. NOTIFICAÇÕES DO CUIDADOR
-- =====================================================================

create type notification_type as enum ('missed_dose', 'symptom');

create table notifications (
    id                  uuid primary key default gen_random_uuid(),
    patient_id          uuid not null references patients(id) on delete cascade,
    type                notification_type not null,
    title               text not null,
    message             text not null,
    dose_id             uuid references doses(id) on delete cascade,
    symptom_report_id   uuid references symptom_reports(id) on delete cascade,
    created_at          timestamptz not null default now(),

    -- Uma notificação por dose e por relato
    unique (dose_id, type),
    unique (symptom_report_id)
);

-- Uma notificação, vários cuidadores: cada um tem o seu "lida"
create table notification_recipients (
    notification_id uuid not null references notifications(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    read_at         timestamptz,

    primary key (notification_id, user_id)
);

create index notification_recipients_user_idx
    on notification_recipients (user_id, notification_id);
