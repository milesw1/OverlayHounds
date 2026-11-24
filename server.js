import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const BLOCKED_PATHS = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
]);

app.use((req, res, next) => {
  const normalized = path.posix.normalize(req.path);
  if (
    BLOCKED_PATHS.has(normalized) ||
    normalized.startsWith('/node_modules') ||
    normalized.split('/').some((seg) => seg.startsWith('.'))
  ) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(
  express.static(__dirname, {
    dotfiles: 'ignore',
    index: 'index.html',
  })
);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
