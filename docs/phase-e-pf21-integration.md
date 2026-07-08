# API Integration Layer — PF-21 (Phase E)

## Standardized API wrapper combining PF-13, PF-14, PF-15, PF-5

**Cycle:** 21 · **Tests:** 12/12 · **Date:** 2026-07-07

### Purpose
- Single wrapper for all engines
- Standardized: auth + session + feature gate + idempotency + audit + logging
- Engines don't need to re-implement protection logic

### Usage
```js
const { APIIntegrationLayer } = require('./api-integration.js');
const layer = new APIIntegrationLayer({ sessionGuard, auditEngine, memberService });

app.post('/api/wallet/credit', async (req, res) => {
  const result = await layer.protectedHandler({
    token: req.headers.authorization,
    session_id: req.cookies.session_id,
    ip_address: req.ip,
    device_id: req.headers['x-device-id'],
    idempotency_key: req.headers['x-idempotency-key'],
    requiredClaims: ['sub'],
    requiredFeature: 'lotto_weekly',
    engine: walletEngine,
    method: 'credit',
    args: [req.body],
  });
  res.status(result.status).json(result.body);
});
```

### Closes Integration Gap
PF-14 built SessionGuard but didn't apply to engines. This PF-21 makes the middleware **adoptable** without per-engine refactor.
