import { readEnv } from './config/supabase.js';

try {
  const config = readEnv();
  const { default: app } = await import('./app.js');
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log('Daily Habit Tracker API listening on port ' + config.PORT + '.');
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.on('error', (error) => {
    console.error('Server failed to start (' + (error.code ?? 'UNKNOWN') + ').');
    process.exit(1);
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10_000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      process.exitCode = 0;
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
