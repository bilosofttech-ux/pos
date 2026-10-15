const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://qmztvmxiqxufhpnmudmh.supabase.co';
const supabaseKey = process.env.SUPABASE_API_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Test the connection
if (supabase) {
  supabase
    .from('Product')
    .select('*')
    .limit(1)
    .then(({ data, error }) => {
      if (error) console.error('Supabase connection error:', error.message);
      else console.log('Connected to Supabase:', data ? 'OK' : 'Empty');
    })
    .catch((err) => console.log('Supabase check note:', err.message));
}

module.exports = supabase;
