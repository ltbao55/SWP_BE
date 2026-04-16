/**
 * Supabase Connection Test
 * Run: node test-connection.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('\n=== Supabase Connection Test ===\n');
console.log('URL:', SUPABASE_URL);
console.log('Anon key :', SUPABASE_ANON_KEY ? SUPABASE_ANON_KEY.slice(0, 20) + '...' : 'MISSING');
console.log('Service key:', SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY.slice(0, 20) + '...' : 'MISSING');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('\n❌ Missing env vars. Check .env file.\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function runTests() {
  let passed = 0;
  let failed = 0;

  const check = (label, ok, detail = '') => {
    if (ok) { console.log(`  ✅ ${label}`); passed++; }
    else     { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++; }
  };

  // 1. Ping — query system_settings (singleton table)
  console.log('\n[1] Database connectivity...');
  const { data: settings, error: settingsErr } = await supabase
    .from('system_settings')
    .select('id')
    .limit(1);
  check('system_settings reachable', !settingsErr, settingsErr?.message);

  // 2. Check all tables exist
  console.log('\n[2] Table existence...');
  const tables = ['profiles','projects','datasets','data_items','label_sets','labels','tasks','task_reviewers','activity_logs','system_settings'];
  for (const table of tables) {
    const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    check(`table: ${table}`, !error, error?.message);
  }

  // 3. Check project_task_stats view
  console.log('\n[3] View existence...');
  const { error: viewErr } = await supabase
    .from('project_task_stats')
    .select('*', { count: 'exact', head: true });
  check('view: project_task_stats', !viewErr, viewErr?.message);

  // 4. Auth — create + delete a test user
  console.log('\n[4] Supabase Auth...');
  const testEmail = `test_conn_${Date.now()}@devnull.local`;
  const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
    email: testEmail, password: 'Test1234!', email_confirm: true,
  });
  check('create test user', !createErr, createErr?.message);

  if (newUser?.user) {
    const { error: delErr } = await supabase.auth.admin.deleteUser(newUser.user.id);
    check('delete test user', !delErr, delErr?.message);
  }

  // 5. Storage bucket
  console.log('\n[5] Storage bucket...');
  const { data: buckets, error: bucketsErr } = await supabase.storage.listBuckets();
  check('storage API reachable', !bucketsErr, bucketsErr?.message);
  if (buckets) {
    const hasBucket = buckets.some((b) => b.name === (process.env.STORAGE_BUCKET || 'datasets'));
    check(`bucket "${process.env.STORAGE_BUCKET || 'datasets'}" exists`, hasBucket,
      hasBucket ? '' : 'Create it in Supabase Dashboard → Storage');
  }

  // Summary
  console.log(`\n${'─'.repeat(35)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('🎉 All checks passed — ready to start server!\n');
  else              console.log('⚠️  Fix the failing checks above, then retry.\n');
}

runTests().catch((err) => {
  console.error('\n💥 Unexpected error:', err.message);
  process.exit(1);
});
