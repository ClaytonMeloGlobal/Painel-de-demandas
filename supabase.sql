-- Execute uma vez em um projeto Supabase novo.
-- Antes, crie o gestor em Authentication > Users > Add user.
begin;

create table public.gestores (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.gestores enable row level security;
revoke all on public.gestores from anon, authenticated;
grant select on public.gestores to authenticated;
create policy "Gestor consulta sua autorizacao"
  on public.gestores for select to authenticated
  using (user_id = (select auth.uid()));

create table public.demandas (
  id uuid primary key default gen_random_uuid(),
  solicitante text not null check (char_length(trim(solicitante)) between 2 and 100),
  departamento text not null check (departamento in (
    'Comercial', 'Oficina/Operacional', 'Estoque/Peças', 'Financeiro', 'Administrativo'
  )),
  prioridade text not null check (prioridade in ('Baixa', 'Média', 'Alta/Urgente')),
  descricao text not null check (char_length(trim(descricao)) between 10 and 4000),
  status text not null default 'Pendente'
    check (status in ('Pendente', 'Em andamento', 'Concluído')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluida_em timestamptz
);
create index demandas_status_data on public.demandas(status, created_at desc);
alter table public.demandas enable row level security;
grant usage on schema public to anon, authenticated;
revoke all on public.demandas from anon, authenticated;
-- O formulário só pode inserir estes campos. Nunca status ou datas.
grant insert (id, solicitante, departamento, prioridade, descricao)
  on public.demandas to anon, authenticated;
-- Somente usuários autorizados pela RLS podem ler ou mudar o status.
grant select on public.demandas to authenticated;
grant update (status) on public.demandas to authenticated;

create policy "Formulario envia demandas pendentes"
  on public.demandas for insert to anon, authenticated
  with check (status = 'Pendente' and concluida_em is null);
create policy "Gestores leem demandas"
  on public.demandas for select to authenticated
  using (exists (
    select 1 from public.gestores g where g.user_id = (select auth.uid())
  ));
create policy "Gestores atualizam status"
  on public.demandas for update to authenticated
  using (exists (
    select 1 from public.gestores g where g.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.gestores g where g.user_id = (select auth.uid())
  ));

create function public.registrar_status_demanda()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  new.concluida_em := case when new.status = 'Concluído'
    then coalesce(old.concluida_em, now()) else null end;
  return new;
end;
$$;
create trigger registrar_status_demanda
  before update on public.demandas
  for each row execute function public.registrar_status_demanda();

-- Autoriza Clayton como gestor. Troque o e-mail se necessário.
insert into public.gestores (user_id)
select id from auth.users where lower(email) = 'clayton@globalpecas.com'
on conflict do nothing;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'demandas'
  ) then
    alter publication supabase_realtime add table public.demandas;
  end if;
end;
$$;
commit;

-- Confira se o gestor foi autorizado: deve aparecer 1 linha.
select g.user_id, u.email from public.gestores g
join auth.users u on u.id = g.user_id;
