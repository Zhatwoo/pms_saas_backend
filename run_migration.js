require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function applyMigration() {
  // Since we can't create functions via PostgREST, let's use a workaround:
  // We'll create a postgres function via a raw insert into a temp approach
  
  // Actually, let's try the simplest approach: use the Supabase REST endpoint directly
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  // Try to hit the pg-meta API that Supabase Studio uses internally
  const endpoints = [
    '/pg/query',
    '/rest/v1/rpc/exec_sql',
    '/graphql/v1',
  ];

  // Alternative: Just test if the constraint already allows Expense
  console.log('\nStep 2: Testing if Expense purpose is already allowed...');
  const testId = 'test-' + Date.now();
  const { data: testData, error: testErr } = await c
    .from('transactions')
    .insert({
      purpose: 'Expense',
      cash_out: 0.01,
      cash_in: 0,
      branch_id: '1204867f-ff84-43a3-9627-334d05efc46d', // use existing branch for now
      branch: 'Test',
      transaction_no: testId,
      transaction_date: '2026-04-29',
      transaction_time: '00:00:00',
      return_amount: 0,
      storage_fee: 0,
      pawn_amount: 0,
      details: 'Migration test - will be deleted'
    })
    .select('id')
    .single();

  if (testErr) {
    console.log('Expense purpose test FAILED:', testErr.message);
    
    if (testErr.message.includes('transactions_purpose_check')) {
      console.log('\n==> The purpose constraint needs updating.');
      console.log('==> Trying to apply via Supabase Management API...\n');
      
      // Try the Supabase Management API with the project's access token
      const projectRef = url.replace('https://', '').replace('.supabase.co', '');
      
      // Use fetch to hit the SQL editor endpoint
      const sqlStatements = [
        "ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_purpose_check;",
        "ALTER TABLE public.transactions ADD CONSTRAINT transactions_purpose_check CHECK (purpose IN ('Start','End','Buy Back','Renew','Sold Item','Sale','Pawn','Cash Transfer','Fund Transfer','Redeem','Expense'));",
        "ALTER TABLE public.transactions ALTER COLUMN branch_id DROP NOT NULL;"
      ];
      
      const fullSql = sqlStatements.join('\n');
      
      console.log('=== YOU MUST RUN THIS SQL IN SUPABASE SQL EDITOR ===');
      console.log('URL: https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
      console.log('\n' + fullSql + '\n');
      console.log('====================================================');
    }
  } else {
    console.log('Expense purpose test PASSED! (constraint already allows Expense)');
    // Clean up test row
    if (testData?.id) {
      await c.from('transactions').delete().eq('id', testData.id);
      console.log('Test row cleaned up.');
    }

    // Now test NULL branch_id
    console.log('\nStep 3: Testing if NULL branch_id is allowed...');
    const testId2 = 'test2-' + Date.now();
    const { data: testData2, error: testErr2 } = await c
      .from('transactions')
      .insert({
        purpose: 'Expense',
        cash_out: 0.01,
        cash_in: 0,
        branch_id: null,
        branch: 'System / Head Office',
        transaction_no: testId2,
        transaction_date: '2026-04-29',
        transaction_time: '00:00:00',
        return_amount: 0,
        storage_fee: 0,
        pawn_amount: 0,
        details: 'Migration test NULL branch - will be deleted'
      })
      .select('id')
      .single();

    if (testErr2) {
      console.log('NULL branch_id test FAILED:', testErr2.message);
      console.log('\n==> Need to run: ALTER TABLE public.transactions ALTER COLUMN branch_id DROP NOT NULL;');
    } else {
      console.log('NULL branch_id test PASSED!');
      if (testData2?.id) {
        await c.from('transactions').delete().eq('id', testData2.id);
        console.log('Test row cleaned up.');
      }
      console.log('\n*** ALL MIGRATIONS ARE ALREADY APPLIED! Feature should be functional. ***');
    }
  }
}

applyMigration().catch(e => console.error('Error:', e.message));
