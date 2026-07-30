import fs from 'fs';

function patchFile(path, transform) {
  const original = fs.readFileSync(path, 'utf8');
  const updated = transform(original);
  if (updated !== original) fs.writeFileSync(path, updated);
}

patchFile('server/index.js', (source) => {
  let updated = source;
  if (!updated.includes("import ftmoIndicesRouter from './ftmoIndicesRouter.js';")) {
    const anchor = "import { PROVIDERS, assertExecutionProvider } from './providerRouting.js';";
    updated = updated.replace(anchor, `${anchor}\nimport ftmoIndicesRouter from './ftmoIndicesRouter.js';`);
  }
  if (!updated.includes("app.use('/api/indices', ftmoIndicesRouter);")) {
    const anchor = "app.use('/api/alpaca', alpacaAssets);";
    updated = updated.replace(anchor, `${anchor}\napp.use('/api/indices', ftmoIndicesRouter);`);
  }
  return updated;
});
