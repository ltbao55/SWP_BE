require('dotenv').config();
const { supabaseAdmin } = require('./config/supabase');

async function testInsert() {
  console.log('Attempting to insert test label into "labels" table...');
  const { data, error } = await supabaseAdmin
    .from('labels')
    .insert({
      name: 'Test ' + Date.now(),
      color: '#ff0000',
      description: 'Schema test'
    })
    .select();

  if (error) {
    console.error('❌ INSERT FAILED');
    console.error('Error Code:', error.code);
    console.error('Message:', error.message);
    console.error('Details:', error.details);
    console.error('Hint:', error.hint);
  } else {
    console.log('✅ INSERT SUCCESS');
    console.log('Inserted Data:', data);
  }
}

testInsert();
