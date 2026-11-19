-- Execute apenas este arquivo para autorizar a conta já criada.
insert into public.gestores (user_id)
select id from auth.users where lower(email) = 'clayton@globalpecas.com'
on conflict do nothing;

select u.email from public.gestores g
join auth.users u on u.id = g.user_id
where lower(u.email) = 'clayton@globalpecas.com';
