import { createBabcordServer } from './app.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig();
if (config.secretIsEphemeral) {
  console.error('BABCORD_SECRET is not configured. Sessions and recovery codes will not survive a restart. Refusing to start.');
  process.exitCode = 1;
} else {
  const app = await createBabcordServer(config);
  if (!app.seed.owner) {
    console.error('No platform owner exists. Set BABCORD_ADMIN_USERNAME and BABCORD_ADMIN_PASSWORD before the first startup.');
    await app.stop();
    process.exitCode = 1;
  } else {
    if (app.seed.recoveryCodes) console.log('Platform owner created. Sign in with the bootstrap password and regenerate recovery codes from account settings.');
    const address = await app.start();
    console.log(`Babcord is listening on http://${address.address}:${address.port}`);

    let shuttingDown = false;
    async function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received; closing Babcord cleanly...`);
      const fallback = setTimeout(() => process.exit(1), 10_000);
      fallback.unref();
      try {
        await app.stop();
        clearTimeout(fallback);
        process.exit(0);
      } catch (error) {
        console.error('Shutdown failed:', error);
        process.exit(1);
      }
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}
