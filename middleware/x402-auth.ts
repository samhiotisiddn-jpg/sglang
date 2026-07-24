interface X402Env {
  X402_HMAC_SECRET: string;
  X402_CHALLENGE_URL: string;
  X402_PRICE_USD: string;
}

interface PaymentProofClaims {
  sub: string;
  exp: number;
  scope: string;
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

async function verifyProof(token: string, secret: string): Promise<PaymentProofClaims | null> {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return null;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${headerB64}.${payloadB64}`),
  );

  if (!valid) {
    return null;
  }

  const payload = JSON.parse(decodeBase64Url(payloadB64)) as PaymentProofClaims;
  if (Date.now() / 1000 >= payload.exp) {
    return null;
  }

  return payload;
}

export async function requireX402Payment(request: Request, env: X402Env): Promise<Response | null> {
  const authHeader = request.headers.get("x-payment-proof") ?? request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return new Response("Payment Required", {
      status: 402,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": `x402 realm=\"fractalmesh\", challenge_url=\"${env.X402_CHALLENGE_URL}\", amount_usd=\"${env.X402_PRICE_USD}\"`,
      },
    });
  }

  const claims = await verifyProof(token, env.X402_HMAC_SECRET);
  if (!claims) {
    return new Response("Invalid payment proof", { status: 402 });
  }

  return null;
}
