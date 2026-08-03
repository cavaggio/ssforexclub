import fs from 'node:fs';

function patchFile(path, transform) {
  const original = fs.readFileSync(path, 'utf8');
  const updated = transform(original);
  if (updated !== original) fs.writeFileSync(path, updated);
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(oldText)) return source.replace(oldText, newText);
  if (source.includes(newText)) return source;
  throw new Error(`ICT analysis instrument UI patch failed: ${label}`);
}

patchFile('types/ict.ts', (source) => {
  const oldText = `export interface IctAnalysis {\n  pair: string;\n  timestamp: string;`;
  const newText = `export interface IctAnalysis {\n  pair: string;\n  displaySymbol?: string;\n  assetClass?: 'forex' | 'metal' | 'index' | string;\n  marketDataSource?: string;\n  marketDataProxySymbol?: string | null;\n  executionEligible?: boolean;\n  pricePrecision?: number;\n  timestamp: string;`;
  return replaceOnce(source, oldText, newText, 'ICT analysis type anchor not found');
});

patchFile('components/ict-intelligence-panel.tsx', (source) => {
  let updated = source;

  updated = replaceOnce(
    updated,
    'ICT-first market read — liquidity, displacement, MSS/CHoCH, PD arrays, killzones. Manual execution only when enabled; never auto-trades.',
    'ICT-first market read — now including XAU/USD, US30 and US500 signal analysis. Gold and index cards are signal-only and cannot execute through OANDA.',
    'ICT panel subtitle anchor not found',
  );

  updated = replaceOnce(
    updated,
    "  const dp = a.pair.includes('JPY') ? 3 : a.pair.startsWith('XA') ? 2 : 5;",
    "  const dp = Number.isInteger(a.pricePrecision) ? Number(a.pricePrecision) : a.pair.includes('JPY') ? 3 : a.pair.startsWith('XA') ? 2 : 5;",
    'ICT price precision anchor not found',
  );

  updated = replaceOnce(
    updated,
    "  const showExecute = a.signal !== 'none' && canExecute;",
    "  const showExecute = a.signal !== 'none' && canExecute && a.executionEligible !== false;",
    'ICT execute visibility anchor not found',
  );

  updated = replaceOnce(
    updated,
    "      `Execute ${isPaper ? 'PAPER' : 'LIVE'} ICT ${dir.toUpperCase()} on ${a.pair}?\\n` +",
    "      `Execute ${isPaper ? 'PAPER' : 'LIVE'} ICT ${dir.toUpperCase()} on ${a.displaySymbol || a.pair}?\\n` +",
    'ICT confirmation symbol anchor not found',
  );

  updated = replaceOnce(
    updated,
    "        <span style={{ fontFamily: 'var(--mono, monospace)', fontWeight: 800, fontSize: 18 }}>{a.pair}</span>\n        <Chip label=\"Bias\"",
    "        <span style={{ fontFamily: 'var(--mono, monospace)', fontWeight: 800, fontSize: 18 }}>{a.displaySymbol || a.pair}</span>\n        {a.executionEligible === false && <Chip label=\"Mode\" value=\"SIGNAL ONLY\" tone=\"info\" />}\n        {a.marketDataSource && <Chip label=\"Data\" value={a.marketDataSource} tone=\"muted\" />}\n        <Chip label=\"Bias\"",
    'ICT card header anchor not found',
  );

  return updated;
});

console.log('ICT Intelligence UI patched for XAU/USD, US30 and US500 signal-only cards');
