// `npm start` / `npm run facilitator`: env-configured facilitator process.
import { createFacilitator, loadConfigFromEnv } from './index.js';

async function main(): Promise<void> {
  let facilitator: ReturnType<typeof createFacilitator>;
  try {
    facilitator = createFacilitator(loadConfigFromEnv());
    await facilitator.start();
  } catch (err) {
    console.error(`facilitator: startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`facilitator: ${signal} received, stopping`);
    facilitator
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`facilitator: stop failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
