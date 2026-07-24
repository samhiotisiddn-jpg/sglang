create extension if not exists vector;

create table if not exists public.fm_agent_memory (
  id bigserial primary key,
  agent_id text not null,
  memory_scope text not null default 'global',
  source_uri text,
  content text not null,
  content_embedding vector(1536) not null,
  metadata jsonb not null default '{}'::jsonb,
  importance_score real not null default 0.0,
  accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fm_agent_memory_agent_scope_idx
  on public.fm_agent_memory (agent_id, memory_scope);

create index if not exists fm_agent_memory_metadata_gin_idx
  on public.fm_agent_memory using gin (metadata);

create unique index if not exists fm_agent_memory_agent_source_uidx
  on public.fm_agent_memory (agent_id, source_uri)
  where source_uri is not null;

create index if not exists fm_agent_memory_embedding_hnsw_idx
  on public.fm_agent_memory
  using hnsw (content_embedding vector_cosine_ops)
  with (m = 24, ef_construction = 200);

create or replace function public.fm_agent_memory_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_fm_agent_memory_set_updated_at on public.fm_agent_memory;
create trigger trg_fm_agent_memory_set_updated_at
before update on public.fm_agent_memory
for each row
execute function public.fm_agent_memory_set_updated_at();

create table if not exists public.fm_agent_checkpoints (
  thread_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
