# MedEat — Authentication Flow: Technical Documentation & Architectural Overview

> **Classification:** Internal Engineering Reference  
> **Scope:** Authentication, Identity Management & OTP Verification  
> **Stack:** React Native (TypeScript) · Supabase Auth · MSG91 (SMS/WhatsApp/Voice) · Deno Edge Functions · Zustand

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Identity & Session Model](#2-identity--session-model)
3. [Auth Entry Points & Navigation Gate](#3-auth-entry-points--navigation-gate)
4. [Login Screen — Credential Collection Layer](#4-login-screen--credential-collection-layer)
5. [Phone-First Login Flow](#5-phone-first-login-flow)
6. [Email OTP Login Flow](#6-email-otp-login-flow)
7. [Google OAuth Flow](#7-google-oauth-flow)
8. [Apple OAuth Flow](#8-apple-oauth-flow)
9. [OTP Verification Layer](#9-otp-verification-layer)
10. [SMS Anti-Fraud: Edge Function `send-sms-otp`](#10-sms-anti-fraud-edge-function-send-sms-otp)
11. [Telecom Fallback Loop: Edge Function `otp-fallback-monitor`](#11-telecom-fallback-loop-edge-function-otp-fallback-monitor)
12. [In-Memory OTP State Bridge](#12-in-memory-otp-state-bridge)
13. [Auth Lookup Service — Multi-Layer Phone→Email Resolution](#13-auth-lookup-service--multi-layer-phoneemail-resolution)
14. [Client-Side Session Storage (Zustand + AsyncStorage)](#14-client-side-session-storage-zustand--asyncstorage)
15. [Post-Verification Profile Resolution](#15-post-verification-profile-resolution)
16. [New User Registration Path](#16-new-user-registration-path)
17. [Logout](#17-logout)
18. [Security Controls Summary](#18-security-controls-summary)
19. [Known Dev-Only Bypasses](#19-known-dev-only-bypasses)
20. [Data Flow Diagrams](#20-data-flow-diagrams)

---

## 1. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          React Native Client                           │
│                                                                        │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────────┐  │
│  │ LoginScreen │   │  OTPScreen   │   │ AuthContext / AuthStore    │  │
│  │  (Credential│──▶│ (Verification│──▶│ (Zustand + AsyncStorage)  │  │
│  │  Collection)│   │  + Fallback) │   │  User | isAuthenticated   │  │
│  └─────────────┘   └──────────────┘   └───────────────────────────┘  │
│         │                  │                        │                  │
│         ▼                  ▼                        ▼                  │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │              Supabase JS Client (@supabase/supabase-js)          │ │
│  │   auth.signInWithOtp()  │  auth.verifyOtp()  │  auth.getSession()│ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
                          │                  │
          ┌───────────────┘                  └──────────────────┐
          ▼                                                     ▼
┌──────────────────────┐                        ┌──────────────────────────┐
│   Supabase Auth      │                        │  Deno Edge Functions     │
│   (Email OTP)        │                        │  ┌─────────────────────┐ │
│                      │                        │  │  send-sms-otp       │ │
│  • JWT issuance      │                        │  │  (3-layer rate-limit│ │
│  • Session mgmt      │                        │  │   + MSG91 dispatch) │ │
│  • OTP generation    │                        │  └─────────────────────┘ │
│  • RLS enforcement   │                        │  ┌─────────────────────┐ │
└──────────────────────┘                        │  │ otp-fallback-monitor│ │
                                                │  │ (SMS → WA → Voice)  │ │
                                                │  └─────────────────────┘ │
                                                └──────────────────────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────────┐
                                                │     MSG91 Gateway    │
                                                │  SMS / WhatsApp /    │
                                                │  Voice OTP Delivery  │
                                                └──────────────────────┘
```

**Key design principles:**
- **Supabase Auth is the single source of truth** for identity (JWT, session, OTP issuance for email).
- **MSG91** handles SMS/WhatsApp/Voice OTP delivery for phone-number-based flows; Supabase handles email OTP delivery natively.
- **All OTP verification is server-validated** via `supabase.auth.verifyOtp()` — no client-side OTP comparison occurs.
- **Rate limiting** is enforced at the Edge Function layer before any SMS gateway call.
- **Plaintext OTPs are never persisted**; only SHA-256 hashes are written to the `otp_sessions` table.

---

## 2. Identity & Session Model

### `User` interface ([`authStore.ts`](file:///c:/Projects/medeat.app/MedEat/src/store/authStore.ts))

```typescript
interface User {
  id: string;              // Supabase UUID (auth.users.id)
  name: string;
  phone: string;
  email?: string;
  age?: string;
  pincode?: string;
  address?: string;
  latitude?: string;
  longitude?: string;
  notificationsEnabled?: boolean;
  privacyOrderDefault?: boolean;
  preferredLanguage?: string;
  phoneVerified?: boolean;   // Set after phone OTP verified
  emailVerified?: boolean;   // Set after email OTP or Google/Apple OAuth
}
```

### Session persistence

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| Supabase session | `AsyncStorage` (via `supabase-js` `storage` option) | Cross-app-restart |
| App user state | Zustand `persist` middleware → `AsyncStorage` (key: `auth-storage`) | Cross-app-restart |
| OTP pending email | `supabaseOtpBridge` (in-memory module variable) | Current JS runtime only |

`autoRefreshToken: true` and `persistSession: true` are configured on the Supabase client, ensuring JWTs are silently refreshed and sessions survive app restarts without re-authentication.

---

## 3. Auth Entry Points & Navigation Gate

**File:** [`AppNavigator.tsx`](file:///c:/Projects/medeat.app/MedEat/src/navigation/AppNavigator.tsx)

The navigator resolves the initial route on cold-start using a three-condition guard:

```
user present in store?
  └─ YES → navigate to 'Main'
  └─ NO  →  hasOnboarded AND hasAcceptedConsent?
              └─ YES → navigate to 'Login'
              └─ NO  →  hasOnboarded?
                          └─ YES → navigate to 'Consent'
                          └─ NO  → navigate to 'Onboarding'
```

A dedicated **partner session check** (`isPartnerAuthenticated` from `partnerStore`) takes priority and routes directly to `PharmacyDashboard`, completely bypassing the customer auth flow.

**Auth-related routes in the stack:**

| Route | Component | Purpose |
|-------|-----------|---------|
| `Login` | `LoginScreen` | Credential collection (phone / email / social) |
| `OTP` | `OTPScreen` | 6-digit OTP entry & verification (phone or email) |
| `EmailOTP` | `EmailOTPScreen` | Dedicated email OTP screen (alternative entry) |
| `Register` / `CreateAccount` | `CreateAccountScreen` | New user profile creation |
| `CompleteProfile` | `CompleteProfileScreen` | Post-social-auth profile completion |
| `AddPhone` | `AddPhoneScreen` | Phone collection for social-auth users without phone |

---

## 4. Login Screen — Credential Collection Layer

**File:** [`LoginScreen.tsx`](file:///c:/Projects/medeat.app/MedEat/src/screens/Auth/LoginScreen.tsx)

The login screen presents two primary tabs — **Mobile OTP** and **Email OTP** — plus social sign-in buttons.

### Input validation

```
Phone tab:  phone.length === 10  AND  ageVerified === true
Email tab:  email.includes('@')  AND  email.includes('.')  AND  email.length > 5  AND  ageVerified === true
```

A **18+ age verification checkbox** is a hard prerequisite for OTP dispatch on both tabs.

### Email masking (privacy UX)

When a linked email is discovered from a phone number, the display address is masked using a deterministic pattern before it is shown to the user. This prevents full email address disclosure on the login screen.

```
Format: <first 2 chars>***<last char>@<domain>
Example: "jo***n@gmail.com"
```

---

## 5. Phone-First Login Flow

```
User enters 10-digit phone  →  taps "Find Account & Send OTP"
            │
            ▼
    findLinkedEmailByPhone()          ← 4-layer lookup (see §13)
            │
     ┌──────┴──────┐
     │ Found email  │                  │ No email found
     ▼              │                  ▼
Show dual-option card:                supabase.auth.signInWithOtp({ phone })
  ┌─────────────────┐                    │
  │ Option A:        │             ┌─────┴──────┐
  │ Send OTP to      │             │  SMS sent   │  │  SMS failed
  │ masked email     │             ▼             │  ▼
  │ (recommended)    │          Navigate        Show Alert with options:
  └─────────────────┘           to OTP screen    • "Use Email OTP"
  ┌─────────────────┐                            • "Create Account"
  │ Option B:        │
  │ Send OTP via SMS │
  └─────────────────┘
```

#### Option A — Send OTP to Linked Email

```typescript
await supabase.auth.signInWithOtp({
  email: cleanEmail,
  options: { shouldCreateUser: true },
});
supabaseOtpBridge.set(cleanEmail);   // Parks email for OTPScreen to read
navigation.navigate('OTP', { phone, linkedEmail: cleanEmail });
```

#### Option B — Send OTP via SMS

```typescript
await supabase.auth.signInWithOtp({ phone: fullPhone });
// On error: graceful fallback prompt to use email instead
navigation.navigate('OTP', { phone: fullPhone, linkedEmail });
```

> **Note:** Direct Supabase phone OTP (`signInWithOtp({ phone })`) is used as the SMS path here. The dedicated `send-sms-otp` Edge Function (with 3-layer rate limiting) is the alternative path invoked when fraud risk is elevated.

---

## 6. Email OTP Login Flow

**Triggered by:** user switching to the Email tab on `LoginScreen`, or selecting "Use Email OTP" from the phone-not-found alert.

```typescript
const { error } = await supabase.auth.signInWithOtp({
  email: cleanEmail,
  options: { shouldCreateUser: true },
});
supabaseOtpBridge.set(cleanEmail);
navigation.navigate('OTP', { phone: cleanEmail });
```

- Supabase generates and delivers the 6-digit OTP to the email address.
- `shouldCreateUser: true` allows first-time sign-ups without a separate registration API call for email users.
- The email is stored in `supabaseOtpBridge` so `OTPScreen` knows whether to call `verifyOtp` with `type: 'email'` or `type: 'sms'`.

---

## 7. Google OAuth Flow

**File:** [`LoginScreen.tsx`](file:///c:/Projects/medeat.app/MedEat/src/screens/Auth/LoginScreen.tsx#L208-L310)

```
GoogleSignin.hasPlayServices()
        │
        ▼
GoogleSignin.signOut()          ← Clears cached session to force account picker
        │
        ▼
GoogleSignin.signIn()           ← Native Google account picker
        │
        ▼
Extract idToken from userInfo
        │
        ▼
supabase.auth.signInWithIdToken({
  provider: 'google',
  token: idToken
})                              ← Supabase validates token with Google's JWKS
        │
        ▼
supabase.from('profiles').select('*').eq('id', sessionUser.id)
        │
   ┌────┴────────────────────┐
   │ Profile exists          │    │ No profile (new user)
   ▼                         │    ▼
   phone present?            │  navigate('CompleteProfile', {
   │ YES → login() → 'Main'  │    email, name, userId, authMethod: 'google'
   │ NO  → login() →         │  })
   │       'AddPhone'        │
   └─────────────────────────┘
```

**Security note:** The ID token is validated server-side by Supabase against Google's JWKS endpoint. The client never performs token validation.

---

## 8. Apple OAuth Flow

**File:** [`LoginScreen.tsx`](file:///c:/Projects/medeat.app/MedEat/src/screens/Auth/LoginScreen.tsx#L312-L368)

```
supabase.auth.signInWithOAuth({ provider: 'apple' })
        │
        ▼
supabase.auth.getSession()      ← Reads session after OAuth redirect
        │
        ▼
Profile lookup + login() / navigation to Register
```

> **Current implementation note:** The Apple flow uses `signInWithOAuth` (browser redirect), which in a React Native context may not resolve the session reliably without a deep link handler. The code includes a graceful fallback path for development environments. Production hardening (e.g., `@invertase/react-native-apple-authentication` with `signInWithIdToken`) is the recommended upgrade path.

---

## 9. OTP Verification Layer

**File:** [`OTPScreen.tsx`](file:///c:/Projects/medeat.app/MedEat/src/screens/Auth/OTPScreen.tsx)

### Verification target resolution

On mount, `OTPScreen` resolves the verification target using this priority chain:

```
1. supabaseOtpBridge.get()   ← In-memory pending email (most authoritative)
2. activeTarget              ← React state (may have been switched to email mid-flow)
3. route.params.phone        ← Navigation param (fallback)
```

### `verifyOtp` call

```typescript
await supabase.auth.verifyOtp(
  isEmail
    ? { email: verifyTarget, token: fullCode, type: 'email' }
    : { phone: verifyTarget, token: fullCode, type: 'sms'  }
);
```

The `type` discriminator is critical — it tells Supabase Auth which OTP table/flow to validate against.

### Session hydration wait

After `verifyOtp` succeeds, the code awaits `onAuthStateChange` to confirm the Supabase session is fully hydrated before calling `getSession()`:

```typescript
await new Promise<void>((resolve) => {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    if (session) { subscription.unsubscribe(); resolve(); }
  });
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) { subscription.unsubscribe(); resolve(); }
  });
});
```

This prevents a race condition where `getSession()` is called before the JWT is written to `AsyncStorage`.

### Resend OTP

The Resend button re-calls `supabase.auth.signInWithOtp()` using the same target that was last sent to, clears the 6 OTP input boxes, and refocuses the first input.

### Mid-flow email switch

From `OTPScreen`, the user can switch from SMS to email delivery at any point:

```
"Prefer Email? Send OTP to ma***l@gmail.com"  (quick chip)
  or
"OR GET CODE ON EMAIL" section  (expanded action card)
  │
  ▼
handleSendOtpToEmail(linkedEmail)
  │
  ├─ supabase.auth.signInWithOtp({ email: cleanEmail })
  ├─ supabaseOtpBridge.set(cleanEmail)   ← Updates bridge so next verify uses email
  └─ setActiveTarget(cleanEmail)          ← Updates display
```

If no linked email is found automatically, a custom email input box is rendered inline.

---

## 10. SMS Anti-Fraud: Edge Function `send-sms-otp`

**File:** [`supabase/functions/send-sms-otp/index.ts`](file:///c:/Projects/medeat.app/MedEat/supabase/functions/send-sms-otp/index.ts)

This Deno Edge Function guards every SMS OTP dispatch behind three independent rate-limiting layers backed by the `rate_limits` Postgres table via an `increment_rate_limit` RPC.

### Rate limit architecture

| Layer | Key | Window | Max Requests | Error |
|-------|-----|--------|--------------|-------|
| 1 — IP | `sms:ip:<ip>` | 5 min (300s) | 5 | 429 — `Retry-After: 300` |
| 2 — Device | `sms:device:<fingerprint>` | 1 hr (3600s) | 10 | 429 — `Retry-After: 3600` |
| 3 — Phone | `sms:phone:<e164>` | 24 hr (86400s) | 3 | 429 — `Retry-After: 86400` |

All three layers must pass before MSG91 is called.

### Device fingerprint

The client attaches the device UUID (from `react-native-device-info`) as a custom header:

```
x-device-fingerprint: <UUID>
```

The Edge Function reads `req.headers.get('x-device-fingerprint')`. If absent, it falls back to `no_fp:<ip>` — preserving layer 2 effectiveness even without the header.

### OTP hash storage

```typescript
const otpRaw = Math.floor(100000 + Math.random() * 900000).toString();
const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(otpRaw));
// → SHA-256 hex stored in otp_sessions.otp_hash
// → otpRaw forwarded to MSG91 for DLT-compliant delivery
```

**Plaintext OTPs are never persisted.** Only the SHA-256 hash is written to `otp_sessions`.

### Fail-open policy

If the `increment_rate_limit` RPC itself errors (e.g., DB connectivity issue), the request is allowed through to avoid blocking legitimate users. This is a conscious trade-off between availability and strictness.

---

## 11. Telecom Fallback Loop: Edge Function `otp-fallback-monitor`

**File:** [`supabase/functions/otp-fallback-monitor/index.ts`](file:///c:/Projects/medeat.app/MedEat/supabase/functions/otp-fallback-monitor/index.ts)

Invoked on a schedule (Supabase Realtime trigger or `pg_cron`, every ~15 seconds). It automatically escalates OTP delivery when SMS times out, without requiring user interaction.

### Fallback escalation chain

```
otp_sessions row:
  sms_sent_at < (now - 15s)   ← SMS sent but likely stuck
  delivered_at IS NULL         ← Never confirmed received
  fallback_channel IS NULL     ← No fallback triggered yet
  expires_at > now             ← OTP still within validity window
        │
        ▼
Attempt 1: MSG91 WhatsApp Cloud API
        │
   ┌────┴───────────────┐
   │ waResp.ok           │   │ Failed
   ▼                     │   ▼
Set fallbackChannel      │   Attempt 2: MSG91 Voice OTP API
= 'whatsapp'             │        │
                         │   ┌────┴─────────┐
                         │   │ voiceResp.ok  │  │ Both failed — log error
                         │   ▼              │
                         │  Set fallback    │
                         │  = 'voice'       │
                         └──────────────────┘
        │
        ▼
otp_sessions UPDATE:
  otp_hash         ← New SHA-256 hash (new OTP generated)
  fallback_channel ← 'whatsapp' | 'voice'
  fallback_sent_at ← timestamp
```

### Client-side Realtime subscription

```typescript
// OTPScreen.tsx — subscribeToOtpFallback()
supabase
  .channel(`otp_fallback:${phone}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'otp_sessions',
    filter: `phone=eq.${phone}`,
  }, (payload) => {
    if (payload.new?.fallback_channel) {
      setFallbackChannel(event.channel);   // Updates UI label
      setOtp(['', '', '', '', '', '']);    // Clears old code fields
      Alert.alert('OTP Sent via WhatsApp', ...);
    }
  })
  .subscribe();
```

The subscription is cleaned up via a returned unsubscribe function called on component unmount, preventing memory leaks.

---

## 12. In-Memory OTP State Bridge

**File:** [`src/lib/supabaseOtpBridge.ts`](file:///c:/Projects/medeat.app/MedEat/src/lib/supabaseOtpBridge.ts)

```typescript
let _pendingEmail: string | null = null;

export const supabaseOtpBridge = {
  set(email: string)       { _pendingEmail = email; },
  get(): string | null     { return _pendingEmail; },
  clear()                  { _pendingEmail = null; },
};
```

**Purpose:** React Navigation route params are unreliable for serializing state in all edge cases (deep links, back-stack pops, mid-flow email switches). This module acts as a lightweight, single-value in-memory registry that reliably communicates the *currently pending OTP email address* from any OTP-send site to `OTPScreen.verifyAndLogin()`.

**Lifecycle:**
- **Set:** Immediately after a successful `signInWithOtp({ email })` call.
- **Read:** At the start of `verifyAndLogin()` to determine the verification target.
- **Cleared:** Immediately after `verifyOtp()` returns (success or failure resolution).

**Security note:** The bridge is a module-level singleton. It does not survive app restarts (not persisted to disk), and holds no secrets — only the target email address.

---

## 13. Auth Lookup Service — Multi-Layer Phone→Email Resolution

**File:** [`src/services/authLookupService.ts`](file:///c:/Projects/medeat.app/MedEat/src/services/authLookupService.ts)

`findLinkedEmailByPhone(rawPhone)` resolves a user's registered email from their phone number using a 4-layer fallback chain:

```
Layer 1: Supabase RPC  get_linked_email_for_phone(lookup_phone)
         ↳ Server-side function, bypasses RLS securely
         ↳ On success: write to AsyncStorage cache → return email
         ↳ On RPC error / not installed: continue to Layer 2

Layer 2: Supabase profiles table query
         .from('profiles').select('email,phone').ilike('phone', `%${cleanPhone}%`).limit(1)
         ↳ On success: write to AsyncStorage cache → return email
         ↳ On error or empty: continue to Layer 3

Layer 3: AsyncStorage local device cache
         key: '@medeat_phone_email_<10-digit-phone>'
         ↳ On hit: return cached email
         ↳ On miss / error: continue to Layer 4

Layer 4: Zustand auth store (in-memory, current session user)
         ↳ Compares stored user.phone digits to lookup phone
         ↳ On match: write to AsyncStorage cache → return email
         ↳ On no match: return null
```

**Cache write** (`cacheLinkedEmail`) always uses the last 10 digits of the phone as the key, normalising for country codes.

---

## 14. Client-Side Session Storage (Zustand + AsyncStorage)

**File:** [`src/store/authStore.ts`](file:///c:/Projects/medeat.app/MedEat/src/store/authStore.ts)

The auth store is a Zustand store with `persist` middleware, using `AsyncStorage` as the backing store under the key `auth-storage`.

**Persisted fields:** `user`, `token`, `isAuthenticated`, `hasCompletedOnboarding`, `hasAcceptedConsent`

**Ephemeral fields (not persisted):** `isLoading`

### Initialization on cold-start

```typescript
onRehydrateStorage: () => (state) => {
  state?.initialize();   // Sets isLoading = false after hydration
}
```

`AppNavigator` reads `isLoading` and renders `<SplashScreen>` until it becomes `false`, ensuring no route flicker during session rehydration.

### `AuthContext`

[`AuthContext.tsx`](file:///c:/Projects/medeat.app/MedEat/src/context/AuthContext.tsx) wraps the Zustand store in a React Context, exposing `login`, `logout`, `updateUser`, `setHasOnboarded` as stable function references to the component tree. The `login` function is simply `setUser(userData)` — it does not make any network calls; it only writes the hydrated user object to the store after Supabase session validation has already succeeded.

---

## 15. Post-Verification Profile Resolution

After `verifyOtp()` succeeds and the Supabase session is hydrated, `OTPScreen` performs a **tri-key profile lookup** to find the existing user record:

```
1. SELECT * FROM profiles WHERE id = supabase_user_id
        │
   ┌────┴─────────────────────────────────────────────┐
   │ Found                                             │ Not found
   ▼                                                   │
   login(profile) → navigate('Main')                   │
                                                       ▼
   2. SELECT * FROM profiles WHERE email = verifyTarget | linkedEmail
                │
          ┌─────┴──────────────┐
          │ Found               │ Not found
          ▼                     │
          login(profile)        │
          navigate('Main')      ▼
                         3. SELECT * FROM profiles WHERE phone = '+91<digits>'
                                │
                          ┌─────┴──────────────┐
                          │ Found               │ Not found (new user)
                          ▼                     ▼
                          login(profile)        navigate('CompleteProfile', {
                          navigate('Main')        email, phone, userId,
                                                  authMethod: 'email'
                                                })
```

The `profiles` table stores the canonical identity record. The Supabase UUID links `auth.users` to `public.profiles`.

---

## 16. New User Registration Path

**File:** [`src/screens/Auth/CreateAccountScreen.tsx`](file:///c:/Projects/medeat.app/MedEat/src/screens/Auth/CreateAccountScreen.tsx)

Reached when profile lookup returns null after OTP verification, or when the user explicitly selects "Create Account."

Key auth actions during registration:
1. Phone OTP is sent via `supabase.auth.signInWithOtp({ phone })` and verified inline within the form.
2. Upon form submission, the profile is written to `public.profiles` with the Supabase user ID as the primary key.
3. `cacheLinkedEmail(phone, email)` is called to seed the local lookup cache.
4. `login(userData)` is called to write to the auth store.
5. Navigation proceeds to `'Main'`.

---

## 17. Logout

```typescript
// AuthContext
const logout = async () => { storeLogout(); };

// authStore
logout: () => set({ user: null, token: null, isAuthenticated: false })
```

Logout clears the Zustand store (and by extension `AsyncStorage` on next persist cycle). A full sign-out should also call `supabase.auth.signOut()` to invalidate the server-side session — this is a hardening recommendation.

---

## 18. Security Controls Summary

| Control | Where | Mechanism |
|---------|-------|-----------|
| OTP generation | Supabase Auth (email) / Edge Function (SMS) | Server-side; never client-generated |
| OTP storage | `otp_sessions` table | SHA-256 hash only — plaintext never stored |
| OTP validation | `supabase.auth.verifyOtp()` | Server-side validation |
| OTP expiry | 10 minutes | Enforced server-side by Supabase and `otp_sessions.expires_at` |
| SMS rate limiting — IP | `send-sms-otp` Edge Function | 5 req / 5 min |
| SMS rate limiting — Device | `send-sms-otp` Edge Function | 10 req / 1 hr (device fingerprint header) |
| SMS rate limiting — Phone | `send-sms-otp` Edge Function | 3 req / 24 hr |
| Email masking | `LoginScreen` / `OTPScreen` | Display-only obfuscation (`jo***n@gmail.com`) |
| Credential exposure | Environment variables | All secrets in Deno `env.get()` / React Native `ENV` config — never hardcoded |
| RLS enforcement | Supabase Row Level Security | Enforced on `profiles`, `otp_sessions`, `rate_limits` tables |
| Token validation (Google) | Supabase `signInWithIdToken` | JWKS-based server-side validation |
| Session persistence | `AsyncStorage` | Native encrypted device storage |
| Session refresh | Supabase JS client | `autoRefreshToken: true` — silent JWT rotation |
| Telecom fallback | `otp-fallback-monitor` Edge Function | Automatic SMS → WhatsApp → Voice escalation |
| Dev bypass isolation | `OTPScreen.verifyAndLogin()` | Hardcoded test phone number + OTP gated to specific device numbers — must be removed before production release |

---

## 19. Known Dev-Only Bypasses

> [!CAUTION]
> The following bypasses **MUST be removed or feature-flagged behind `__DEV__`** before production release. Shipping them exposes a complete authentication bypass for any user who discovers the test credentials.

| Bypass | Location | Detail |
|--------|----------|--------|
| Dev phone bypass | `LoginScreen.checkExistingUserAndSend()` | Specific phone numbers skip account lookup |
| Dev OTP bypass | `OTPScreen.verifyAndLogin()` | Specific phone + OTP code combinations skip `verifyOtp()` and load profile directly from DB |

---

## 20. Data Flow Diagrams

### 20.1 — Phone Login → Email OTP → Verification (Happy Path)

```
User                  LoginScreen          authLookupService       Supabase Auth      OTPScreen
 │                        │                      │                      │                  │
 │─ enters phone ────────▶│                      │                      │                  │
 │─ taps Send OTP ────────▶│                      │                      │                  │
 │                        │─ findLinkedEmail() ──▶│                      │                  │
 │                        │                      │─ RPC / profiles / ───▶│                  │
 │                        │                      │   cache / store       │                  │
 │                        │◀─ returns email ──────│                      │                  │
 │                        │                      │                      │                  │
 │◀─ shows dual option ───│                      │                      │                  │
 │─ taps "Email OTP" ─────▶│                      │                      │                  │
 │                        │─ signInWithOtp(email)─────────────────────▶│                  │
 │                        │                      │                 generates OTP            │
 │                        │                      │                 sends email OTP           │
 │                        │◀────────────── { error: null } ────────────│                  │
 │                        │─ supabaseOtpBridge.set(email)              │                  │
 │                        │─ navigate('OTP') ──────────────────────────────────────────▶│
 │                                                                      │                  │
 │─ enters 6-digit code ──────────────────────────────────────────────────────────────▶│
 │                                                                      │                  │
 │                                                                      │◀─ verifyOtp() ───│
 │                                                                      │   { email, token, type:'email' }
 │                                                                      │─ validates ─────▶│
 │                                                                      │◀── session JWT ──│
 │                                                                      │                  │
 │                                                                      │         profiles lookup
 │                                                                      │         login() → navigate('Main')
 │◀─────────────────────────────────────────── navigates to Main ───────────────────────│
```

### 20.2 — SMS OTP with Fallback Loop

```
User           OTPScreen         otpService            send-sms-otp EF       otp-fallback-monitor EF     MSG91
 │                │                   │                      │                        │                     │
 │─ req OTP ─────▶│                   │                      │                        │                     │
 │                │─ sendSmsOtp() ───▶│                      │                        │                     │
 │                │                   │─ POST /send-sms-otp─▶│                        │                     │
 │                │                   │                      │─ isRateLimited (3 layers)                    │
 │                │                   │                      │─ upsert otp_sessions ─▶│                     │
 │                │                   │                      │─ POST MSG91/sms ────────────────────────────▶│
 │                │                   │                      │◀────── { ok } ──────────────────────────────│
 │◀──────────────────────── { success: true } ───────────────│                        │                     │
 │                │                   │                      │                        │                     │
 │   [15s passes — SMS not delivered]  │                      │                        │                     │
 │                │                   │                      │        sms_sent_at < now-15s                 │
 │                │                   │                      │        delivered_at IS NULL                  │
 │                │                   │                      │◀── poll otp_sessions ──│                     │
 │                │                   │                      │                        │─ POST MSG91/whatsapp▶│
 │                │                   │                      │                        │◀── { ok } ──────────│
 │                │                   │                      │                        │─ UPDATE otp_sessions │
 │                │                   │                      │                        │  fallback_channel='whatsapp'
 │                │                   │                      │                        │                     │
 │                │◀─── Realtime 'postgres_changes' UPDATE ──────────────────────────│                     │
 │                │     fallback_channel = 'whatsapp'         │                        │                     │
 │◀─ Alert: "OTP sent via WhatsApp" ──│                       │                        │                     │
 │◀─ OTP boxes cleared ───────────────│                       │                        │                     │
 │─ enters new WA code ───────────────▶│                      │                        │                     │
 │                │─ verifyOtp({ phone, token, type:'sms' })──────────────────────────────────────────────▶│
```

---

*Document generated from source code analysis — September 2026.*  
*All architectural details are derived from the actual implementation. No credentials or secrets are contained in this document.*
