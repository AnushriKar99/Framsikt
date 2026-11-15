// Wires the service once per server process. Swap the chat/HR adapters here for real ones.
import { DEMO_USERS, FX_RATES, OFFICES } from './snackbot/config.js';
import { ConsoleChat, FakeHR, FixedRates, systemClock } from './snackbot/fakes.js';
import { MemoryStore } from './snackbot/memoryStore.js';
import { createService } from './snackbot/service.js';

export async function getService() {
  if (!globalThis.__snack) {
    let store;
    if (process.env.DATABASE_URL) {               // pg is only loaded when a database is configured
      const { PgStore } = await import('./snackbot/pgStore.js');
      store = new PgStore(process.env.DATABASE_URL);
    } else {
      store = new MemoryStore({ users: DEMO_USERS });
    }
    globalThis.__snack = createService({
      store, offices: OFFICES, clock: systemClock, rates: new FixedRates(FX_RATES),
      chat: new ConsoleChat(),                    // <- real chat-tool adapter goes here
      hr: new FakeHR(systemClock, 3),             // <- real HR adapter goes here
    });
  }
  return globalThis.__snack;
}
