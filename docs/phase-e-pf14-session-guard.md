# Phase E — PF-14: Session Guard & Idempotency Middleware

**Date:** 2026-07-07 · **Author:** AliClaw · **Status:** ✅ Implemented · **Cycle:** #14 of likepoint-2.0

## 🎯 Objective

Apply **PF-13 bug-fixes** (`Logger`, `IdempotencyLock`, `TokenValidator`, `validateAmount`, `redactSensitive`) as **production middleware layer** for all API endpoints — closing the gap between utility classes and actual endpoint protection

## 🏗️ Architecture

```
Request
  ↓
[① requireAuth] ─── validate JWT (exp, claims, nbf)
  ↓
[② validateSession] ─ timeout, IP, device
  ↓
[③ requireFeature] ─ subscription gate
  ↓
[④ withIdempotency] ─ prevent duplicate
  ↓
Handler
```

## 📦 Deliverables (5 ไฟล์, ~1,500+ insertions)

| # | ไฟล์ | Size | Purpose |
|---|---|---|---|
| 1 | `apps/engine/session-guard.js` | 9.5 KB | SessionGuard: 8 methods (withIdempotency/requireAuth/requireFeature/validateSession + 4 session mgmt) |
| 2 | `apps/engine/session-guard.test.js` | 10.8 KB | **28/28 tests pass** · 100% coverage |
| 3 | `apps/admin-console/pages/session-debug.html` | 12.0 KB | Visual flow simulator (token/session/idem/feature) |
| 4 | `sql/migrations/2026-07-07-phase-e-pf14-session-guard.sql` | 4.0 KB | 2 tables (request_idempotency + sessions) + 1 view + 1 function |
| 5 | `docs/phase-e-pf14-session-guard.md` | (this file) | Spec + flow + how to integrate |

## 🔌 API Design

### `withIdempotency({ key, ttlSeconds?, onHit?, onMiss })`

Middleware: prevent duplicate execution of the same operation within TTL window.

**Returns:** `{ hit: true|false, result }`

**Behavior:**
- Per-key mutex (serializes parallel requests)
- TTL expiration (default 5 minutes)
- Custom `onHit`/`onMiss` callbacks

### `requireAuth({ token, requiredClaims?, clockSkewSeconds? })`

Middleware: validate JWT-like token before handler.

**Returns:** `{ ok: true, claims }` or `{ ok: false, status, reason }`

**Checks:** `exp` (expiry), `nbf` (not-before), required claims, 30s clock skew

### `requireFeature({ member, feature?, minTier? })`

Middleware: gate handler by subscription feature or tier.

**Tier ordering:** `free (0) < pro (2) < enterprise (3)`

**Returns:** `{ ok: true }` or `{ ok: false, status: 403, reason }`

### `validateSession({ session_id, current_ip?, current_device_id?, maxAgeSeconds?, requireSameIp?, requireSameDevice? })`

Middleware: timeout + IP/device check.

**Returns:** `{ ok: true, session }` or `{ ok: false, status, reason }`

**Checks:**
- Session exists
- Age ≤ maxAgeSeconds (default 1h)
- IP matches (if requireSameIp + session.ip)
- Device matches (if requireSameDevice + session.device_id)

### `withGuard({ token, session_id, ip_address, device_id, idempotency_key?, requiredClaims?, requiredFeature?, minTier?, maxAgeSeconds?, handler })`

**Combined middleware** — runs all 4 checks in order, then calls handler.

**Returns:** `{ ok, status, body }` (or appropriate error)

### Session management
- `createSession({ member_id, ip_address?, device_id?, metadata? })`
- `touchSession({ session_id })`
- `destroySession({ session_id, reason? })`
- `getStats()` → `{ active_sessions, active_idempotency_keys }`

## 🛡️ Key Design Decisions

### 1. **4 separate middlewares + 1 combined `withGuard()`**
- Each can be used standalone (compose as needed)
- `withGuard()` runs all 4 in order for convenience
- Easy to add/remove specific check (e.g., feature gate optional)

### 2. **Session metadata = feature/tier storage**
- Don't query DB every time for member tier
- Pass tier+features in session.metadata (updated on tier change)
- Fast validation, no DB hit

### 3. **Idempotency TTL = 5 minutes (configurable)**
- Short enough to not block retries
- Long enough for client to safely retry
- Auto-expire via `setTimeout(...).unref?.()`

### 4. **Reuse PF-13 utilities**
- `Logger` (not console.log)
- `IdempotencyLock` (not inline Map)
- `TokenValidator` (not inline `if (token.exp)`)
- `redactSensitive` (not manual redaction)

### 5. **DB-backed idempotency + session (production-ready)**
- `request_idempotency` table persists across restarts
- `sessions` table enables multi-instance deployment
- `v_active_sessions` view for admin dashboard

### 6. **Audit all session events via PF-5**
- `SESSION_CREATED`, `SESSION_DESTROYED` events
- Compliance: trace any user's session history

## 🧪 Tests (28/28 passing)

```
✅ withIdempotency (5)
  T01: requires key
  T02: miss → executes handler
  T03: hit → returns existing
  T04: custom onHit callback
  T05: serializes parallel same-key

✅ requireAuth (5)
  T06: rejects no token
  T07: rejects invalid token
  T08: accepts valid token
  T09: rejects missing claim
  T10: rejects expired token

✅ requireFeature (5)
  T11: rejects no member
  T12: accepts when feature present
  T13: rejects missing feature
  T14: enforces minTier (pro)
  T15: tier ordering (free < pro < enterprise)

✅ validateSession (5)
  T16: rejects no session_id
  T17: rejects unknown session
  T18: accepts valid session
  T19: rejects IP mismatch
  T20: rejects device mismatch

✅ Session mgmt (3)
  T21: createSession returns session with id
  T22: destroySession removes session
  T23: touchSession updates last_seen_at

✅ withGuard (5)
  T24: runs handler when all checks pass
  T25: with idempotency_key returns cached result
  T26: rejects when feature missing
  T27: rejects when tier too low
  T28: getStats counts sessions and idempotency keys
```

## 🗄️ Database Schema

### `request_idempotency`
- `key TEXT UNIQUE` (request idempotency key)
- `endpoint TEXT`, `method TEXT`
- `member_id UUID`, `request_hash TEXT`
- `result JSONB`, `status_code INT`
- `created_at`, `expires_at`
- **Auto-expire** via cron or app-level cleanup

### `sessions`
- `session_id TEXT UNIQUE` (SES-{ts}-{seq})
- `member_id UUID`, `ip_address INET`, `device_id TEXT`
- `metadata JSONB` (tier, features, etc.)
- `created_at`, `last_seen_at`, `expires_at`
- `destroyed_at`, `destroy_reason`

### View: `v_active_sessions`
- Active sessions (not destroyed, not expired)
- `minutes_until_expiry`

### Function: `get_session_stats()`
- Single-call: active/expired/total sessions + unique members

## 🆚 vs Similar Concepts

| | This PF-14 | LikePoint v2.1 |
|---|---|---|
| **Auth** | TokenValidator (JWT) | AppApi + x-api-key |
| **Session** | SessionGuard (IP+device) | manual reset |
| **Idempotency** | Per-key mutex + DB store | Server-side keys only |
| **Feature gate** | Subscription tier check | (none — manual) |
| **Audit** | PF-5 integration | (limited) |

## 🚀 How to Integrate

```js
const { SessionGuard } = require('./session-guard.js');
const guard = new SessionGuard({ /* deps */ });

// In API handler
app.post('/api/wallet/credit', async (req, res) => {
  const result = await guard.withGuard({
    token: req.headers.authorization?.replace('Bearer ', ''),
    session_id: req.cookies.session_id,
    ip_address: req.ip,
    device_id: req.headers['x-device-id'],
    idempotency_key: req.headers['x-idempotency-key'],
    requiredClaims: ['sub'],
    requiredFeature: 'lotto_weekly',
    handler: async ({ claims, session }) => {
      // ... actual business logic
      return { success: true, member_id: claims.sub };
    },
  });
  res.status(result.status || 200).json(result.body);
});
```

## 🚀 Production Rollout (4 weeks)

### Week 1: Staging + integration
1. Apply migration on staging
2. Integrate SessionGuard into 3 critical endpoints (credit/redeem/lotto)
3. Test: missing token, expired token, IP mismatch, idempotency hit/miss
4. Run all 28 tests + 372 regression tests

### Week 2: Apply to all endpoints
1. Add SessionGuard to all 25+ engines
2. Migrate inline `idempotency_key` checks → `withIdempotency()`
3. Add token validation to API middleware

### Week 3: Load test
1. 1,000 concurrent requests (test idempotency serialization)
2. 100,000 sessions (test memory + DB)
3. Verify clock skew handling (mock time)

### Week 4: Production deploy
1. Deploy all engines with SessionGuard
2. Monitor: 401/403 rate, idempotency hit rate
3. Alert: idempotency cache eviction > X/min

## ⚠️ Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Session hijack via stolen cookie | Account compromise | IP + device check (configurable) |
| Idempotency cache DoS | Memory growth | TTL + auto-expire + size limit |
| Clock skew across instances | Token exp off-by-seconds | 30s tolerance + NTP sync |
| Session table grows forever | DB bloat | Auto-cleanup of expired (>7 days) |
| Feature gate bypass (metadata outdated) | User gets feature after sub cancel | Sync metadata on sub change event |
| Audit overhead | Performance | Async audit (don't await in hot path) |

## 📊 Success Metrics

- **M-1: Unauthorized requests blocked** = 401 count (target: >50/day = working)
- **M-2: Idempotency hit rate** = hits / total (target: >5% = real value)
- **M-3: Session timeout compliance** = expired sessions cleaned / day
- **M-4: Feature gate denials** = 403 count (target: <100/day)
- **M-5: p99 middleware latency** = <5ms added per request

## 🔗 Related PFs

- **PF-5 (AuditEngine):** session events audited
- **PF-13 (Bug Fixes):** SessionGuard uses Logger/IdempotencyLock/TokenValidator
- **PF-1 (AAM Migration):** already has claim_id idempotency, add SessionGuard
- **PF-9 (Subscription):** feature gate uses tier from session.metadata
- **PF-6 (Merchant):** merchant endpoints use SessionGuard too

## 🎬 Demo

**Console:** `https://likepoint-2.0.pages.dev/apps/admin-console/pages/session-debug.html`

**Try:**
1. Click "Gen Token" → token filled
2. Click "Create Session" → session ID filled (tier=pro, features=[lotto_weekly, lotto_daily])
3. Click "Send Request" → ✅ 200 OK (all 4 checks pass)
4. Click "Send Request" again with same idem key → cached result
5. Set Required Feature to `lotto_weekly` → ✅ pass (pro has it)
6. Try without session → ❌ 401
7. Try with expired token → ❌ 401 EXPIRED

---

**Cycle 14 Complete.** 🎉 14 cycles · 400 tests · ~25,150 insertions · 100% deploy success.
