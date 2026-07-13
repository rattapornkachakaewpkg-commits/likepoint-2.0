# Identity + KYC End-to-End — Code Trace (Mermaid, no interpretation)

> **Source files (read-only trace):**
> - `apps/identity-service/member.js` — IdentityService (Member, Phone, Consent)
> - `apps/identity-service/server.js` — HTTP API (11 endpoints)
> - `apps/engine/kyc-engine.js` — KYCEngine (10 methods, L2/L3)
> - `apps/engine/kyc.js` — RFC-001 stub (L0/L1)
> - `apps/engine/identity-resolution.js` — duplicate detection
> - `sql/migrations/2026-07-07-p0-identity-service.sql` — members, phone_bindings, device_bindings, login_history, consent_log
> - `sql/migrations/2026-07-07-phase-e-pf16-kyc.sql` — kyc_reviewers, kyc_applications, kyc_documents, kyc_reviews, v_kyc_pending_queue, get_kyc_stats()

> **All names (table, column, method, event, type) are taken verbatim from source code.**

---

## 1. Member lifecycle (IdentityService)

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as Express
    participant IS as IdentityService
    participant DB as db (Map)
    participant AL as AuditLog

    C->>API: POST /api/identity/members { display_name, phone_hash, phone_last4 }
    API->>IS: createMember({ display_name, phone_hash, phone_last4 })
    alt display_name missing
        IS-->>API: throw 'display_name is required'
        API-->>C: 400
    end
    IS->>IS: member_id = _generateUUID()  // 'usr_<32hex>'
    IS->>DB: members.set(member_id, { member_id, display_name, status:'ACTIVE', trust_score:'50', kyc_level:'LEVEL_0', created_at, updated_at })

    alt phone_hash provided
        IS->>IS: bindPhone({ member_id, phone_hash, phone_last4, is_primary:true, status:'VERIFIED' })
        IS->>DB: phone_bindings filter phone_hash → existingBinding
        alt existingBinding and existingBinding.member_id != member_id
            IS-->>API: throw 'PHONE_ALREADY_BOUND_TO_ANOTHER_MEMBER'
        end
        alt is_primary
            loop for each b where b.member_id==member_id and b.is_primary
                IS->>DB: b.is_primary=false; b.status = b.status.replace('PRIMARY','SECONDARY')
            end
        end
        IS->>IS: binding_id = _generateUUID()
        IS->>DB: phone_bindings.set(binding_id, { binding_id, member_id, phone_hash, phone_last4, status, is_primary, created_at, verified_at: status=='VERIFIED' ? now : null })
        IS->>AL: record({ action:'PHONE_BOUND', binding_id, member_id, phone_last4, is_primary, timestamp })
    end

    IS->>AL: record({ action:'MEMBER_CREATED', member_id, display_name, timestamp })
    IS-->>API: { member, phone_binding }
    API-->>C: 201
```

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as Express
    participant IS as IdentityService
    participant DB as db (Map)
    participant AL as AuditLog

    C->>API: PATCH /api/identity/members/:member_id (body)
    API->>IS: updateMember(member_id, updates)
    IS->>DB: members.get(member_id)
    alt not found
        IS-->>API: throw 'MEMBER_NOT_FOUND'
        API-->>C: 400
    end
    alt member.status == 'DELETED'
        IS-->>API: throw 'MEMBER_DELETED'
        API-->>C: 400
    end
    IS->>IS: allowed = ['display_name', 'kyc_level', 'status']
    IS->>IS: safeUpdates = pick(updates, allowed)
    IS->>DB: Object.assign(member, safeUpdates, { updated_at: now })
    IS->>AL: record({ action:'MEMBER_UPDATED', member_id, updates:safeUpdates, timestamp })
    IS-->>API: member
    API-->>C: 200

    C->>API: DELETE /api/identity/members/:member_id
    API->>IS: deleteMember(member_id)
    IS->>DB: members.get(member_id)
    alt not found
        IS-->>API: throw 'MEMBER_NOT_FOUND'
    end
    IS->>DB: member.status='DELETED'; member.deleted_at=now; member.updated_at=now
    IS->>AL: record({ action:'MEMBER_DELETED', member_id, timestamp })
    IS-->>API: member
    API-->>C: 200
```

---

## 2. Phone bindings + Consent

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as Express
    participant IS as IdentityService
    participant DB as db (Map)
    participant AL as AuditLog

    C->>API: POST /api/identity/phone-bindings { member_id, phone_hash, phone_last4, is_primary, status }
    API->>IS: bindPhone({ member_id, phone_hash, phone_last4, is_primary=false, status='PENDING' })
    alt member_id or phone_hash missing
        IS-->>API: throw 'member_id and phone_hash are required'
    end
    IS->>DB: members.get(member_id)
    alt not found
        IS-->>API: throw 'MEMBER_NOT_FOUND'
    end
    IS->>DB: phone_bindings filter phone_hash → existingBinding
    alt existingBinding and existingBinding.member_id != member_id
        IS-->>API: throw 'PHONE_ALREADY_BOUND_TO_ANOTHER_MEMBER'
    end
    alt is_primary
        loop for each b where b.member_id==member_id and b.is_primary
            IS->>DB: b.is_primary=false; b.status=b.status.replace('PRIMARY','SECONDARY')
        end
    end
    IS->>IS: binding_id=_generateUUID()
    IS->>DB: phone_bindings.set(binding_id, { binding_id, member_id, phone_hash, phone_last4:phone_last4||phone_hash.slice(-4), status, is_primary, created_at, verified_at: status=='VERIFIED'?now:null })
    IS->>AL: record({ action:'PHONE_BOUND', binding_id, member_id, phone_last4, is_primary, timestamp })
    IS-->>API: binding
    API-->>C: 201

    C->>API: GET /api/identity/members/:member_id/phones
    API->>IS: getPhonesForMember(member_id)
    IS->>DB: phone_bindings.filter(b.member_id==member_id)
    IS-->>API: array
    API-->>C: 200 { phones }

    C->>API: DELETE /api/identity/phone-bindings/:binding_id
    API->>IS: unbindPhone(binding_id)
    IS->>DB: phone_bindings.get(binding_id)
    alt not found
        IS-->>API: throw 'BINDING_NOT_FOUND'
    end
    alt binding.is_primary
        IS-->>API: throw 'CANNOT_REMOVE_PRIMARY_PHONE'
    end
    IS->>DB: phone_bindings.delete(binding_id)
    IS->>AL: record({ action:'PHONE_UNBOUND', binding_id, member_id:binding.member_id, timestamp })
    IS-->>API: { success:true }
    API-->>C: 200

    Note over C,AL: Consent
    C->>API: POST /api/identity/consents { member_id, consent_type, granted }
    API->>IS: recordConsent({ member_id, consent_type, granted })
    alt member_id or consent_type missing
        IS-->>API: throw 'member_id and consent_type are required'
    end
    IS->>IS: consent_id=_generateUUID()
    IS->>DB: consents.set(consent_id, { consent_id, member_id, consent_type, granted, granted_at: granted?now:null, revoked_at: !granted?now:null })
    IS->>AL: record({ action:'CONSENT_RECORDED', member_id, consent_type, granted, timestamp })
    IS-->>API: consent
    API-->>C: 201

    C->>API: DELETE /api/identity/consents/:consent_id
    API->>IS: revokeConsent(consent_id)
    IS->>DB: consents.get(consent_id)
    alt not found
        IS-->>API: throw 'CONSENT_NOT_FOUND'
    end
    alt !consent.granted
        IS-->>API: throw 'CONSENT_ALREADY_REVOKED'
    end
    IS->>DB: consent.granted=false; consent.revoked_at=now
    IS-->>API: consent
    API-->>C: 200
```

---

## 3. KYC L0 → L1 → L2/L3 progression (kyc.js stub + kyc-engine.js)

```mermaid
sequenceDiagram
    autonumber
    participant U as user
    participant KYC0 as KYCEngine (kyc.js stub)
    participant KYC2 as KYCEngine (kyc-engine.js)
    participant ID as identityService
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Notif as notificationService
    participant Mem as memberService

    Note over U,Mem: Level 0 → Level 1 (auto, via stub)
    U->>KYC0: upgradeKYC(member_id, { target_level:'LEVEL_1' })
    KYC0->>ID: getMember(member_id)
    alt member not found
        KYC0-->>U: throw 'MEMBER_NOT_FOUND'
    end
    alt target_level not in [LEVEL_0, LEVEL_1, LEVEL_2]
        KYC0-->>U: throw 'INVALID_KYC_LEVEL'
    end
    KYC0->>ID: updateMember(member_id, { kyc_level:'LEVEL_1' })
    KYC0->>Audit: record({ action:'KYC_UPGRADED', member_id, from:currentLevel, to:'LEVEL_1' })
    KYC0-->>U: return { approved:true, level:'LEVEL_1' }

    Note over U,Mem: Level 1 → Level 2 (manual review)
    U->>KYC0: upgradeKYC(member_id, { target_level:'LEVEL_2', documents:{...} })
    alt !documents
        KYC0-->>U: throw 'LEVEL_2_REQUIRES_DOCUMENTS'
    end
    KYC0->>Audit: record({ action:'KYC_REVIEW_REQUESTED', member_id, documents_received:Object.keys(documents).length })
    KYC0-->>U: return { approved:false, status:'PENDING_REVIEW', level:'LEVEL_2' }

    Note over U,Mem: Real L2 flow via KYCEngine (kyc-engine.js)
    U->>KYC2: submitApplication({ member_id, level:2, business_name, business_license, tax_id, actor:'user' })
    KYC2->>KYC2: check existing pending where member_id==X AND level==Y AND status in [pending, in_review, more_info_required]
    KYC2->>KYC2: sla_hours=48; sla_deadline=now+48h
    KYC2->>Bus: publish('kyc.application_submitted')
    KYC2->>Audit: log(KYC_APPLICATION_SUBMITTED)
    KYC2->>KYC2: _assignReviewer() round-robin
    KYC2->>Bus: publish('kyc.application_assigned')
    KYC2->>Audit: log(KYC_APPLICATION_ASSIGNED)
    KYC2->>Notif: send({ template_id:'kyc-reviewer-assigned' })
    KYC2-->>U: return application

    U->>KYC2: uploadDocument({ application_id, document_type:'business_license', file_name, file_url })
    KYC2->>Audit: log(KYC_DOCUMENT_UPLOADED)

    Rev->>KYC2: approve({ application_id, reviewer_id, notes })
    KYC2->>Mem: update(member_id, { tier:'pro', kyc_level:app.level })
    KYC2->>Bus: publish('kyc.application_approved')
    KYC2->>Audit: log(KYC_APPLICATION_APPROVED)
    KYC2->>Notif: send({ template_id:'kyc-approved' })

    Note over U,Mem: Gate check
    U->>KYC0: checkKYCGate(member, 'LEVEL_2')
    KYC0->>KYC0: memberLevel = {LEVEL_0:0,LEVEL_1:1,LEVEL_2:2}[member.kyc_level || 'LEVEL_0']
    KYC0-->>U: return { allowed: memberLevel >= required, current, required }
```

---

## 4. Identity resolution (duplicate detection)

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
                IR->>IR: matches.push({ member_id, signal:'NAME_SIMILARITY', confidence:similarity*0.5, reason:`Name similarity <pct>%` })
            end
        end
    end
    IR->>Agg: _aggregateMatches(matches)
    Agg-->>IR: Array grouped by member_id, confidence = max + 0.05*(signals-1) bonus, capped at 0.99
    IR-->>Caller: sorted by confidence DESC

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

## 5. Database ER diagram (Identity + KYC)

```mermaid
erDiagram
    members ||--o{ phone_bindings : "has"
    members ||--o{ device_bindings : "has"
    members ||--o{ login_history : "logs"
    members ||--o{ consent_log : "grants"
    members ||--o{ kyc_applications : "submits"
    kyc_applications ||--o{ kyc_documents : "uploads"
    kyc_applications ||--o{ kyc_reviews : "receives"
    kyc_reviewers ||--o{ kyc_applications : "assigned_to"
    kyc_reviewers ||--o{ kyc_reviews : "writes"

    members {
        UUID member_id PK
        VARCHAR_255 display_name
        VARCHAR_20 status "ACTIVE | SUSPENDED | DELETED"
        INTEGER trust_score "0-100, default 50"
        VARCHAR_20 kyc_level "LEVEL_0 | LEVEL_1 | LEVEL_2"
        TIMESTAMP created_at
        TIMESTAMP updated_at
        TIMESTAMP deleted_at
    }
    phone_bindings {
        UUID binding_id PK
        UUID member_id FK
        VARCHAR_128 phone_hash "UNIQUE"
        VARCHAR_4 phone_last4
        VARCHAR_30 status "PENDING | VERIFIED | PRIMARY_VERIFIED | SECONDARY | REVOKED"
        BOOLEAN is_primary
        TIMESTAMP verified_at
        TIMESTAMP revoked_at
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }
    device_bindings {
        UUID device_id PK
        UUID member_id FK
        VARCHAR_255 device_fingerprint
        VARCHAR_20 platform "ios | android | web"
        VARCHAR_50 app_version
        TIMESTAMP last_seen_at
        TIMESTAMP first_seen_at
    }
    login_history {
        BIGSERIAL id PK
        UUID member_id
        VARCHAR_128 phone_hash
        TIMESTAMP login_at
        VARCHAR_45 ip_address
        TEXT user_agent
        VARCHAR_20 result "SUCCESS | FAILED"
        TEXT failure_reason
    }
    consent_log {
        UUID consent_id PK
        UUID member_id FK
        VARCHAR_50 consent_type "MARKETING | DATA_PROCESSING | THIRD_PARTY_SHARING"
        BOOLEAN granted
        TIMESTAMP granted_at
        TIMESTAMP revoked_at
        VARCHAR_45 ip_address
        TEXT user_agent
        TIMESTAMP created_at
    }
    kyc_reviewers {
        BIGSERIAL id PK
        TEXT reviewer_id PK "R-1, R-2, ..."
        TEXT name
        TEXT email
        JSONB specializations "['business','tax','banking']"
        BOOLEAN active
        TEXT status "active | suspended | inactive"
        TIMESTAMPTZ added_at
        TIMESTAMPTZ last_assigned_at
    }
    kyc_applications {
        BIGSERIAL id PK
        TEXT application_id PK "KYC-{ts}-{seq}"
        UUID member_id FK
        INT level "CHECK 2|3"
        TEXT business_name
        TEXT business_license
        TEXT tax_id
        JSONB metadata
        TEXT status "pending|in_review|more_info_required|approved|rejected"
        TEXT assigned_reviewer_id FK
        TIMESTAMPTZ submitted_at
        TIMESTAMPTZ sla_deadline
        TIMESTAMPTZ reviewed_at
        TEXT reviewed_by
        TEXT decision "approved|rejected"
        TEXT decision_reason
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
    kyc_documents {
        BIGSERIAL id PK
        TEXT document_id PK "DOC-{ts}-{seq}"
        TEXT application_id FK
        TEXT document_type "business_license|tax_id|id_card|bank_statement"
        TEXT file_name
        TEXT file_url
        BIGINT file_size_bytes
        TEXT mime_type
        TIMESTAMPTZ uploaded_at
        TEXT uploaded_by
    }
    kyc_reviews {
        BIGSERIAL id PK
        TEXT review_id PK "REV-{ts}-{seq}"
        TEXT application_id FK
        TEXT reviewer_id FK
        TEXT decision "approved|rejected|more_info_required"
        TEXT notes
        TIMESTAMPTZ reviewed_at
    }
```

---

## 6. KYC state machine

```mermaid
stateDiagram-v2
    [*] --> pending: submitApplication
    pending --> in_review: _assignReviewer (round-robin)
    pending --> pending: no active reviewers
    in_review --> approved: approve
    in_review --> rejected: reject
    in_review --> more_info_required: requestMoreInfo
    more_info_required --> in_review: uploadDocument / re-review
    approved --> [*]
    rejected --> [*]
```

---

## 7. End-to-end trace (signup → KYC L2 approved)

```mermaid
sequenceDiagram
    autonumber
    participant U as user
    participant API as Identity Service API
    participant IS as IdentityService
    participant KYC1 as KYCEngine (kyc.js)
    participant KYC2 as KYCEngine (kyc-engine.js)
    participant IR as IdentityResolutionEngine
    participant Bus as eventBus
    participant Audit as auditEngine
    participant Rev as reviewer
    participant Notif as notificationService
    participant Mem as memberService

    U->>API: POST /api/identity/members { display_name, phone_hash, phone_last4 }
    API->>IS: createMember
    IS->>IS: member_id = _generateUUID() (UUID)
    IS->>IS: status=ACTIVE, trust_score=50, kyc_level=LEVEL_0
    IS->>IS: bindPhone(status:VERIFIED, is_primary:true)
    IS->>Audit: record(MEMBER_CREATED)
    IS-->>U: { member, phone_binding }

    U->>KYC1: upgradeKYC(member_id, { target_level:'LEVEL_1' })
    KYC1->>IS: updateMember({ kyc_level:'LEVEL_1' })
    KYC1->>Audit: record(KYC_UPGRADED)
    KYC1-->>U: { approved:true, level:'LEVEL_1' }

    U->>IR: findDuplicates({ member_id, phone_hash, device_fingerprint, ip_address, display_name })
    IR->>IS: getMemberByPhone
    IR->>IS.db: device_bindings.filter
    IR->>IS.db: members (for name)
    IR-->>U: matches sorted by confidence DESC

    U->>KYC1: checkKYCGate(member, 'LEVEL_2')
    KYC1-->>U: { allowed:false, current:'LEVEL_1', required:'LEVEL_2' }

    U->>KYC1: upgradeKYC(member_id, { target_level:'LEVEL_2', documents })
    KYC1->>Audit: record(KYC_REVIEW_REQUESTED, documents_received)
    KYC1-->>U: { approved:false, status:'PENDING_REVIEW', level:'LEVEL_2' }

    U->>KYC2: submitApplication({ member_id, level:2, business_name, business_license, tax_id })
    KYC2->>KYC2: sla_hours=48
    KYC2->>Bus: publish(kyc.application_submitted)
    KYC2->>Audit: log(KYC_APPLICATION_SUBMITTED)
    KYC2->>KYC2: _assignReviewer (round-robin)
    KYC2->>Bus: publish(kyc.application_assigned)
    KYC2->>Audit: log(KYC_APPLICATION_ASSIGNED)
    KYC2->>Notif: send(kyc-reviewer-assigned)

    U->>KYC2: uploadDocument(business_license) / uploadDocument(tax_id) / uploadDocument(id_card)
    KYC2->>Audit: log(KYC_DOCUMENT_UPLOADED) x3

    Rev->>KYC2: requestMoreInfo({ application_id, reviewer_id, message:'need bank statement' })
    KYC2->>KYC2: status=more_info_required, sla_deadline += 24h
    KYC2->>Bus: publish(kyc.more_info_requested)
    KYC2->>Audit: log(KYC_MORE_INFO_REQUESTED)
    KYC2->>Notif: send(kyc-more-info)

    U->>KYC2: uploadDocument(bank_statement)
    KYC2->>Audit: log(KYC_DOCUMENT_UPLOADED)

    Rev->>KYC2: approve({ application_id, reviewer_id, notes })
    KYC2->>KYC2: status=approved, newTier='pro' (level==2)
    KYC2->>Mem: update(member_id, { tier:'pro', kyc_level:2 })
    KYC2->>Bus: publish(kyc.application_approved)
    KYC2->>Audit: log(KYC_APPLICATION_APPROVED)
    KYC2->>Notif: send(kyc-approved)

    U->>KYC2: getStatus(member_id)
    KYC2-->>U: { has_application:true, level:2, status:'approved', decision:'approved', decision_reason:notes, documents:[4 items] }

    U->>KYC1: checkKYCGate(member_updated, 'LEVEL_2')
    KYC1-->>U: { allowed:true, current:'LEVEL_2', required:'LEVEL_2' }
```

---

## 8. RLS policies (kyc-applications + kyc-documents)

```mermaid
flowchart TB
    subgraph Roles
        R1["current_setting('app.current_role') = 'member'"]
        R2["current_setting('app.current_role') = 'reviewer'"]
        R3["current_setting('app.current_role') = 'admin'"]
        R4["current_setting('app.current_role') = 'service'"]
    end

    subgraph kyc_applications
        P1["kyc_app_own: SELECT<br/>member_id::text = current_setting('app.current_member_id')"]
        P2["kyc_app_reviewer: ALL<br/>assigned_reviewer_id = current_setting('app.current_reviewer_id')"]
        P3["kyc_app_admin: ALL"]
        P4["kyc_app_service: ALL"]
    end

    subgraph kyc_documents
        P5["kyc_doc_own: SELECT<br/>application_id IN (SELECT application_id FROM kyc_applications WHERE member_id::text = current_setting('app.current_member_id'))"]
        P6["kyc_doc_reviewer: SELECT<br/>application_id IN (SELECT application_id FROM kyc_applications WHERE assigned_reviewer_id = current_setting('app.current_reviewer_id'))"]
        P7["kyc_doc_admin: ALL"]
        P8["kyc_doc_service: ALL"]
    end

    R1 --> P1
    R2 --> P2
    R3 --> P3
    R4 --> P4
    R1 -.-> P5
    R2 -.-> P6
    R3 -.-> P7
    R4 -.-> P8
```

---

## 9. Views + Functions (DB)

```mermaid
flowchart LR
    subgraph Tables
        A[kyc_applications]
        D[kyc_documents]
    end

    subgraph View
        V["v_kyc_pending_queue<br/>(filter status IN pending,in_review,more_info_required)<br/>+ hours_until_sla<br/>+ sla_status: BREACHED|URGENT|WARNING|NORMAL<br/>+ document_count"]
    end

    subgraph Function
        F["get_kyc_stats(p_since TIMESTAMPTZ DEFAULT now()-7d)<br/>RETURNS: total_applications, pending, approved,<br/>rejected, more_info, sla_breaches, approval_rate"]
    end

    A --> V
    D --> V
    A --> F

    V --> Caller["SELECT * FROM v_kyc_pending_queue ORDER BY sla_deadline LIMIT 10"]
    F --> Caller2["SELECT * FROM get_kyc_stats(now() - INTERVAL '7 days')"]
```

---

## 10. Event + Audit + Notification cross-reference

| Event topic (eventBus) | Audit event_type | Notification template_id | File:line |
|---|---|---|---|
| `kyc.application_submitted` | `KYC_APPLICATION_SUBMITTED` | — | kyc-engine.js:65,71 |
| `kyc.application_assigned` | `KYC_APPLICATION_ASSIGNED` (actor:'system') | `kyc-reviewer-assigned` | kyc-engine.js:139,144,148 |
| `kyc.application_approved` | `KYC_APPLICATION_APPROVED` | `kyc-approved` | kyc-engine.js:188,192,196 |
| `kyc.application_rejected` | `KYC_APPLICATION_REJECTED` | `kyc-rejected` | kyc-engine.js:233,237,241 |
| `kyc.more_info_requested` | `KYC_MORE_INFO_REQUESTED` | `kyc-more-info` | kyc-engine.js:281,285,289 |
| — | `KYC_DOCUMENT_UPLOADED` | — | kyc-engine.js:107 |
| — | `KYC_REVIEWER_ADDED` | — | kyc-engine.js:347 |
| — | `MEMBER_CREATED` (RFC-001) | — | member.js:104 |
| — | `MEMBER_UPDATED` | — | member.js:171 |
| — | `MEMBER_DELETED` | — | member.js:190 |
| — | `PHONE_BOUND` | — | member.js:241 |
| — | `PHONE_UNBOUND` | — | member.js:265 |
| — | `CONSENT_RECORDED` | — | member.js:300 |
| — | `KYC_UPGRADED` (RFC-001 stub) | — | kyc.js:37 |
| — | `KYC_REVIEW_REQUESTED` (RFC-001 stub) | — | kyc.js:46 |

## 11. Member.status state machine

```mermaid
stateDiagram-v2
    [*] --> ACTIVE: createMember
    ACTIVE --> SUSPENDED: updateMember({status:'SUSPENDED'})
    ACTIVE --> DELETED: deleteMember (soft delete)
    SUSPENDED --> ACTIVE: updateMember({status:'ACTIVE'})
    SUSPENDED --> DELETED: deleteMember
    DELETED --> [*]
```

## 12. KYC level progression

```mermaid
stateDiagram-v2
    [*] --> LEVEL_0: createMember (default kyc_level)
    LEVEL_0 --> LEVEL_1: upgradeKYC(target:'LEVEL_1') — auto via stub
    LEVEL_1 --> LEVEL_2: upgradeKYC(target:'LEVEL_2',documents) — request review
    LEVEL_2 --> LEVEL_2: submitApplication+approve via KYCEngine — sets kyc_level=2
    LEVEL_2 --> [*]
```

## 13. Identity data flow (signup)

```mermaid
flowchart TD
    A["Client: POST /api/identity/members<br/>{ display_name, phone_hash, phone_last4 }"] --> B["IdentityService.createMember"]
    B --> C["member_id = _generateUUID()<br/>(crypto.randomBytes(16).toString('hex'))"]
    C --> D["db.members.set(member_id, {<br/>status:'ACTIVE', trust_score:'50', kyc_level:'LEVEL_0' })"]
    B --> E{"phone_hash?"}
    E -- yes --> F["bindPhone(is_primary:true, status:'VERIFIED')"]
    F --> G["db.phone_bindings.set(binding_id, ...)<br/>(UNIQUE constraint on phone_hash)"]
    E -- no --> H
    B --> H["AuditLog.record({ action:'MEMBER_CREATED' })"]
    G --> H
    H --> I["Response 201: { member, phone_binding }"]

    subgraph Storage
        D
        G
    end
```
