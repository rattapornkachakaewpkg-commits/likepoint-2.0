// Device Binding Engine — RFC-001 Open Question #3
// "การจัดการผู้ใช้ที่เปลี่ยนเครื่อง"
// Author: AliClaw | Date: 2026-07-07

class DeviceBindingEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.identityService
   * @param {Object} dependencies.notificationService (optional)
   * @param {Object} dependencies.auditLog
   */
  constructor({ identityService, notificationService, auditLog } = {}) {
    if (!identityService) throw new Error('identityService is required');
    this.identity = identityService;
    this.notify = notificationService || console;
    this.audit = auditLog || console;
  }

  /**
   * Register a new device for a member
   */
  async registerDevice({ member_id, device_fingerprint, platform, app_version, ip_address }) {
    if (!member_id || !device_fingerprint) {
      throw new Error('member_id and device_fingerprint are required');
    }

    const member = await this.identity.getMember(member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    if (member.status === 'DELETED') throw new Error('MEMBER_DELETED');

    // Max 10 devices per member
    const existing = await this.getDevices(member_id);
    if (existing.length >= 10) {
      throw new Error('MAX_DEVICES_REACHED (max 10 per member)');
    }

    // Check if device already registered
    const existingDevice = existing.find(d => d.device_fingerprint === device_fingerprint);
    if (existingDevice) {
      // Update last_seen
      existingDevice.last_seen_at = new Date().toISOString();
      await this.audit.record?.({
        action: 'DEVICE_LAST_SEEN_UPDATED',
        device_id: existingDevice.device_id,
        member_id
      });
      return existingDevice;
    }

    // Check if this is a NEW device (alert member)
    const isNewDevice = existing.length > 0;
    if (isNewDevice) {
      await this._notifyNewDevice(member, ip_address, platform);
    }

    const device = {
      device_id: this._generateUUID(),
      member_id,
      device_fingerprint,
      platform: platform || 'unknown',
      app_version: app_version || null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      ip_address: ip_address || null,
      status: isNewDevice ? 'PENDING_VERIFICATION' : 'ACTIVE'
    };

    if (this.identity.db?.device_bindings) {
      this.identity.db.device_bindings.set(device.device_id, device);
    }

    await this.audit.record?.({
      action: 'DEVICE_REGISTERED',
      device_id: device.device_id,
      member_id,
      platform,
      is_new_device: isNewDevice
    });

    return device;
  }

  /**
   * Get all devices for a member
   */
  async getDevices(member_id) {
    if (!this.identity.db?.device_bindings) return [];
    return Array.from(this.identity.db.device_bindings.values())
      .filter(d => d.member_id === member_id);
  }

  /**
   * Verify a device (after 2FA)
   */
  async verifyDevice(device_id) {
    const device = this.identity.db?.device_bindings?.get(device_id);
    if (!device) throw new Error('DEVICE_NOT_FOUND');
    if (device.status === 'ACTIVE') return device;

    device.status = 'ACTIVE';
    device.verified_at = new Date().toISOString();
    this.identity.db.device_bindings.set(device_id, device);

    await this.audit.record?.({
      action: 'DEVICE_VERIFIED',
      device_id,
      member_id: device.member_id
    });

    return device;
  }

  /**
   * Revoke a device (logout)
   */
  async revokeDevice(device_id, reason = 'USER_REQUEST') {
    const device = this.identity.db?.device_bindings?.get(device_id);
    if (!device) throw new Error('DEVICE_NOT_FOUND');

    device.status = 'REVOKED';
    device.revoked_at = new Date().toISOString();
    device.revoke_reason = reason;
    this.identity.db.device_bindings.set(device_id, device);

    await this.audit.record?.({
      action: 'DEVICE_REVOKED',
      device_id,
      member_id: device.member_id,
      reason
    });

    return device;
  }

  /**
   * Detect suspicious device change
   * Pattern: new device + new IP + new country within 1 hour
   */
  async detectSuspiciousChange(member_id, new_device_info) {
    const devices = await this.getDevices(member_id);
    const activeDevices = devices.filter(d => d.status === 'ACTIVE');

    // First device — not suspicious
    if (activeDevices.length === 0) {
      return { suspicious: false, reason: 'first_device' };
    }

    // Different IP + different country (from previous)
    const lastDevice = activeDevices[activeDevices.length - 1];
    const sameIP = lastDevice.ip_address === new_device_info.ip_address;
    const samePlatform = lastDevice.platform === new_device_info.platform;

    if (!sameIP && !samePlatform) {
      return {
        suspicious: true,
        reason: 'new_ip_and_platform_within_session',
        last_device: lastDevice.device_id,
        requires_2fa: true
      };
    }

    return { suspicious: false, reason: 'normal_change' };
  }

  // ============== HELPERS ==============
  async _notifyNewDevice(member, ip, platform) {
    const msg = `[Notification] New device login for member ${member.member_id}: ${platform} from IP ${ip}`;
    if (this.notify.send) {
      await this.notify.send(member.member_id, msg);
    } else {
      console.log(msg);
    }
  }

  _generateUUID() {
    return 'dev_' + require('crypto').randomBytes(16).toString('hex');
  }
}

module.exports = { DeviceBindingEngine };
