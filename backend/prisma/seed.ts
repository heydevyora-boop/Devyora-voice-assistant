/**
 * Development seed.
 *
 * Creates one account with a little content so the API can be exercised
 * locally. It refuses to run against staging or production, and it never
 * drops or truncates anything — it upserts, so running it twice is safe.
 *
 * The password here is a placeholder for local use. Chunk 3 introduces real
 * password hashing; until then this field simply holds a marker so the row
 * is well-formed.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_EMAIL = 'dev@devyora.local';

async function main(): Promise<void> {
  const env = process.env.NODE_ENV ?? 'development';
  if (env === 'production' || env === 'staging') {
    throw new Error(`Refusing to seed a ${env} database.`);
  }

  const user = await prisma.user.upsert({
    where: { email: SEED_EMAIL },
    update: {},
    create: {
      email: SEED_EMAIL,
      // Not a usable credential. Replaced by a real Argon2 hash in Chunk 3.
      passwordHash: 'seed-placeholder-not-a-valid-hash',
      displayName: 'Local Developer',
      preference: {
        create: {
          assistant: { speakReplies: true, confirmTimeoutSeconds: 90 },
          voice: { sttChoice: 'browser', language: 'en-IN' },
          appearance: { paletteId: 'cyan-violet', shape: 'circle', size: 72 },
          privacy: { retainAudio: false },
        },
      },
    },
    include: { preference: true },
  });

  await prisma.device.upsert({
    where: { publicId: 'seed-device-web' },
    update: { lastSeenAt: new Date() },
    create: {
      userId: user.id,
      publicId: 'seed-device-web',
      platform: 'WEB',
      name: 'Local browser',
      wakeWordCapable: false,
      lastSeenAt: new Date(),
    },
  });

  await prisma.note.upsert({
    where: { userId_clientId: { userId: user.id, clientId: 'seed-note-1' } },
    update: {},
    create: { userId: user.id, clientId: 'seed-note-1', text: 'Buy oat milk' },
  });

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.reminder.upsert({
    where: { userId_clientId: { userId: user.id, clientId: 'seed-reminder-1' } },
    update: {},
    create: {
      userId: user.id,
      clientId: 'seed-reminder-1',
      text: 'Call mum',
      dueAt: tomorrow,
      timezone: 'Asia/Kolkata',
    },
  });

  console.log(`Seeded ${SEED_EMAIL} (${user.id})`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
