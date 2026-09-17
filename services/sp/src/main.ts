// `npm start` / `npm run sp`: env-configured Settlement Processor process.
import { createSP, loadConfigFromEnv } from './index.js';

async function main(): Promise<void> {
  let sp: ReturnType<typeof createSP>;
  try {
    sp = createSP(loadConfigFromEnv());
    await sp.start();
  } catch (err) {
    console.error(`sp: startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`sp: ${signal} received, stopping`);
    sp.stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`sp: stop failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
