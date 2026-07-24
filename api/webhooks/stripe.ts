interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

interface Env {
  STRIPE_WEBHOOK_SIGNING_SECRET: string;
  STRIPE_EVENT_KV: KVNamespace;
  STRIPE_EVENTS_QUEUE?: { send: (body: unknown) => Promise<void> };
  STRIPE_RECONCILE_ENDPOINT: string;
  STRIPE_RECONCILE_TOKEN: string;
}

const STRIPE_TOLERANCE_SECONDS = 300;

function parseSignatureHeader(headerValue: string): { timestamp: number; signatures: string[] } {
  const values = headerValue.split(",").map((item) => item.trim());
  const timestampValue = values.find((item) => item.startsWith("t="));
  const signatures = values
    .filter((item) => item.startsWith("v1="))
    .map((item) => item.slice(3));

  if (!timestampValue || signatures.length === 0) {
    throw new Error("Invalid Stripe signature header");
  }

  return {
    timestamp: Number(timestampValue.slice(2)),
    signatures,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  signingSecret: string,
): Promise<void> {
  const parsed = parseSignatureHeader(signatureHeader);
  const age = Math.floor(Date.now() / 1000) - parsed.timestamp;
  if (Math.abs(age) > STRIPE_TOLERANCE_SECONDS) {
    throw new Error("Stripe signature timestamp outside tolerance window");
  }

  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const computed = await hmacSha256(signingSecret, signedPayload);
  const matched = parsed.signatures.some((provided) => constantTimeEqual(provided, computed));

  if (!matched) {
    throw new Error("Stripe signature verification failed");
  }
}

async function reconcile(event: StripeEvent, env: Env): Promise<void> {
  const response = await fetch(env.STRIPE_RECONCILE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.STRIPE_RECONCILE_TOKEN}`,
    },
    body: JSON.stringify({ eventId: event.id, eventType: event.type, payload: event }),
  });

  if (!response.ok) {
    throw new Error(`Reconciliation failed with ${response.status}`);
  }
}

export async function onRequestPost(ctx: { request: Request; env: Env; waitUntil: (p: Promise<unknown>) => void }) {
  const { request, env, waitUntil } = ctx;
  const signatureHeader = request.headers.get("stripe-signature");

  if (!signatureHeader) {
    return new Response("Missing Stripe signature", { status: 400 });
  }

  const rawBody = await request.text();

  try {
    await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SIGNING_SECRET);
  } catch (error) {
    return new Response(`Signature verification failed: ${(error as Error).message}`, { status: 400 });
  }

  const event = JSON.parse(rawBody) as StripeEvent;
  const dedupeKey = `stripe:event:${event.id}`;
  const seen = await env.STRIPE_EVENT_KV.get(dedupeKey);

  if (seen) {
    return Response.json({ ok: true, deduped: true });
  }

  await env.STRIPE_EVENT_KV.put(dedupeKey, "1", { expirationTtl: 60 * 60 * 24 * 7 });

  const queuePromise = env.STRIPE_EVENTS_QUEUE?.send({
    eventId: event.id,
    eventType: event.type,
    createdAt: Date.now(),
  });
  if (queuePromise) {
    waitUntil(queuePromise);
  }

  waitUntil(reconcile(event, env));

  return Response.json({ ok: true, deduped: false });
}
