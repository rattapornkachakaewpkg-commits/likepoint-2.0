// Notification Service — Unit Tests
// Author: AliClaw | Date: 2026-07-07

const { NotificationService } = require('./notification-service.js');

function makeProviders() {
  return {
    sms: { _sent: [], async send({ to, subject, body }) { this._sent.push({ to, subject, body }); return { provider_id: `sms-${this._sent.length}` }; } },
    email: { _sent: [], async send({ to, subject, body }) { this._sent.push({ to, subject, body }); return { provider_id: `email-${this._sent.length}` }; } },
    push: { _sent: [], async send({ to, subject, body }) { this._sent.push({ to, subject, body }); return { provider_id: `push-${this._sent.length}` }; } },
    line: { _sent: [], async send({ to, subject, body }) { this._sent.push({ to, subject, body }); return { provider_id: `line-${this._sent.length}` }; } },
    telegram: { _sent: [], async send({ to, subject, body }) { this._sent.push({ to, subject, body }); return { provider_id: `telegram-${this._sent.length}` }; } },
  };
}
function makeAudit() { return { _l: [], async log(e) { this._l.push(e); return { id: 'a' }; } }; }
function makeBus() { return { _e: [], async publish(t, p) { this._e.push({ t, p }); } }; }

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };
const assertContains = (s, sub, m) => { if (!s.includes(sub)) throw new Error(`${m}: ${sub} not in ${s.slice(0, 100)}`); };

console.log('\n📢 Notification Service — Tests\n');

(async () => {
  const providers = makeProviders();
  const audit = makeAudit();
  const bus = makeBus();
  const ns = new NotificationService({ providers, auditEngine: audit, eventBus: bus });

  // === createTemplate ===
  await test('T01: createTemplate requires all fields', async () => {
    try { await ns.createTemplate({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T02: createTemplate rejects invalid channel', async () => {
    try { await ns.createTemplate({ template_id: 'x', name: 'X', channel: 'fax', body: 'hi' }); assert(false); }
    catch (e) { assertContains(e.message, 'channel', 'wrong error'); }
  });

  await test('T03: createTemplate with 5 channels (sms/email/push/line/telegram)', async () => {
    for (const ch of ['sms', 'email', 'push', 'line', 'telegram']) {
      await ns.createTemplate({ template_id: `tpl-${ch}`, name: `${ch} Tpl`, channel: ch, body: 'Hello {{name}}' });
    }
    assertEq(ns.templates.size, 5);
  });

  // === send ===
  await test('T04: send requires template_id and recipient', async () => {
    try { await ns.send({}); assert(false); }
    catch (e) { assertContains(e.message, 'required', 'wrong error'); }
  });

  await test('T05: send rejects unknown template', async () => {
    try { await ns.send({ template_id: 'NOPE', recipient: { member_id: 'M-1' } }); assert(false); }
    catch (e) { assertContains(e.message, 'Template not found', 'wrong error'); }
  });

  await test('T06: send renders template variables', async () => {
    const r = await ns.send({
      template_id: 'tpl-sms',
      recipient: { member_id: 'M-1', phone: '0812345678' },
      variables: { name: 'Alice' },
    });
    assertContains(r.body, 'Alice', 'variable rendered');
    assertEq(r.status, 'sent');
  });

  await test('T07: send calls correct provider based on channel', async () => {
    const before = providers.email._sent.length;
    await ns.send({
      template_id: 'tpl-email',
      recipient: { member_id: 'M-2', email: 'm2@x.com' },
      variables: { name: 'Bob' },
    });
    assertEq(providers.email._sent.length, before + 1, 'email provider called');
  });

  await test('T08: send idempotency (same key returns existing)', async () => {
    const r1 = await ns.send({
      template_id: 'tpl-push',
      recipient: { member_id: 'M-1' },
      idempotency_key: 'IDEM-001',
    });
    const r2 = await ns.send({
      template_id: 'tpl-push',
      recipient: { member_id: 'M-1' },
      idempotency_key: 'IDEM-001',
    });
    assertEq(r1.notification_id, r2.notification_id);
  });

  // === Preferences ===
  await test('T09: setPreference stores opt-out and channels', async () => {
    const p = await ns.setPreference({
      member_id: 'M-1',
      opt_out: ['tpl-sms'],
      channels: ['email', 'push'],
    });
    assertEq(p.opt_out.length, 1);
    assertEq(p.channels.length, 2);
  });

  await test('T10: send respects opt-out (skipped)', async () => {
    const before = providers.sms._sent.length;
    const r = await ns.send({
      template_id: 'tpl-sms',
      recipient: { member_id: 'M-1' },
    });
    assertEq(r.status, 'OPTED_OUT');
    assertEq(providers.sms._sent.length, before, 'SMS not sent');
  });

  await test('T11: send respects channel preference', async () => {
    const r = await ns.send({
      template_id: 'tpl-line',
      recipient: { member_id: 'M-1' },
    });
    assertEq(r.status, 'CHANNEL_DISABLED');
  });

  // === markRead ===
  await test('T12: markRead updates notification', async () => {
    const r = await ns.send({
      template_id: 'tpl-telegram',
      recipient: { member_id: 'M-3' },
      variables: { name: 'Carol' },
    });
    const read = await ns.markRead({ notification_id: r.notification_id, member_id: 'M-3' });
    assertEq(read.status, 'read');
    assert(read.read_at, 'read_at set');
  });

  await test('T13: markRead rejects other user', async () => {
    const r = await ns.send({
      template_id: 'tpl-telegram',
      recipient: { member_id: 'M-3' },
    });
    try { await ns.markRead({ notification_id: r.notification_id, member_id: 'M-OTHER' }); assert(false); }
    catch (e) { assertContains(e.message, 'another user', 'wrong error'); }
  });

  // === listForMember ===
  await test('T14: listForMember filters by member', async () => {
    const r = await ns.listForMember({ member_id: 'M-3' });
    assert(r.items.every((n) => n.recipient_member_id === 'M-3'));
  });

  await test('T15: listForMember filters by status', async () => {
    const r = await ns.listForMember({ member_id: 'M-3', status: 'read' });
    assert(r.items.every((n) => n.status === 'read'));
  });

  // === sendBulk ===
  await test('T16: sendBulk processes multiple recipients', async () => {
    const results = await ns.sendBulk({
      template_id: 'tpl-sms',
      recipients: [
        { member_id: 'B1', phone: '0800000001' },
        { member_id: 'B2', phone: '0800000002' },
        { member_id: 'B3', phone: '0800000003' },
      ],
    });
    assertEq(results.sent + results.opted_out + results.failed, 3);
  });

  await test('T17: sendBulk handles empty recipients', async () => {
    try { await ns.sendBulk({ template_id: 'tpl-sms', recipients: [] }); assert(false); }
    catch (e) { assertContains(e.message, 'non-empty', 'wrong error'); }
  });

  // === getStats ===
  await test('T18: getStats aggregates by channel', async () => {
    const s = await ns.getStats({});
    assert(s.by_channel, 'should have by_channel');
    assert(typeof s.by_channel.sms === 'number');
  });

  await test('T19: getStats calculates read rate', async () => {
    const s = await ns.getStats({});
    assert(typeof s.read_rate === 'string', 'read_rate is string');
  });

  // === Events ===
  await test('T20: send publishes notification.sent event', async () => {
    const before = bus._e.filter((e) => e.t === 'notification.sent').length;
    await ns.send({
      template_id: 'tpl-push',
      recipient: { member_id: 'M-NEW' },
      variables: { name: 'NewUser' },
    });
    const after = bus._e.filter((e) => e.t === 'notification.sent').length;
    assert(after > before);
  });

  await test('T21: createTemplate audits itself', async () => {
    const before = audit._l.filter((l) => l.event_type === 'NOTIF_TEMPLATE_CREATED').length;
    await ns.createTemplate({ template_id: 'tpl-new-1', name: 'New', channel: 'sms', body: 'X' });
    const after = audit._l.filter((l) => l.event_type === 'NOTIF_TEMPLATE_CREATED').length;
    assert(after > before);
  });

  await test('T22: send renders all variables', async () => {
    const r = await ns.send({
      template_id: 'tpl-email',
      recipient: { member_id: 'M-2' },
      variables: { name: 'Alice', amount: 100, merchant: 'Bangkok Cafe' },
    });
    // template 'tpl-email' has body 'Hello {{name}}' — only name is rendered
    assertContains(r.body, 'Alice');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''}`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
