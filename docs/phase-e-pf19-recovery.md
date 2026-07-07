# Recovery Engine — PF-19 (Phase E)

## Account recovery: phone OTP, email link, security questions, lockout

**Cycle:** 19 · **Tests:** 20/20 · **Date:** 2026-07-07

### Features
- OTP via phone (SMS) or email
- Email magic link (30min expiry)
- Security questions (min 2)
- Lockout after 5 failed attempts (15min)
- Single-use recovery tokens
- Session invalidation on password reset
