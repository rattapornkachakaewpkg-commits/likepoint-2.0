// Event Simulator — จำลอง event เปลี่ยนเบอร์โทร + ทดสอบ Rebind Engine
// Phase B: PF-2
// วิธีใช้: node simulator.js [scenario]
// Scenarios: 1=basic, 2=duplicate-wallet, 3=missing-wallet, 4=concurrent

const http = require('http');

const API_BASE = 'http://localhost:3001';

function call(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =================== SCENARIOS ===================

async function scenario1_basicRebind() {
  console.log('\n🧪 ========== SCENARIO 1: Basic Rebind ==========');
  console.log('📞 สมาชิก usr_001 เปลี่ยนเบอร์ 088-1234-5678 → 099-1111-2222');
  
  // 1. Simulate webhook
  console.log('\n[1] MS24 ส่ง webhook phone-changed');
  const result = await call('POST', '/api/ms24/webhook/phone-changed', {
    person_id: 'usr_001',
    old_phone_hash: 'h_old_001',
    new_phone_hash: 'h_new_001',
    new_phone: '099-1111-2222'
  });
  console.log('   Result:', result);
  
  await sleep(500);
  
  // 2. Verify wallet status
  console.log('\n[2] ตรวจสอบ wallet');
  const wallets = await call('GET', '/api/mini-like/wallets/usr_001');
  console.log('   Wallets:', JSON.stringify(wallets, null, 2));
  
  console.log('\n✅ Scenario 1 PASS');
}

async function scenario2_duplicateWallet() {
  console.log('\n🧪 ========== SCENARIO 2: Duplicate Wallet (Merge) ==========');
  console.log('📞 สมาชิก usr_002 เปลี่ยนเบอร์ — มี Old + New wallet');
  
  // 1. Simulate Old wallet (already exists)
  console.log('\n[1] Old wallet (h_002) exists');
  const oldWallet = await call('GET', '/api/mini-like/wallet/wlt_002');
  console.log('   Old wallet:', JSON.stringify(oldWallet, null, 2));
  
  // 2. Create new wallet (simulate — user re-registered with new phone)
  console.log('\n[2] New wallet (h_new_002) created');
  // (ในระบบจริง engine จะสร้างผ่าน API แต่ที่นี่ mock ให้แล้ว)
  
  // 3. MS24 webhook
  console.log('\n[3] MS24 ส่ง webhook phone-changed');
  const result = await call('POST', '/api/ms24/webhook/phone-changed', {
    person_id: 'usr_002',
    old_phone_hash: 'h_002',
    new_phone_hash: 'h_new_002',
    new_phone: '099-3333-4444'
  });
  console.log('   Result:', result);
  
  console.log('\n💡 Engine ควร: merge old wallet → new wallet (รวม balance)');
  console.log('✅ Scenario 2 — รอ Engine ทำงาน');
}

async function scenario3_missingWallet() {
  console.log('\n🧪 ========== SCENARIO 3: Missing Wallet (Create) ==========');
  console.log('📞 สมาชิก usr_003 เปลี่ยนเบอร์ — ไม่มี Old wallet');
  
  // 1. Check wallet (should not exist)
  console.log('\n[1] Check usr_003 wallets');
  const wallets = await call('GET', '/api/mini-like/wallets/usr_003');
  console.log('   Wallets:', JSON.stringify(wallets, null, 2));
  
  // 2. MS24 webhook
  console.log('\n[2] MS24 ส่ง webhook');
  const result = await call('POST', '/api/ms24/webhook/phone-changed', {
    person_id: 'usr_003',
    old_phone_hash: 'h_003',
    new_phone_hash: 'h_new_003',
    new_phone: '099-5555-6666'
  });
  console.log('   Result:', result);
  
  console.log('\n💡 Engine ควร: log + notify admin (no wallet to rebind)');
  console.log('✅ Scenario 3 — รอ Engine');
}

async function scenario4_concurrent() {
  console.log('\n🧪 ========== SCENARIO 4: Concurrent Events ==========');
  console.log('📞 2 events พร้อมกัน — ทดสอบ race condition');
  
  const promises = [
    call('POST', '/api/ms24/webhook/phone-changed', {
      person_id: 'usr_001',
      old_phone_hash: 'h_old_001',
      new_phone_hash: 'h_v2_001',
      new_phone: '099-1111-1111'
    }),
    call('POST', '/api/ms24/webhook/phone-changed', {
      person_id: 'usr_001',
      old_phone_hash: 'h_old_001',
      new_phone_hash: 'h_v3_001',
      new_phone: '099-1111-1111'
    })
  ];
  
  const results = await Promise.all(promises);
  console.log('   Results:', results);
  
  console.log('\n💡 Engine ควร: ใช้ lock + idempotency กัน race');
  console.log('✅ Scenario 4 — รอ Engine');
}

// =================== MAIN ===================

async function main() {
  const scenario = process.argv[2] || '1';
  console.log(`🎬 Mock API Simulator — Scenario ${scenario}`);
  
  // Test connection
  try {
    await call('GET', '/');
    console.log('✅ Connected to Mock API');
  } catch (e) {
    console.error('❌ Cannot connect to Mock API. Start it first:');
    console.error('   node mock-api/server.js');
    process.exit(1);
  }
  
  switch (scenario) {
    case '1': await scenario1_basicRebind(); break;
    case '2': await scenario2_duplicateWallet(); break;
    case '3': await scenario3_missingWallet(); break;
    case '4': await scenario4_concurrent(); break;
    case 'all':
      await scenario1_basicRebind();
      await sleep(1000);
      await scenario2_duplicateWallet();
      await sleep(1000);
      await scenario3_missingWallet();
      await sleep(1000);
      await scenario4_concurrent();
      break;
    default:
      console.log('Usage: node simulator.js [1|2|3|4|all]');
  }
  
  console.log('\n📊 Event Log:');
  const events = await call('GET', '/api/events');
  console.log(JSON.stringify(events, null, 2));
}

main().catch(console.error);
