/**
 * One-time migration helper for projects created before accounts existed.
 *
 * Those rows are preserved but invisible to every account. Nothing here assigns
 * them automatically; an operator must name the exact account id that should
 * own them.
 *
 *   npx tsx scripts/assign-legacy-projects.ts                 # report only
 *   npx tsx scripts/assign-legacy-projects.ts --user-sub <sub> --apply
 *
 * Find the id in the users table after that person has signed in once:
 *   sqlite3 data/autoclipper.db 'SELECT id, email, name FROM users;'
 */
import { loadEnvFile } from '../src/lib/load-env';
import * as db from '../src/lib/db';

loadEnvFile();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const subIndex = args.indexOf('--user-sub');
const sub = subIndex >= 0 ? args[subIndex + 1] : null;

const unowned = await db.countUnownedProjects();

if (!sub) {
  console.log(`${unowned} project(s) have no owner and are hidden from every account.`);
  console.log('Re-run with --user-sub <account-id> --apply to assign them deliberately.');
  process.exit(0);
}

if (!apply) {
  console.log(`Dry run: ${unowned} project(s) would be assigned to ${sub}. Add --apply to write.`);
  process.exit(0);
}

const user = await db.getUser(sub);
if (!user) {
  console.error(`No user with id ${sub}. They must sign in once before their projects can be assigned.`);
  process.exit(1);
}

const changed = await db.assignUnownedProjects(sub);
console.log(`Assigned ${changed} project(s) to ${user.email ?? user.id}.`);
