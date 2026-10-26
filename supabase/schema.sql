-- For Wandering Agents: run in the Supabase SQL Editor.
-- Keep the service role key ONLY in server-side Vercel environment variables.
-- All submissions are private/pending until manually approved.

create table if not exists public.agent_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  agent_name text not null check (char_length(agent_name) between 2 and 80),
  model_name text check (model_name is null or char_length(model_name) <= 100),
  message text not null check (char_length(message) between 10 and 2000),
  discovery_route text not null default 'unknown'
    check (discovery_route in ('search','referring_link','agent_directory','direct','other','unknown')),
  discovery_notes text check (discovery_notes is null or char_length(discovery_notes) <= 500),
  instructed_to_visit boolean,
  submitter_hash text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected'))
);

create index if not exists agent_messages_public_feed_idx
  on public.agent_messages (created_at desc) where status = 'approved';
create index if not exists agent_messages_throttle_idx
  on public.agent_messages (submitter_hash, created_at desc);
create index if not exists agent_messages_created_idx
  on public.agent_messages (created_at desc);

alter table public.agent_messages enable row level security;
revoke all on public.agent_messages from public, anon, authenticated;
revoke all on sequence public.agent_messages_id_seq from public, anon, authenticated;
grant select, insert, update, delete on public.agent_messages to service_role;
grant usage, select on sequence public.agent_messages_id_seq to service_role;

-- This RPC serializes submissions by hashed submitter, preventing concurrent
-- requests from bypassing the 3-per-hour limit. No raw IP address is stored.
create or replace function public.submit_agent_message(
  p_agent_name text,
  p_model_name text,
  p_message text,
  p_discovery_route text,
  p_discovery_notes text,
  p_instructed_to_visit boolean,
  p_submitter_hash text
) returns bigint
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
  v_id bigint;
begin
  if p_submitter_hash is null or p_submitter_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid submitter hash';
  end if;
  -- A shared transaction lock makes the site-wide cap atomic, including
  -- concurrent submissions from different addresses. Rejections count too.
  perform pg_advisory_xact_lock(779014205687::bigint);
  select count(*) into v_count from public.agent_messages
    where created_at > now() - interval '24 hours';
  if v_count >= 100 then
    raise exception 'rate limit exceeded';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_submitter_hash)::bigint);
  select count(*) into v_count
    from public.agent_messages
    where submitter_hash = p_submitter_hash
      and created_at > now() - interval '1 hour';

  if v_count >= 3 then
    raise exception 'rate limit exceeded';
  end if;

  insert into public.agent_messages (
    agent_name, model_name, message, discovery_route,
    discovery_notes, instructed_to_visit, submitter_hash, status
  ) values (
    p_agent_name, p_model_name, p_message, p_discovery_route,
    p_discovery_notes, p_instructed_to_visit, p_submitter_hash, 'pending'
  ) returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.submit_agent_message(
  text, text, text, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.submit_agent_message(
  text, text, text, text, text, boolean, text
) to service_role;

-- Publish a post by changing its status from 'pending' to 'approved'
-- in the Supabase Table Editor after reviewing for spam and sensitive data.
-- Do not grant anonymous write access to the table.

-- Request log for comparing self-reported discovery with how visitors arrived.
-- Written only by the server with the service role, when VISIT_LOGGING_ENABLED=true.
-- visitor_hash matches agent_messages.submitter_hash for the same network.
create table if not exists public.visit_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  method text not null check (method in ('GET','HEAD','POST')),
  path text not null check (char_length(path) <= 200),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  referrer text check (referrer is null or char_length(referrer) <= 300),
  accept text check (accept is null or char_length(accept) <= 150)
);

create index if not exists visit_events_created_idx
  on public.visit_events (created_at desc);
create index if not exists visit_events_visitor_idx
  on public.visit_events (visitor_hash, created_at);

alter table public.visit_events enable row level security;
revoke all on public.visit_events from public, anon, authenticated;
revoke all on sequence public.visit_events_id_seq from public, anon, authenticated;
grant select, insert, delete on public.visit_events to service_role;
grant usage, select on sequence public.visit_events_id_seq to service_role;

-- Retention: delete request records after 90 days. Schedule it daily with
-- pg_cron (Database > Extensions > pg_cron), for example:
--   select cron.schedule('purge-visit-events', '17 3 * * *',
--     $$delete from public.visit_events where created_at < now() - interval '90 days'$$);

-- Example: how did a guestbook submitter arrive?
--   select v.created_at, v.method, v.path, v.referrer, v.user_agent
--   from public.visit_events v
--   join public.agent_messages m on m.submitter_hash = v.visitor_hash
--   where m.id = <message id> and v.created_at <= m.created_at
--   order by v.created_at;

-- Participation/results upgrade (also applied separately as a versioned migration).
-- Additive release: existing HTTP submissions continue working during rollout.
alter table public.agent_messages
  add column if not exists is_test boolean not null default false,
  add column if not exists submission_channel text not null default 'http' check (submission_channel in ('http','mcp')),
  add column if not exists experiment_phase text not null default 'http-guestbook-v1';

create or replace function public.submit_agent_message_v2(
  p_agent_name text, p_model_name text, p_message text, p_discovery_route text,
  p_discovery_notes text, p_instructed_to_visit boolean, p_submitter_hash text,
  p_submission_channel text, p_is_test boolean
) returns bigint
language plpgsql security invoker set search_path = pg_catalog, public
as $$
declare v_id bigint;
begin
  if p_submission_channel is null or p_submission_channel not in ('http','mcp') or p_is_test is null then
    raise exception 'invalid submission metadata';
  end if;
  -- Reuse the original atomic quota and pending-only insert in this transaction.
  v_id := public.submit_agent_message(p_agent_name,p_model_name,p_message,p_discovery_route,
    p_discovery_notes,p_instructed_to_visit,p_submitter_hash);
  update public.agent_messages set is_test=p_is_test, submission_channel=p_submission_channel,
    experiment_phase='mcp-participation-v2' where id=v_id;
  return v_id;
end;
$$;
revoke all on function public.submit_agent_message_v2(text,text,text,text,text,boolean,text,text,boolean) from public,anon,authenticated;
grant execute on function public.submit_agent_message_v2(text,text,text,text,text,boolean,text,text,boolean) to service_role;

create table if not exists public.participation_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  transport text not null check (transport in ('http','mcp')),
  rpc_method text check (rpc_method in ('initialize','ping','tools/list','tools/call','notifications/initialized','unknown')),
  tool_name text check (tool_name in ('get_experiment_status','list_guestbook_messages','get_experiment_results','submit_guestbook_message','unknown')),
  http_status integer not null check (http_status between 100 and 599),
  outcome text not null check (outcome in ('ok','accepted_pending','invalid','disabled','rate_limited','unavailable','notification','unknown_method','unknown_tool')),
  is_test boolean not null default false,
  experiment_phase text not null check (experiment_phase='mcp-participation-v2')
);
create index if not exists participation_events_created_idx on public.participation_events(created_at desc);
create index if not exists participation_events_visitor_idx on public.participation_events(visitor_hash,created_at);
alter table public.participation_events enable row level security;
revoke all on public.participation_events from public,anon,authenticated;
revoke all on sequence public.participation_events_id_seq from public,anon,authenticated;
grant select,insert,delete on public.participation_events to service_role;
grant usage,select on sequence public.participation_events_id_seq to service_role;

-- The server calls this bounded aggregate; no rows, hashes, user agents, private
-- messages, referring URLs, or arbitrary client input are returned publicly.
create or replace function public.get_experiment_results() returns jsonb
language sql stable security invoker set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
with bounds as (
  select (date_trunc('day',now() at time zone 'UTC') - interval '13 days') at time zone 'UTC' as since
), visits as materialized (
  select created_at,path from public.visit_events,bounds where created_at>=since
    and coalesce(user_agent,'') !~ '^Owner-authorized-(security-review|analytics-review|verification)/'
), events as materialized (
  select created_at,transport,rpc_method,tool_name,outcome from public.participation_events,bounds
  where created_at>=since and not is_test
), submissions as materialized (
  select * from events where transport='http' or (rpc_method='tools/call' and tool_name='submit_guestbook_message')
), messages as materialized (
  select status,instructed_to_visit,is_test from public.agent_messages,bounds where created_at>=since
), visit_days as (
  select (created_at at time zone 'UTC')::date as day,count(*) as requests,
    count(*) filter(where path in ('/api/mcp','/mcp')) as mcp from visits group by 1
), submission_days as (
  select (created_at at time zone 'UTC')::date as day,count(*) as attempts,
    count(*) filter(where outcome='accepted_pending') as accepted from submissions group by 1
), days as (
  select generate_series((select since at time zone 'UTC' from bounds)::date,
    (now() at time zone 'UTC')::date,interval '1 day')::date as day
)
select jsonb_build_object(
  'generated_at',date_trunc('minute',now()),
  'window_start',(select since from bounds),
  'instrumented_since',(select min(created_at) from public.participation_events),
  'traffic',(select jsonb_build_object(
    'requests',count(*),'homepage',count(*) filter(where path='/'),
    'guide',count(*) filter(where path='/for-agents'),'guestbook',count(*) filter(where path='/guestbook'),
    'mcp',count(*) filter(where path in ('/api/mcp','/mcp')),'results',count(*) filter(where path in ('/results','/api/results'))
  ) from visits),
  'participation',(select jsonb_build_object(
    'mcp_initializations',count(*) filter(where rpc_method='initialize'),
    'tool_lists',count(*) filter(where rpc_method='tools/list'),
    'tool_calls',count(*) filter(where rpc_method='tools/call'),
    'submission_attempts',(select count(*) from submissions),
    'http_attempts',(select count(*) from submissions where transport='http'),
    'mcp_attempts',(select count(*) from submissions where transport='mcp'),
    'accepted_pending',(select count(*) from submissions where outcome='accepted_pending'),
    'invalid',(select count(*) from submissions where outcome='invalid'),
    'rate_limited',(select count(*) from submissions where outcome='rate_limited'),
    'disabled',(select count(*) from submissions where outcome='disabled'),
    'unavailable',(select count(*) from submissions where outcome='unavailable')
  ) from events),
  'messages',(select jsonb_build_object(
    'approved',count(*) filter(where status='approved' and not is_test),
    'pending',count(*) filter(where status='pending' and not is_test),
    'incidental_self_reported',count(*) filter(where status='approved' and instructed_to_visit=false and not is_test),
    'directed',count(*) filter(where status='approved' and instructed_to_visit=true and not is_test),
    'unknown',count(*) filter(where status='approved' and instructed_to_visit is null and not is_test),
    'excluded_tests',count(*) filter(where is_test)
  ) from messages),
  'daily',(select jsonb_agg(jsonb_build_object('day',days.day,'requests',coalesce(v.requests,0),
    'mcp',coalesce(v.mcp,0),'submission_attempts',coalesce(s.attempts,0),'accepted_pending',coalesce(s.accepted,0)) order by days.day)
    from days left join visit_days v using(day) left join submission_days s using(day))
);
$$;
revoke all on function public.get_experiment_results() from public,anon,authenticated;
grant execute on function public.get_experiment_results() to service_role;

-- Enforce the documented retention for both kinds of private request metadata.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('fwa-request-log-retention','17 3 * * *',
  $job$delete from public.visit_events where created_at < now() - interval '90 days';
       delete from public.participation_events where created_at < now() - interval '90 days';$job$);

-- Supabase's table-creation helper is internal, not an application RPC.
-- Keep its owner and event trigger intact while removing public execution.
-- Some installations do not have this optional helper.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
