import { eq } from 'drizzle-orm';
import { db } from '../config/database';
import { users } from '../models/schema';

const adminEmail = process.env.ADMIN_EMAIL;

if (!adminEmail) {
  console.error('Please set ADMIN_EMAIL environment variable');
  console.error('Usage: ADMIN_EMAIL=your@email.com npm run admin:create');
  process.exit(1);
}

async function createAdmin() {
  try {
    const [user] = await db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.email, adminEmail!))
      .returning();

    if (user) {
      console.log(`✓ User ${user.email} (${user.username}) promoted to admin`);
      process.exit(0);
    } else {
      console.error(`✗ User with email ${adminEmail} not found`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error promoting user to admin:', error);
    process.exit(1);
  }
}

createAdmin();
