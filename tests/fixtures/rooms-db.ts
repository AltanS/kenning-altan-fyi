/**
 * The shared state the room integration cases touch, and how it is put back.
 *
 * NO LIVE API IS REACHABLE. `registry.withProvider` installs a fake port, and
 * the provider keys set here are dummies that exist only so the registry's
 * configuration check passes.
 *
 * THE DAILY BUDGET ROW IS SHARED, so it is photographed before a file runs and
 * written back afterwards, the way `translation-corpus.ts` does it.
 */

import { eq } from 'drizzle-orm';

import { utcDay } from '../../app/lib/abuse/budget.server';
import { registry, type LlmPort } from '../../app/lib/llm/registry.server';
import { dailyBudget } from '../../drizzle/schema';
import { getRawDb, poolInitialized } from '../../drizzle/db';

const KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const DUMMY_KEY = 'stub-key-not-a-real-credential';

export interface RoomsEnvironment {
  /** Put the provider, the environment and today's budget row back. */
  restore: () => Promise<void>;
}

export interface RoomsEnvironmentParams {
  port: LlmPort;
}

export async function setUpRoomsEnvironment({ port }: RoomsEnvironmentParams): Promise<RoomsEnvironment> {
  await poolInitialized;
  const db = getRawDb();

  const savedKeys = new Map(KEY_VARS.map((name) => [name, process.env[name]]));
  for (const name of KEY_VARS) process.env[name] = DUMMY_KEY;
  // A budget alert posts to this webhook. A test must not be able to page anybody.
  const savedWebhook = process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_WEBHOOK_URL;
  registry.withProvider(port);

  const day = utcDay(new Date());
  const [before] = await db.select().from(dailyBudget).where(eq(dailyBudget.day, day));
  // Every case starts from an unspent day, whatever the developer spent today.
  await db.delete(dailyBudget).where(eq(dailyBudget.day, day));

  return {
    restore: async () => {
      registry.withProvider(null);
      for (const [name, value] of savedKeys) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (savedWebhook !== undefined) process.env.ALERT_WEBHOOK_URL = savedWebhook;
      await db.delete(dailyBudget).where(eq(dailyBudget.day, day));
      if (before !== undefined) await db.insert(dailyBudget).values(before);
    },
  };
}
