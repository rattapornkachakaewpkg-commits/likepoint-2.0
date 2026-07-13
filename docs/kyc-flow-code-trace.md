# KYC/Verify Flow — Code Trace (English, no interpretation)

> **Source files (read-only trace):**
> - `apps/engine/kyc-engine.js` (369 lines, 10 methods)
> - `apps/engine/identity-resolution.js` (186 lines)
> - `apps/engine/kyc.js` (87 lines, RFC-001 stub)
> - `apps/identity-service/server.js` (137 lines, 11 endpoints)
> - `apps/identity-service/member.js`

> **Method names, event names, file paths are taken verbatim from source code.**

---

## 1. KYCEngine.submitApplication() — `kyc-engine.js:32-78`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine
    participant Map as applications (Map)
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Assign as _assignReviewer()

    Caller->>KYC: submitApplication({ member_id, level=2, business_name?, business_license?, tax_id?, metadata?, actor='user' })

    alt member_id is null
        KYC-->>Caller: throw 'member_id is required'
    end
    alt level not in [2,3]
        KYC-->>Caller: throw 'This engine handles Level 2/3, got <level>'
    end

    KYC->>Map: find existing app where member_id==X AND level==Y AND status in [pending, in_review, more_info_required]
    alt existing found
        KYC-->>Caller: throw 'Application already exists: <application_id>'
    end

    KYC->>KYC: application_id = `KYC-${Date.now()}-${++_idSeq}`
    KYC->>KYC: sla_hours = (level==2 ? 48 : 72)
    KYC->>KYC: sla_deadline = now + sla_hours*3600*1000
    KYC->>Map: set(application_id, { status:'pending', assigned_reviewer_id:null, ... })

    KYC->>Bus: publish('kyc.application_submitted', { application_id, member_id, level, sla_deadline })
    KYC->>Audit: log({ event_type:'KYC_APPLICATION_SUBMITTED', actor, resource_type:'kyc_application', resource_id, member_id, action:'CREATE', metadata:{ level, business_name, sla_deadline } })

    KYC->>Assign: _assignReviewer(application_id)
    Assign-->>KYC: reviewer | null
    KYC-->>Caller: return application
```

---

## 2. KYCEngine.uploadDocument() — `kyc-engine.js:84-114`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine
    participant Apps as applications (Map)
    participant Docs as documents (Map)
    participant Audit as auditEngine

    Caller->>KYC: uploadDocument({ application_id, document_type, file_name, file_url, file_size_bytes?, mime_type?, actor='user' })

    alt any of [application_id, document_type, file_name, file_url] missing
        KYC-->>Caller: throw 'application_id, document_type, file_name, file_url are required'
    end

    KYC->>Apps: get(application_id)
    alt app not found
        KYC-->>Caller: throw 'Application not found: <application_id>'
    end
    alt app.status in [approved, rejected]
        KYC-->>Caller: throw 'Cannot upload to <status> application'
    end

    KYC->>KYC: document_id = `DOC-${Date.now()}-${++_idSeq}`
    KYC->>Docs: set(document_id, { document_type, file_name, file_url, file_size_bytes, mime_type, uploaded_at })

    KYC->>Audit: log({ event_type:'KYC_DOCUMENT_UPLOADED', actor, resource_type:'kyc_document', resource_id:document_id, member_id:app.member_id, action:'CREATE', metadata:{ application_id, document_type, file_name } })
    KYC-->>Caller: return document
```

---

## 3. KYCEngine._assignReviewer() — `kyc-engine.js:120-152`

```mermaid
sequenceDiagram
    autonumber
    participant KYC as KYCEngine
    participant Apps as applications (Map)
    participant Revs as reviewers (Map)
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Notif as notificationService

    KYC->>Apps: get(application_id)
    alt app not found
        KYC-->>KYC: return
    end

    KYC->>Revs: filter where r.status=='active' AND r.active==true → activeReviewers
    alt activeReviewers.length == 0
        KYC->>Apps: get(application_id).status = 'pending'
        KYC-->>KYC: return null
    end

    KYC->>KYC: reviewer = activeReviewers[_roundRobinIdx % activeReviewers.length]
    KYC->>KYC: _roundRobinIdx++
    KYC->>Apps: app.assigned_reviewer_id = reviewer.reviewer_id
    KYC->>Apps: app.status = 'in_review'

    KYC->>Bus: publish('kyc.application_assigned', { application_id, reviewer_id })
    KYC->>Audit: log({ event_type:'KYC_APPLICATION_ASSIGNED', actor:'system', resource_type:'kyc_application', resource_id, member_id, action:'UPDATE', metadata:{ reviewer_id } })

    KYC->>Notif: send({ template_id:'kyc-reviewer-assigned', recipient:{ member_id:reviewer_id, email }, variables:{ application_id, business_name: app.business_name || 'N/A' } })
    KYC-->>KYC: return reviewer
```

---

## 4. KYCEngine.approve() — `kyc-engine.js:158-200`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine
    participant Apps as applications (Map)
    participant Revs as reviews (Map)
    participant Mem as memberService
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Notif as notificationService

    Caller->>KYC: approve({ application_id, reviewer_id, notes?, actor='reviewer' })

    KYC->>Apps: get(application_id)
    alt app not found
        KYC-->>Caller: throw 'Application not found: <application_id>'
    end
    alt app.status != 'in_review'
        KYC-->>Caller: throw 'Application is <status>, can only approve in_review'
    end
    alt app.assigned_reviewer_id != reviewer_id
        KYC-->>Caller: throw 'Only assigned reviewer can approve'
    end

    KYC->>Apps: app.status='approved', reviewed_at, reviewed_by=reviewer_id, decision='approved', decision_reason=notes
    KYC->>KYC: newTier = (level==2 ? 'pro' : 'enterprise')
    KYC->>Mem: update(app.member_id, { tier:newTier, kyc_level:app.level })

    KYC->>KYC: review_id = `REV-${Date.now()}-${++_idSeq}`
    KYC->>Revs: set(review_id, { application_id, reviewer_id, decision:'approved', notes, reviewed_at })

    KYC->>Bus: publish('kyc.application_approved', { application_id, member_id, new_tier })
    KYC->>Audit: log({ event_type:'KYC_APPLICATION_APPROVED', actor, resource_type:'kyc_application', resource_id, member_id, action:'UPDATE', metadata:{ reviewer_id, new_tier, notes } })

    KYC->>Notif: send({ template_id:'kyc-approved', recipient:{ member_id:app.member_id }, variables:{ level, new_tier } })
    KYC-->>Caller: return app
```

---

## 5. KYCEngine.reject() — `kyc-engine.js:206-244`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine
    participant Apps as applications (Map)
    participant Revs as reviews (Map)
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Notif as notificationService

    Caller->>KYC: reject({ application_id, reviewer_id, reason, actor='reviewer' })

    alt reason is null/empty
        KYC-->>Caller: throw 'reason is required for rejection'
    end

    KYC->>Apps: get(application_id)
    alt app not found
        KYC-->>Caller: throw 'Application not found: <application_id>'
    end
    alt app.status != 'in_review'
        KYC-->>Caller: throw 'Application is <status>'
    end
    alt app.assigned_reviewer_id != reviewer_id
        KYC-->>Caller: throw 'Only assigned reviewer can reject'
    end

    KYC->>Apps: app.status='rejected', reviewed_at, reviewed_by=reviewer_id, decision='rejected', decision_reason=reason

    KYC->>KYC: review_id = `REV-${Date.now()}-${++_idSeq}`
    KYC->>Revs: set(review_id, { application_id, reviewer_id, decision:'rejected', notes:reason, reviewed_at })

    KYC->>Bus: publish('kyc.application_rejected', { application_id, reason })
    KYC->>Audit: log({ event_type:'KYC_APPLICATION_REJECTED', actor, resource_type:'kyc_application', resource_id, member_id, action:'UPDATE', metadata:{ reviewer_id, reason } })

    KYC->>Notif: send({ template_id:'kyc-rejected', recipient:{ member_id:app.member_id }, variables:{ level, reason } })
    KYC-->>Caller: return app
```

---

## 6. KYCEngine.requestMoreInfo() — `kyc-engine.js:250-293`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine
    participant Apps as applications (Map)
    participant Revs as reviews (Map)
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Notif as notificationService

    Caller->>KYC: requestMoreInfo({ application_id, reviewer_id, message, actor='reviewer' })

    alt message is null/empty
        KYC-->>Caller: throw 'message is required'
    end

    KYC->>Apps: get(application_id)
    alt app not found
        KYC-->>Caller: throw 'Application not found: <application_id>'
    end
    alt app.status != 'in_review'
        KYC-->>Caller: throw 'Application is <status>'
    end

    KYC->>Apps: app.status='more_info_required', decision_reason=message
    KYC->>KYC: oldDeadline = parse(app.sla_deadline)
    KYC->>KYC: newDeadline = oldDeadline + 24*3600*1000  // extend from current deadline, not from now
    KYC->>Apps: app.sla_deadline = newDeadline.toISOString()

    KYC->>KYC: review_id = `REV-${Date.now()}-${++_idSeq}`
    KYC->>Revs: set(review_id, { application_id, reviewer_id, decision:'more_info_required', notes:message, reviewed_at: now })

    KYC->>Bus: publish('kyc.more_info_requested', { application_id, message, new_sla })
    KYC->>Audit: log({ event_type:'KYC_MORE_INFO_REQUESTED', actor, resource_type:'kyc_application', resource_id, member_id, action:'UPDATE', metadata:{ reviewer_id, message, new_sla } })

    KYC->>Notif: send({ template_id:'kyc-more-info', recipient:{ member_id:app.member_id }, variables:{ message, deadline } })
    KYC-->>Caller: return app
```

---

## 7. KYCEngine.getStatus() / getReviewerQueue() / getStats()

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine
    participant Apps as applications (Map)
    participant Docs as documents (Map)

    Note over Caller,KYC: getStatus(member_id) — kyc-engine.js:299-314
    Caller->>KYC: getStatus(member_id)
    alt member_id missing
        KYC-->>Caller: throw 'member_id is required'
    end
    KYC->>Apps: filter by member_id, sort by submitted_at DESC
    KYC->>KYC: app = [0] or undefined
    alt !app
        KYC-->>Caller: return { has_application:false }
    end
    KYC->>Docs: filter by application_id
    KYC-->>Caller: return { has_application:true, application_id, level, status, submitted_at, sla_deadline, decision, decision_reason, documents:[{ document_id, document_type, file_name, uploaded_at }] }

    Note over Caller,KYC: getReviewerQueue({ reviewer_id?, status?, limit=20 }) — kyc-engine.js:320-326
    Caller->>KYC: getReviewerQueue(...)
    KYC->>Apps: filter (reviewer_id? status?) then sort by sla_deadline ASC
    KYC-->>Caller: return { total, items: slice(0,limit) }

    Note over Caller,KYC: getStats({ since?, reviewer_id? }) — kyc-engine.js:355-368
    Caller->>KYC: getStats({ since, reviewer_id })
    KYC->>Apps: filter (since?, reviewer_id?) → recent
    KYC-->>Caller: return { total, recent, pending, approved, rejected, more_info, approval_rate, sla_breaches }
```

---

## 8. IdentityResolutionEngine.findDuplicates() — `identity-resolution.js:18-104`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant IR as IdentityResolutionEngine
    participant ID as identityService
    participant DB as identity.db
    participant Agg as _aggregateMatches

    Caller->>IR: findDuplicates(candidate)

    Note over IR: candidate = { member_id?, phone_hash?, device_fingerprint?, ip_address?, display_name? }

    alt candidate.phone_hash present
        IR->>ID: getMemberByPhone(phone_hash)
        alt byPhone.member_id != candidate.member_id
            IR->>IR: matches.push({ member_id, signal:'PHONE_HASH_MATCH', confidence:0.95, reason:'Same phone_hash' })
        end
    end

    alt candidate.device_fingerprint present
        IR->>DB: device_bindings.filter(d => d.device_fingerprint==X && d.member_id != candidate.member_id)
        loop for each deviceMatch
            IR->>IR: matches.push({ member_id, signal:'DEVICE_MATCH', confidence:0.85, reason:'Same device fingerprint' })
        end
    end

    alt candidate.ip_address present
        IR->>DB: device_bindings.filter(d => d.ip_address==X && d.member_id != candidate.member_id && _isRecent(d.last_seen_at, 7))
        loop for each ipMatch
            IR->>IR: matches.push({ member_id, signal:'IP_RECENT_MATCH', confidence:0.6, reason:'Same IP within 7 days' })
        end
    end

    alt candidate.display_name present
        IR->>DB: all members via _getAllMembers()
        loop for each m where m.member_id != candidate.member_id
            IR->>IR: similarity = _nameSimilarity(candidate.display_name, m.display_name)
            alt similarity > 0.8
                IR->>IR: matches.push({ member_id:m.member_id, signal:'NAME_SIMILARITY', confidence:similarity*0.5, reason:`Name similarity <pct>%` })
            end
        end
    end

    IR->>Agg: _aggregateMatches(matches)
    Agg-->>IR: Array grouped by member_id, confidence = max + 0.05*(signals-1) bonus, capped at 0.99
    IR-->>Caller: return sorted by confidence DESC

    Note over Caller,IR: classifyAction(confidence) — identity-resolution.js:114-119
    Caller->>IR: classifyAction(confidence)
    alt confidence > 0.95
        IR-->>Caller: { action:'AUTO_MERGE', threshold:0.95 }
    else confidence > 0.80
        IR-->>Caller: { action:'MANUAL_REVIEW', threshold:0.80 }
    else
        IR-->>Caller: { action:'REJECT', threshold:0.80 }
    end
```

---

## 9. RFC-001 stub kyc.js — `kyc.js:13-83`

```mermaid
sequenceDiagram
    autonumber
    participant Caller
    participant KYC as KYCEngine (stub)
    participant ID as identityService
    participant Audit as auditLog

    Note over Caller,KYC: upgradeKYC(member_id, { target_level, documents }) — kyc.js:14-52
    Caller->>KYC: upgradeKYC(member_id, { target_level, documents })

    KYC->>ID: getMember(member_id)
    alt member not found
        KYC-->>Caller: throw 'MEMBER_NOT_FOUND'
    end

    alt target_level not in [LEVEL_0, LEVEL_1, LEVEL_2]
        KYC-->>Caller: throw 'INVALID_KYC_LEVEL'
    end

    alt target_level == LEVEL_2 AND !documents
        KYC-->>Caller: throw 'LEVEL_2_REQUIRES_DOCUMENTS'
    end

    alt target_level == LEVEL_1
        KYC->>ID: updateMember(member_id, { kyc_level:'LEVEL_1' })
        KYC->>Audit: record({ action:'KYC_UPGRADED', member_id, from:currentLevel, to:'LEVEL_1' })
        KYC-->>Caller: return { approved:true, level:'LEVEL_1' }
    else target_level == LEVEL_2
        KYC->>Audit: record({ action:'KYC_REVIEW_REQUESTED', member_id, documents_received: Object.keys(documents).length })
        KYC-->>Caller: return { approved:false, status:'PENDING_REVIEW', level:'LEVEL_2' }
    end

    Note over Caller,KYC: checkKYCGate(member, requiredLevel) — kyc.js:62-71
    Caller->>KYC: checkKYCGate(member, requiredLevel)
    KYC->>KYC: memberLevel = {LEVEL_0:0, LEVEL_1:1, LEVEL_2:2}[member.kyc_level || 'LEVEL_0']
    KYC->>KYC: required = {LEVEL_0:0, LEVEL_1:1, LEVEL_2:2}[requiredLevel]
    KYC-->>Caller: return { allowed: memberLevel >= required, current, required }
```

---

## 10. IdentityService HTTP API — `server.js:25-108`

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant Express
    participant IS as IdentityService
    participant DB as db (in-memory Map)
    participant Audit as AuditLog

    Note over Client,Audit: Member CRUD
    Client->>Express: POST /api/identity/members { display_name, phone_hash, phone_last4 }
    Express->>IS: createMember({ display_name, phone_hash, phone_last4 })
    IS-->>Express: result
    Express-->>Client: 201 / 400

    Client->>Express: GET /api/identity/members/:member_id
    Express->>IS: getMember(member_id)
    alt not found
        Express-->>Client: 404 { error:'MEMBER_NOT_FOUND' }
    else
        IS-->>Express: member
        Express-->>Client: 200 member
    end

    Client->>Express: GET /api/identity/members/by-phone/:phone_hash
    Express->>IS: getMemberByPhone(phone_hash)
    alt not found
        Express-->>Client: 404 { error:'MEMBER_NOT_FOUND' }
    else
        IS-->>Express: member
        Express-->>Client: 200 member
    end

    Client->>Express: PATCH /api/identity/members/:member_id (body)
    Express->>IS: updateMember(member_id, body)
    IS-->>Express: member
    Express-->>Client: 200 / 400

    Client->>Express: DELETE /api/identity/members/:member_id
    Express->>IS: deleteMember(member_id)
    IS-->>Express: member
    Express-->>Client: 200 / 400

    Note over Client,Audit: Phone Bindings
    Client->>Express: POST /api/identity/phone-bindings { member_id, phone_hash, phone_last4, is_primary, status }
    Express->>IS: bindPhone(...)
    Express-->>Client: 201 / 400

    Client->>Express: GET /api/identity/members/:member_id/phones
    Express->>IS: getPhonesForMember(member_id)
    Express-->>Client: 200 { phones }

    Client->>Express: DELETE /api/identity/phone-bindings/:binding_id
    Express->>IS: unbindPhone(binding_id)
    Express-->>Client: 200 / 400

    Note over Client,Audit: Consent
    Client->>Express: POST /api/identity/consents { member_id, consent_type, granted }
    Express->>IS: recordConsent(...)
    Express-->>Client: 201 / 400

    Client->>Express: DELETE /api/identity/consents/:consent_id
    Express->>IS: revokeConsent(consent_id)
    Express-->>Client: 200 / 400

    Note over Client,Audit: Health
    Client->>Express: GET /
    Express-->>Client: 200 { service, stats:{ members, phone_bindings, consents }, endpoints:[10 strings] }
```

---

## End-to-End Trace (KYC L2 happy path)

```mermaid
sequenceDiagram
    autonumber
    participant U as user (applicant)
    participant API as Identity Service API
    participant IS as IdentityService
    participant KYC as KYCEngine
    participant IR as IdentityResolutionEngine
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Rev as reviewer
    participant N as notificationService

    U->>API: POST /api/identity/members { display_name, phone_hash, phone_last4 }
    API->>IS: createMember
    IS-->>API: { member_id }
    API-->>U: 201

    U->>IR: findDuplicates({ member_id, phone_hash, device_fingerprint, ip_address, display_name })
    Note over IR: signals: PHONE_HASH_MATCH (0.95), DEVICE_MATCH (0.85), IP_RECENT_MATCH (0.6), NAME_SIMILARITY
    IR-->>U: [matches sorted by confidence DESC]

    U->>KYC: submitApplication({ member_id, level:2, business_name, business_license, tax_id, actor:'user' })
    KYC->>KYC: check duplicate pending → throw if exists
    KYC->>KYC: sla_hours=48, sla_deadline = now+48h
    KYC->>Bus: publish('kyc.application_submitted')
    KYC->>Audit: log(KYC_APPLICATION_SUBMITTED)
    KYC->>KYC: _assignReviewer() (round-robin)
    KYC->>Bus: publish('kyc.application_assigned')
    KYC->>Audit: log(KYC_APPLICATION_ASSIGNED)
    KYC->>N: send({ template_id:'kyc-reviewer-assigned' })

    loop while status=='in_review' or 'more_info_required'
        U->>KYC: uploadDocument({ application_id, document_type, file_name, file_url, ... })
        KYC->>Audit: log(KYC_DOCUMENT_UPLOADED)
        opt reviewer wants more info
            Rev->>KYC: requestMoreInfo({ application_id, reviewer_id, message })
            KYC->>KYC: status='more_info_required', sla_deadline += 24h
            KYC->>Bus: publish('kyc.more_info_requested')
            KYC->>Audit: log(KYC_MORE_INFO_REQUESTED)
            KYC->>N: send({ template_id:'kyc-more-info' })
        end
    end

    alt Rev approves
        Rev->>KYC: approve({ application_id, reviewer_id, notes })
        KYC->>KYC: status='approved', newTier = (level==2 ? 'pro' : 'enterprise')
        KYC->>IS: updateMember(member_id, { tier:newTier, kyc_level:app.level })
        KYC->>Bus: publish('kyc.application_approved')
        KYC->>Audit: log(KYC_APPLICATION_APPROVED)
        KYC->>N: send({ template_id:'kyc-approved' })
    else Rev rejects
        Rev->>KYC: reject({ application_id, reviewer_id, reason })
        KYC->>KYC: status='rejected', decision_reason=reason
        KYC->>Bus: publish('kyc.application_rejected')
        KYC->>Audit: log(KYC_APPLICATION_REJECTED)
        KYC->>N: send({ template_id:'kyc-rejected' })
    end

    U->>KYC: getStatus(member_id)
    KYC-->>U: { has_application, application_id, level, status, decision, decision_reason, documents }
```

---

## Event Topics (eventBus)

| Topic | Published by | File:line |
|---|---|---|
| `kyc.application_submitted` | `KYCEngine.submitApplication` | kyc-engine.js:65 |
| `kyc.application_assigned` | `KYCEngine._assignReviewer` | kyc-engine.js:139 |
| `kyc.application_approved` | `KYCEngine.approve` | kyc-engine.js:188 |
| `kyc.application_rejected` | `KYCEngine.reject` | kyc-engine.js:233 |
| `kyc.more_info_requested` | `KYCEngine.requestMoreInfo` | kyc-engine.js:281 |

## Audit Event Types (auditEngine)

| event_type | Action | File:line |
|---|---|---|
| `KYC_APPLICATION_SUBMITTED` | CREATE | kyc-engine.js:71 |
| `KYC_APPLICATION_ASSIGNED` | UPDATE (actor:'system') | kyc-engine.js:144 |
| `KYC_APPLICATION_APPROVED` | UPDATE | kyc-engine.js:192 |
| `KYC_APPLICATION_REJECTED` | UPDATE | kyc-engine.js:237 |
| `KYC_MORE_INFO_REQUESTED` | UPDATE | kyc-engine.js:285 |
| `KYC_DOCUMENT_UPLOADED` | CREATE | kyc-engine.js:107 |
| `KYC_REVIEWER_ADDED` | CREATE | kyc-engine.js:347 |
| `KYC_UPGRADED` | (RFC-001 stub) | kyc.js:37 |
| `KYC_REVIEW_REQUESTED` | (RFC-001 stub) | kyc.js:46 |

## Notification Templates (notificationService.send)

| template_id | Recipient | Triggered by |
|---|---|---|
| `kyc-reviewer-assigned` | reviewer (member_id + email) | _assignReviewer |
| `kyc-approved` | applicant (member_id) | approve |
| `kyc-rejected` | applicant (member_id) | reject |
| `kyc-more-info` | applicant (member_id) | requestMoreInfo |

## IdentityResolution confidence thresholds (`classifyAction`)

| confidence | action | threshold |
|---|---|---|
| > 0.95 | `AUTO_MERGE` | 0.95 |
| > 0.80 | `MANUAL_REVIEW` | 0.80 |
| ≤ 0.80 | `REJECT` | 0.80 |

## IdentityResolution signal weights

| signal | confidence | notes |
|---|---|---|
| `PHONE_HASH_MATCH` | 0.95 | via `identityService.getMemberByPhone` |
| `DEVICE_MATCH` | 0.85 | via `db.device_bindings` |
| `IP_RECENT_MATCH` | 0.60 | within 7 days (`_isRecent(d.last_seen_at, 7)`) |
| `NAME_SIMILARITY` | similarity*0.5 (max 0.4) | Levenshtein > 0.8 |

## KYC L2/L3 SLA constants

| level | sla_hours | source |
|---|---|---|
| 2 | 48 | kyc-engine.js:49 (`level === 2 ? 48 : 72`) |
| 3 | 72 | kyc-engine.js:49 |
| more_info extension | +24h from current `sla_deadline` | kyc-engine.js:266-269 |

## KYC application state machine

```
              submitApplication
                     │
                     ▼
              ┌─────────────┐
              │   pending   │  ← _assignReviewer() with no active reviewers
              └──────┬──────┘
                     │ _assignReviewer() (round-robin)
                     ▼
              ┌─────────────┐
              │  in_review  │  ← uploaded docs; reviewer decides
              └──┬──────┬───┘
       requestMoreInfo   │
                 │       │
                 ▼       │
       ┌────────────────┐ │
       │more_info_required│ │ approve
       │   (SLA +24h)   │ │
       └────────┬───────┘ │
                │         │
                │         ▼
                │  ┌─────────────┐
                │  │  approved   │  → members.update({ tier:pro/enterprise })
                │  └─────────────┘
                │         ▲
                │         │ reject
                │         │
                │  ┌─────────────┐
                └─▶│  rejected   │
                   └─────────────┘
```

## IdentityService endpoints (`server.js:122-133`)

| Method | Path | Body / Params | Handler |
|---|---|---|---|
| POST | `/api/identity/members` | `{ display_name, phone_hash, phone_last4 }` | `identity.createMember` |
| GET | `/api/identity/members/:member_id` | — | `identity.getMember` (404 if not found) |
| GET | `/api/identity/members/by-phone/:phone_hash` | — | `identity.getMemberByPhone` (404 if not found) |
| PATCH | `/api/identity/members/:member_id` | partial member fields | `identity.updateMember` |
| DELETE | `/api/identity/members/:member_id` | — | `identity.deleteMember` |
| POST | `/api/identity/phone-bindings` | `{ member_id, phone_hash, phone_last4, is_primary, status }` | `identity.bindPhone` |
| GET | `/api/identity/members/:member_id/phones` | — | `identity.getPhonesForMember` |
| DELETE | `/api/identity/phone-bindings/:binding_id` | — | `identity.unbindPhone` |
| POST | `/api/identity/consents` | `{ member_id, consent_type, granted }` | `identity.recordConsent` |
| DELETE | `/api/identity/consents/:consent_id` | — | `identity.revokeConsent` |
| GET | `/` | — | health check (service + stats + endpoint list) |

Default port: `process.env.PORT || 3002` (`server.js:135`).
