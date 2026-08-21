// Applies pending migrations to the live database and prints the result.
import { join } from 'node:path';
import { migrate, openDatabase } from '@linkedin-mcp/db';
import { resolveDataHome } from '@linkedin-mcp/shared';

const home = resolveDataHome();
const { db } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
const { applied } = migrate(db);
console.log(JSON.stringify({ home, applied }));
console.log(
  'linkedin_accounts columns:',
  db
    .all('PRAGMA table_info(linkedin_accounts)')
    .map((r) => String(r['name']))
    .join(', '),
);
console.log(
  'tables:',
  db
    .all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => String(r['name']))
    .join(', '),
);
db.close();
