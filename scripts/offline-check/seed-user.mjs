// Creates (or resets) one email-verified test account in the throwaway
// database. Reads DB_* from the environment, falling back to the repo `.env`
// for the password only. Nothing here is a real secret.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

export const TEST_EMAIL = 'offline-check@example.test';
export const TEST_PASSWORD = 'offline-check-password-1';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const dbName = required('DB_NAME');
if (!dbName.includes('offline_check')) {
  throw new Error(`Refusing to seed "${dbName}": the database name must contain "offline_check".`);
}

const client = new pg.Client({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  password: required('DB_PASSWORD'),
  database: dbName,
});
await client.connect();
try {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  await client.query(
    `INSERT INTO users (email, password_hash, email_verified_at)
     VALUES ($1, $2, now())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, email_verified_at = now()`,
    [TEST_EMAIL, hash],
  );
  const { rows } = await client.query('SELECT id, email, email_verified_at FROM users WHERE email = $1', [TEST_EMAIL]);
  console.log('seeded', JSON.stringify(rows[0]));
} finally {
  await client.end();
}
