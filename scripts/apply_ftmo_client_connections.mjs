import fs from 'fs';

function patchFile(path, transform) {
  const original = fs.readFileSync(path, 'utf8');
  const updated = transform(original);
  if (updated !== original) fs.writeFileSync(path, updated);
}

patchFile('src/App.tsx', (source) => {
  let updated = source;
  if (!updated.includes("import { FtmoConnectionTab } from './components/FtmoConnectionTab';")) {
    const anchor = "import ForexSignalStackTab from './components/ForexSignalStackTab';";
    updated = updated.replace(anchor, `${anchor}\nimport { FtmoConnectionTab } from './components/FtmoConnectionTab';`);
  }
  updated = updated.replace(
    'const TABS=["Dashboard","Signals","Institutions","GEX+ETF","Playbook","Risk","AI-Fidelity","AI-Alpaca","💹 Forex"];',
    'const TABS=["Dashboard","Signals","Institutions","GEX+ETF","Playbook","Risk","AI-Fidelity","AI-Alpaca","💹 Forex","FTMO"];',
  );
  if (!updated.includes('activeTab==="FTMO"')) {
    const anchor = '      {activeTab==="AI-Fidelity"&&<div className="fade-in"';
    updated = updated.replace(anchor, `      {activeTab==="FTMO" && (\n        <div className="fade-in">\n          <FtmoConnectionTab />\n        </div>\n      )}\n${anchor}`);
  }
  return updated;
});

patchFile('server/index.js', (source) => {
  let updated = source;
  if (!updated.includes("from './ftmoConnectionStore.js'")) {
    const anchor = "import { buildFtmoClient, validateFtmoCredentials } from './ftmoClient.js';";
    updated = updated.replace(anchor, `${anchor}\nimport { getFtmoConnection, saveFtmoConnection, testFtmoConnection, deleteFtmoConnection } from './ftmoConnectionStore.js';`);
  }

  updated = updated.replace(
    "app.use('/api/indices', ftmoIndicesRouter);",
    "app.use('/api/indices', authenticateToken, ftmoIndicesRouter);",
  );

  if (!updated.includes("app.get('/api/ftmo/connection'")) {
    const anchor = "app.post('/api/alpaca/credentials', authenticateToken, async (req, res) => {";
    const routes = `app.get('/api/ftmo/connection', authenticateToken, async (req, res) => {\n  try {\n    const connection = await getFtmoConnection(req.user.userId);\n    res.json({ ok: true, connection });\n  } catch (error) {\n    console.error('[FTMO CONNECTION GET ERROR]', error);\n    res.status(500).json({ ok: false, error: error?.message || String(error) });\n  }\n});\n\napp.put('/api/ftmo/connection', authenticateToken, async (req, res) => {\n  try {\n    const connection = await saveFtmoConnection(req.user.userId, req.body || {});\n    res.json({ ok: true, connection });\n  } catch (error) {\n    console.error('[FTMO CONNECTION SAVE ERROR]', error);\n    res.status(400).json({ ok: false, error: error?.message || String(error), missing: error?.missing || [] });\n  }\n});\n\napp.post('/api/ftmo/connection/test', authenticateToken, async (req, res) => {\n  try {\n    const connection = await testFtmoConnection(req.user.userId);\n    res.status(connection.ok ? 200 : 409).json({ ok: connection.ok, connection });\n  } catch (error) {\n    console.error('[FTMO CONNECTION TEST ERROR]', error);\n    res.status(400).json({ ok: false, error: error?.message || String(error) });\n  }\n});\n\napp.delete('/api/ftmo/connection', authenticateToken, async (req, res) => {\n  try {\n    const result = await deleteFtmoConnection(req.user.userId);\n    res.json({ ok: true, ...result });\n  } catch (error) {\n    console.error('[FTMO CONNECTION DELETE ERROR]', error);\n    res.status(500).json({ ok: false, error: error?.message || String(error) });\n  }\n});\n\n`;
    updated = updated.replace(anchor, `${routes}${anchor}`);
  }
  return updated;
});
