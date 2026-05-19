const { Client } = require('pg');

async function main() {
  const connectionString = "postgresql://postgres.sixbaykcrnjjljatbuia:Inspire%402026%21@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
  const client = new Client({ connectionString });
  await client.connect();
  
  const res = await client.query(`
    update public.daily_opening
    set status = 'pending'
    where opening_date = '2026-05-18'::date
  `);
  
  console.log('Update result:', res.rowCount, 'rows updated.');
  
  const check = await client.query(`
    select id, branch_id, opening_date, starting_cash, status, employee_id
    from public.daily_opening
    where opening_date = '2026-05-18'::date
  `);
  
  console.log('Current row state:', JSON.stringify(check.rows, null, 2));

  await client.end();
}

main().catch(console.error);
