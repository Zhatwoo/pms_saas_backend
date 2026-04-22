import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase credentials');
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log('Fetching all customers...');
  const { data: customers, error: err1 } = await supabase.from('customers').select('id, full_name');
  if (err1) throw err1;

  console.log(`Found ${customers.length} total customers.`);

  console.log('Fetching all pawned_items...');
  const { data: pawnedItems, error: err2 } = await supabase.from('pawned_items').select('customer_id');
  if (err2) throw err2;

  const usedCustomerIds = new Set<string>();
  for (const p of pawnedItems) {
    if (p.customer_id) usedCustomerIds.add(p.customer_id);
  }

  const toDelete = customers.filter(c => !usedCustomerIds.has(c.id));
  console.log(`Found ${toDelete.length} customers with no transactions/pawned_items.`);

  for (const c of toDelete) {
    console.log(`Deleting ${c.full_name} (${c.id})...`);
    // Delete from customer_activity_logs first just in case there are constraints
    const { error: actErr } = await supabase.from('customer_activity_logs').delete().eq('customer_id', c.id);
    if (actErr) {
      console.warn(`Could not delete activity logs for ${c.id}: ${actErr.message}`);
    }
    
    const { error: delErr } = await supabase.from('customers').delete().eq('id', c.id);
    if (delErr) {
      console.error(`Error deleting ${c.id}:`, delErr.message);
    }
  }
  console.log('Done.');
}

run().catch(console.error);
