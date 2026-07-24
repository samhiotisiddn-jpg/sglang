import postgres from "postgres";

interface Env {
  HYPERDRIVE: { connectionString: string };
  OBSIDIAN_SYNC_TOKEN: string;
  EMBEDDING_API_URL: string;
  EMBEDDING_API_KEY: string;
  EMBEDDING_MODEL: string;
}

interface Chunk {
  id: string;
  agentId: string;
  memoryScope?: string;
  sourceUri?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

async function createEmbedding(env: Env, text: string): Promise<number[]> {
  const response = await fetch(env.EMBEDDING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: text }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = payload.data?.[0]?.embedding;

  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding API response did not include an embedding vector");
  }

  return embedding;
}

async function upsertChunk(client: postgres.Sql, chunk: Chunk, embedding: number[]) {
  await client`
    insert into public.fm_agent_memory (
      agent_id,
      memory_scope,
      source_uri,
      content,
      content_embedding,
      metadata,
      accessed_at
    ) values (
      ${chunk.agentId},
      ${chunk.memoryScope ?? "global"},
      ${chunk.sourceUri ?? null},
      ${chunk.content},
      ${JSON.stringify(embedding)}::vector,
      ${JSON.stringify(chunk.metadata ?? {})}::jsonb,
      now()
    )
    on conflict (agent_id, source_uri)
    where source_uri is not null
    do update set
      content = excluded.content,
      content_embedding = excluded.content_embedding,
      metadata = excluded.metadata,
      accessed_at = now();
  `;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const token = request.headers.get("x-obsidian-token");
    if (!token || token !== env.OBSIDIAN_SYNC_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = (await request.json()) as { chunks?: Chunk[] };
    const chunks = body.chunks ?? [];

    if (chunks.length === 0) {
      return Response.json({ inserted: 0 });
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      max: 4,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });

    try {
      let inserted = 0;
      for (const chunk of chunks) {
        if (!chunk.id || !chunk.agentId || !chunk.content) {
          continue;
        }
        const embedding = await createEmbedding(env, chunk.content);
        await upsertChunk(client, chunk, embedding);
        inserted += 1;
      }
      return Response.json({ inserted });
    } finally {
      ctx.waitUntil(client.end({ timeout: 5 }));
    }
  },
};
