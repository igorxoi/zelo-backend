create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create table users (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    email           text not null,
    phone           text,
    cpf_hash        text not null unique,
    password_hash   text not null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index users_email_key on users (lower(email));

create trigger users_updated_at before update on users
    for each row execute function set_updated_at();

create table patients (
    id              uuid primary key default gen_random_uuid(),
    full_name       text not null,
    nickname        text not null default '',
    birth_date      date not null,
    cpf_hash        text not null unique,
    authorization_confirmed_at  timestamptz not null default now(),
    created_by      uuid not null references users(id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create trigger patients_updated_at before update on patients
    for each row execute function set_updated_at();

create table patient_caregivers (
    patient_id      uuid not null references patients(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    is_master       boolean not null default false,
    relationship    text,
    created_at      timestamptz not null default now(),

    primary key (patient_id, user_id)
);

create unique index one_master_per_patient
    on patient_caregivers (patient_id) where is_master;
create index patient_caregivers_user_idx on patient_caregivers (user_id);

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

create unique index one_pending_invite_per_email
    on caregiver_invites (patient_id, lower(email)) where status = 'pending';

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

create unique index one_active_pairing_code
    on patient_pairing_codes (code_hash) where used_at is null and revoked_at is null;

create type schedule_type as enum ('interval', 'daily', 'weekdays', 'custom');

create table medications (
    id                  uuid primary key default gen_random_uuid(),
    patient_id          uuid not null references patients(id) on delete cascade,
    name                text not null,
    dosage              text not null,

    schedule_type       schedule_type not null,
    interval_hours      smallint,
    interval_start_time time,
    weekdays            smallint[],

    start_date          date not null,
    end_date            date,
    notes               text not null default '',

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

create table medication_schedule_times (
    medication_id   uuid not null references medications(id) on delete cascade,
    time_of_day     time not null,

    primary key (medication_id, time_of_day)
);

create type dose_status as enum ('pending', 'taken', 'taken_late', 'missed', 'skipped');
create type actor_type as enum ('patient', 'caregiver', 'system');

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
    skip_reason             text,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    unique (medication_id, scheduled_at),
    check ((status in ('taken', 'taken_late')) = (taken_at is not null)),
    check (skip_reason is null or status = 'skipped')
);

create index doses_patient_date_idx on doses (patient_id, scheduled_at);
create index doses_pending_idx on doses (scheduled_at) where status = 'pending';

create trigger doses_updated_at before update on doses
    for each row execute function set_updated_at();

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

create type symptom_kind as enum ('pain', 'nausea', 'dizziness', 'fatigue', 'shortness_of_breath', 'other');

create table symptom_reports (
    id              uuid primary key default gen_random_uuid(),
    patient_id      uuid not null references patients(id) on delete cascade,
    kind            symptom_kind not null,
    reported_at     timestamptz not null default now()
);

create index symptom_reports_patient_date_idx on symptom_reports (patient_id, reported_at);

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

    unique (dose_id, type),
    unique (symptom_report_id)
);

create table notification_recipients (
    notification_id uuid not null references notifications(id) on delete cascade,
    user_id         uuid not null references users(id) on delete cascade,
    read_at         timestamptz,

    primary key (notification_id, user_id)
);

create index notification_recipients_user_idx
    on notification_recipients (user_id, notification_id);
