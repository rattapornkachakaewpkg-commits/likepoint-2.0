-- ===========================================
-- P2: Tenant Relationship Model
-- RFC-001: "Tenant เป็นเจ้าของความสัมพันธ์กับลูกค้า"
-- Date: 2026-07-07
-- ===========================================

-- Tenant Relationship: Member ↔ Tenant
CREATE TABLE IF NOT EXISTS tenant_relationship (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       UUID NOT NULL,
  tenant_id       UUID NOT NULL,
  marketing_consent BOOLEAN DEFAULT false,
  membership_level VARCHAR(20) DEFAULT 'BRONZE',  -- 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'
  customer_since  TIMESTAMP DEFAULT NOW(),
  status          VARCHAR(20) DEFAULT 'ACTIVE',  -- 'ACTIVE' | 'SUSPENDED' | 'OPTED_OUT'
  last_active_at  TIMESTAMP,
  total_spent     DECIMAL(18,2) DEFAULT 0,
  total_points_earned DECIMAL(18,2) DEFAULT 0,
  total_points_redeemed DECIMAL(18,2) DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(member_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_rel_member ON tenant_relationship(member_id);
CREATE INDEX IF NOT EXISTS idx_tenant_rel_tenant ON tenant_relationship(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_rel_tier ON tenant_relationship(membership_level);

-- Tenant Consent Log (PDPA)
CREATE TABLE IF NOT EXISTS tenant_consent_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       UUID NOT NULL,
  tenant_id       UUID NOT NULL,
  consent_type    VARCHAR(50) NOT NULL,
  granted         BOOLEAN NOT NULL,
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_consent_member ON tenant_consent_log(member_id, tenant_id);

-- Comments
COMMENT ON TABLE tenant_relationship IS 'RFC-001 P2: Tenant owns the relationship (not the customer)';
COMMENT ON TABLE tenant_consent_log IS 'RFC-001 P2: Audit log for tenant-specific consents (PDPA)';
