-- Visit report: run in the Supabase SQL Editor (save it as a snippet).
-- Labels each visitor by its user agent so automated indexers and crawlers
-- can be set aside and the remaining arrivals looked at by hand. A label is a
-- guess from a self-reported header, not proof of who or what visited.
-- Add new indexers to the lists below as they show up.

with labeled as (
  select v.*,
    case
      when v.path = '/.well-known/glama.json'
        or v.user_agent ~* '(pluginboard|mcplayer|fraywick|factanker|glama|smithery|pulsemcp|mcp\.so|mcp-?registry|carrot-intent|ziwei)'
        then 'mcp_directory_indexer'
      when v.user_agent ~* '(googlebot|bingbot|applebot|duckduckbot|yandex|baiduspider|invokerank|ahrefs|semrush|mj12bot|dotbot)'
        then 'search_crawler'
      when v.user_agent ~* '(gptbot|claudebot|anthropic-ai|ccbot|google-extended|bytespider|amazonbot|meta-externalagent|perplexitybot|cohere-ai)'
        then 'ai_training_or_index_crawler'
      when v.user_agent ~* '(chatgpt-user|oai-searchbot|claude-user|claude-searchbot|perplexity-user|mistralai-user|duckassistbot)'
        then 'ai_assistant_fetch'
      when v.user_agent ~* '(undici|node-fetch|axios|python-requests|python-httpx|aiohttp|curl/|wget|go-http-client|okhttp|java/)'
        then 'script_or_sdk'
      when v.user_agent ~* 'mozilla' and v.user_agent !~* '(bot|crawler|spider|headless)'
        then 'browser'
      when v.user_agent is null then 'no_user_agent'
      else 'other'
    end as label
  from public.visit_events v
)

-- 1. One row per visitor: what it is, what it touched, when.
select label,
       left(min(user_agent), 80) as user_agent,
       visitor_hash,
       count(*) as requests,
       string_agg(distinct path, ', ') as paths,
       min(created_at) as first_seen,
       max(created_at) as last_seen,
       bool_or(referrer is not null) as had_referrer
from labeled
group by label, visitor_hash
order by
  -- Unlabeled and assistant traffic first: that's where independent arrivals would be.
  case label
    when 'ai_assistant_fetch' then 0
    when 'other' then 1
    when 'script_or_sdk' then 2
    when 'browser' then 3
    when 'no_user_agent' then 4
    else 5
  end,
  last_seen desc;

-- 2. Totals per label (run on its own):
--   with labeled as (...same CTE as above...)
--   select label, count(distinct visitor_hash) as visitors, count(*) as requests
--   from labeled group by label order by visitors desc;
