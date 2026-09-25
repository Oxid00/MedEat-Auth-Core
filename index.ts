/**
 * supabase/functions/send-sms-otp/index.ts
 *
 * Edge Function: send-sms-otp
 *
 * Dispatches a one-time passcode via SMS (MSG91) to a verified phone number
 * after passing three independent rate-limiting layers.
 *
 * ─── Threat Model ─────────────────────────────────────────────────────────────
 *
 * THREAT: SMS Toll Fraud (pumping attacks / enumeration)
 *   An attacker sends thousands of OTP requests via different IPs/numbers
 *   to rack up SMS costs or probe valid phone numbers.
 *
 * MITIGATIONS:
 *   Layer 1 — IP Rate Limit:       5  requests / 5 min  per originating IP
 *   Layer 2 — Device Fingerprint:  10 requests / 1 hr   per device UUID
 *   Layer 3 — Phone Rate Limit:    3  requests / 24 hr  per phone number
 *
 *   All three layers MUST pass before MSG91 is called.
 *   Rate limit counters are stored in the `rate_limits` Postgres table via
 *   the `increment_rate_limit` RPC (server-side, not bypassable by client).
 *
 *   OTP plaintext is NEVER stored. Only its SHA-256 hash is persisted in
 *   `otp_sessions`. MSG91 receives the raw OTP for DLT-compliant delivery.
 *
 * ─── Required Deno env variables ─────────────────────────────────────────────
 *   SUPABASE_URL              — your Supabase project REST URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role JWT (bypasses RLS)
 *   MSG91_AUTHKEY             — MSG91 authentication key
 *   MSG91_OTP_TEMPLATE_ID     — MSG91 DLT-approved OTP template ID
 *
 * ─── Response codes ───────────────────────────────────────────────────────────
 *   200  — OTP dispatched successfully
 *   400  — Invalid or missing phone number
 *   429  — Rate limit exceeded (includes Retry-After header)
 *   500  — SMS gateway error (details NOT exposed to client)
 */

// @ts-nocheck — Deno global types
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Supabase client (service role — bypasses RLS for rate limit writes) ──────
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// ─── MSG91 credentials from env ───────────────────────────────────────────────
const MSG91_AUTHKEY     = Deno.env.get('MSG91_AUTHKEY')!;
const MSG91_TEMPLATE_ID = Deno.env.get('MSG91_OTP_TEMPLATE_ID') ?? '';

// ─── Constants ────────────────────────────────────────────────────────────────
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ─── CORS headers (applied to all responses) ─────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-device-fingerprint',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the true originating IP from the request, handling reverse proxies
 * that inject `X-Forwarded-For` (Supabase Edge uses this pattern).
 */
function getClientIP(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '0.0.0.0'
  );
}

/**
 * Increments the rate-limit counter for `key` and returns true if the caller
 * has exceeded `maxRequests` within the `ttlSeconds` window.
 *
 * Uses the `increment_rate_limit(p_key, p_ttl_seconds, p_max_requests)` RPC
 * which atomically increments and checks the counter server-side.
 *
 * Fail-open: if the RPC itself errors (e.g., DB unavailable), the request is
 * allowed through to avoid blocking legitimate users during infrastructure issues.
 *
 * @param key         Unique rate-limit key (e.g., 'sms:ip:1.2.3.4')
 * @param ttlSeconds  Window duration in seconds
 * @param maxRequests Maximum allowed requests within the window
 * @returns           true if the request should be blocked (rate limit exceeded)
 */
async function isRateLimited(
  key: string,
  ttlSeconds: number,
  maxRequests: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('increment_rate_limit', {
    p_key: key,
    p_ttl_seconds: ttlSeconds,
    p_max_requests: maxRequests,
  });

  if (error) {
    // Fail-open: allow the request through so legitimate users are never blocked
    // by an infrastructure issue. Log the error for monitoring.
    console.error('[send-sms-otp] Rate limit RPC error (fail-open):', error.message);
    return false;
  }

  // The RPC returns false when the counter exceeds the limit
  return data === false;
}

/**
 * Computes the SHA-256 hex digest of `input`.
 * Used to store OTP hashes — the plaintext OTP is never persisted.
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Returns a JSON response with the given body and status.
 * All responses include CORS headers.
 */
function jsonResponse(body: object, status: number, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  // ── Parse and validate request body ─────────────────────────────────────
  let body: { phone?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body — expected JSON.' }, 400);
  }

  const { phone } = body;
  if (!phone || !/^\+?[0-9]{10,13}$/.test(phone.replace(/[\s-]/g, ''))) {
    return jsonResponse(
      { error: 'Invalid phone number. Expected 10–13 digits in E.164 format.' },
      400,
    );
  }

  // Normalise to E.164 (e.g., "+919876543210")
  const normalisedPhone = phone.startsWith('+') ? phone : `+91${phone}`;

  // Extract identifiers for rate limiting
  const ip              = getClientIP(req);
  const deviceFP        = req.headers.get('x-device-fingerprint') || `no_fp:${ip}`;

  // ── LAYER 1: IP Rate Limit — 5 requests per 5 minutes ────────────────────
  if (await isRateLimited(`sms:ip:${ip}`, 300, 5)) {
    return jsonResponse(
      { error: 'Too many requests from this network. Please try again in a few minutes.' },
      429,
      { 'Retry-After': '300' },
    );
  }

  // ── LAYER 2: Device Fingerprint — 10 requests per hour ───────────────────
  if (await isRateLimited(`sms:device:${deviceFP}`, 3600, 10)) {
    return jsonResponse(
      { error: 'Too many OTP requests from this device. Please try again later.' },
      429,
      { 'Retry-After': '3600' },
    );
  }

  // ── LAYER 3: Phone Number — 3 requests per 24 hours ─────────────────────
  if (await isRateLimited(`sms:phone:${normalisedPhone}`, 86400, 3)) {
    return jsonResponse(
      { error: 'Maximum daily OTP attempts reached for this number. Try again tomorrow.' },
      429,
      { 'Retry-After': '86400' },
    );
  }

  // ── All layers passed — generate OTP and record the session ─────────────
  const otpRaw  = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await sha256Hex(otpRaw);

  const { error: upsertError } = await supabase
    .from('otp_sessions')
    .upsert(
      {
        phone: normalisedPhone,
        otp_hash: otpHash,                                              // Only the hash is stored
        sms_sent_at: new Date().toISOString(),
        fallback_channel: null,
        expires_at: new Date(Date.now() + OTP_EXPIRY_MS).toISOString(), // 10-minute TTL
        delivered_at: null,
      },
      { onConflict: 'phone' },
    );

  if (upsertError) {
    console.error('[send-sms-otp] Failed to record OTP session:', upsertError.message);
    // Continue — we still attempt SMS delivery even if session recording fails
  }

  // ── Dispatch via MSG91 ───────────────────────────────────────────────────
  try {
    const msg91Response = await fetch('https://api.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: MSG91_AUTHKEY,
      },
      body: JSON.stringify({
        mobile: normalisedPhone,
        otp: otpRaw,           // Raw OTP sent to MSG91 for DLT-compliant template rendering
        otp_length: 6,
        template_id: MSG91_TEMPLATE_ID,
      }),
    });

    if (!msg91Response.ok) {
      // Log the MSG91 error server-side but NEVER expose gateway details to client
      const errText = await msg91Response.text().catch(() => '[unreadable]');
      console.error(
        `[send-sms-otp] MSG91 error — status: ${msg91Response.status}, body: ${errText}`,
      );
      return jsonResponse(
        { error: 'Failed to send OTP. Please try again shortly.' },
        500,
      );
    }
  } catch (networkErr) {
    console.error('[send-sms-otp] MSG91 network error:', networkErr);
    return jsonResponse(
      { error: 'Network error communicating with SMS gateway. Please try again.' },
      500,
    );
  }

  return jsonResponse({ success: true, message: 'OTP sent successfully.' }, 200);
});

