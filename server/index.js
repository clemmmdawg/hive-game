// index.js — Process entry point: `npm start` / `node server/index.js [port | --port N]`.
// Kept apart from server.js so that module stays import-safe (tests) and starts the same way
// through symlinked checkouts, where an "am I the main module" guard silently does nothing.

import { createHiveServer } from './server.js';

function readPort(args, envPort) {
  const flagIndex = args.findIndex(arg => arg === '--port' || arg === '-p');
  const raw = flagIndex >= 0 ? args[flagIndex + 1] : args[0] ?? envPort ?? '3000';
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`Invalid port: ${raw}. Use an integer from 1 to 65535.`);
    process.exit(1);
  }

  return port;
}

const PORT = readPort(process.argv.slice(2), process.env.PORT);
const { httpServer } = createHiveServer();
httpServer.listen(PORT, () => {
  console.log(`HIVE server listening on http://localhost:${PORT}`);
});
