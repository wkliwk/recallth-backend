/**
 * One-time script to grant admin access to a user by email.
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/scripts/setAdmin.ts --email ricky@example.com
 *   npx ts-node -r dotenv/config src/scripts/setAdmin.ts --email ricky@example.com --revoke
 */

import mongoose from 'mongoose';
import { User } from '../models/User';

async function main() {
  const args = process.argv.slice(2);
  const emailArg = args.find(a => a.startsWith('--email='));
  const email = emailArg?.split('=')[1];
  const revoke = args.includes('--revoke');

  if (!email) {
    console.error('Usage: npx ts-node -r dotenv/config src/scripts/setAdmin.ts --email=user@example.com');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  user.isAdmin = !revoke;
  await user.save();

  console.log(`${revoke ? 'Revoked' : 'Granted'} admin for ${email} (userId: ${user._id})`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
