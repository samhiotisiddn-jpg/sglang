export interface Env {
  KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const path = url.pathname;

    if (path === '/health') {
      return Response.json(
        { status: 'ok', worker: 'orange-forest-b577', timestamp: new Date().toISOString() },
        { headers: cors },
      );
    }

    if (path.startsWith('/api/')) {
      return handleAPI(path, request, env, cors);
    }

    return new Response(
      'FractalMesh KV Gateway\n\nEndpoints:\n' +
        '  GET  /health\n' +
        '  GET  /api/metrics\n' +
        '  POST /api/metrics\n' +
        '  GET  /api/trades\n' +
        '  POST /api/trades\n' +
        '  GET  /api/revenue\n' +
        '  POST /api/revenue\n' +
        '  GET  /api/kv\n' +
        '  GET  /api/kv/:key\n' +
        '  PUT  /api/kv/:key\n' +
        '  DELETE /api/kv/:key\n',
      { status: 200, headers: { ...cors, 'Content-Type': 'text/plain' } },
    );
  },
};

async function handleAPI(
  path: string,
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const ok = (data: unknown, status = 200) => Response.json(data, { status, headers: cors });
  const err = (msg: string, status = 400) => Response.json({ error: msg }, { status, headers: cors });

  // GET /api/metrics — aggregate dashboard counters
  if (path === '/api/metrics' && request.method === 'GET') {
    const data = await env.KV.get('metrics', 'json');
    return ok(
      data ?? { totalRevenue: 0, totalTrades: 0, leadsStaged: 0, dataAssetsMinted: 0, lastUpdated: null },
    );
  }

  // POST /api/metrics — merge-patch update
  if (path === '/api/metrics' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    const existing = ((await env.KV.get('metrics', 'json')) as Record<string, unknown>) ?? {};
    const updated = { ...existing, ...body, lastUpdated: new Date().toISOString() };
    await env.KV.put('metrics', JSON.stringify(updated));
    return ok(updated);
  }

  // GET /api/trades
  if (path === '/api/trades' && request.method === 'GET') {
    return ok((await env.KV.get('trades', 'json')) ?? []);
  }

  // POST /api/trades — prepend, keep last 500
  if (path === '/api/trades' && request.method === 'POST') {
    const trade = { ...((await request.json()) as object), time: new Date().toISOString() };
    const trades = ((await env.KV.get('trades', 'json')) as unknown[]) ?? [];
    const next = [trade, ...trades].slice(0, 500);
    await env.KV.put('trades', JSON.stringify(next));
    // Bump trade counter
    const m = ((await env.KV.get('metrics', 'json')) as Record<string, unknown>) ?? {};
    await env.KV.put(
      'metrics',
      JSON.stringify({ ...m, totalTrades: ((m.totalTrades as number) ?? 0) + 1, lastUpdated: new Date().toISOString() }),
    );
    return ok(trade, 201);
  }

  // GET /api/revenue
  if (path === '/api/revenue' && request.method === 'GET') {
    return ok((await env.KV.get('revenue', 'json')) ?? []);
  }

  // POST /api/revenue — prepend, keep last 500, accumulate totalRevenue
  if (path === '/api/revenue' && request.method === 'POST') {
    const entry = { ...((await request.json()) as Record<string, unknown>), time: new Date().toISOString() };
    const revenue = ((await env.KV.get('revenue', 'json')) as unknown[]) ?? [];
    const next = [entry, ...revenue].slice(0, 500);
    await env.KV.put('revenue', JSON.stringify(next));
    const m = ((await env.KV.get('metrics', 'json')) as Record<string, unknown>) ?? {};
    const amount = (entry.amount as number) ?? 0;
    await env.KV.put(
      'metrics',
      JSON.stringify({
        ...m,
        totalRevenue: ((m.totalRevenue as number) ?? 0) + amount,
        lastUpdated: new Date().toISOString(),
      }),
    );
    return ok(entry, 201);
  }

  // Generic KV CRUD — /api/kv/:key
  const kvMatch = path.match(/^\/api\/kv\/(.+)$/);
  if (kvMatch) {
    const key = kvMatch[1];
    if (request.method === 'GET') {
      const value = await env.KV.get(key);
      return value !== null ? ok({ key, value }) : err('Not found', 404);
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      const body = (await request.json()) as { value: string; ttl?: number };
      if (body.value === undefined) return err('value required');
      await env.KV.put(key, String(body.value), body.ttl ? { expirationTtl: body.ttl } : undefined);
      return ok({ key, value: body.value });
    }
    if (request.method === 'DELETE') {
      await env.KV.delete(key);
      return ok({ deleted: key });
    }
  }

  // List all KV keys — GET /api/kv
  if (path === '/api/kv' && request.method === 'GET') {
    return ok(await env.KV.list());
  }

  return err('Not found', 404);
}
