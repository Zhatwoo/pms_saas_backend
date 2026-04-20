import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkTable() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase.from('notifications').select('id').limit(1);
  if (error) {
    console.error('Error checking notifications table:', error);
  } else {
    console.log('Notifications table exists.');
  }
}

checkTable();
