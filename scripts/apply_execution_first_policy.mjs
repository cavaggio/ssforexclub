import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function patchFile(relativePath, transform, markers = []) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  const missing = markers.filter((marker) => !after.includes(marker));
  if (missing.length) throw new Error(`${relativePath} missing execution-first markers: ${missing.join(', ')}`);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[EXECUTION_FIRST] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`${label}: source marker not found`);
  return source.replace(before, after);
}

patchFile(
  'server/autoAiWindow.js',
  (source) => {
    let out = source;
    out = out.replace(
      /PPR may submit new orders from 03:00 ET, ICT from\n \* 05:00 ET, and V3 retains its existing 02:15 ET entry start\./,
      'V3, PPR, and ICT may all submit new orders from 02:15 ET. The scanner starts at 02:00 ET so every engine can warm its watch state before execution.',
    );
    out = out.replace(/ppr: Object\.freeze\(\{\n\s*startMin: 180,/, 'ppr: Object.freeze({\n    startMin: 135,');
    out = out.replace(/ict: Object\.freeze\(\{\n\s*startMin: 300,/, 'ict: Object.freeze({\n    startMin: 135,');
    out = out.replace(
      "  const start = normalized === 'ict' ? '05:00' : normalized === 'ppr' ? '03:00' : '02:15';",
      "  const start = '02:15';",
    );
    return out;
  },
  ["ppr: Object.freeze({\n    startMin: 135,", "ict: Object.freeze({\n    startMin: 135,", "const start = '02:15';"],
);

patchFile(
  'server/ictAutoTrade.js',
  (source) => replaceOnce(
    source,
    '{ client, now, autoAi: true },',
    '{ client, now, autoAi: true, authoritativeAnalysis: a },',
    'ICT auto execution snapshot handoff',
  ),
  ['authoritativeAnalysis: a'],
);

patchFile(
  'server/ictExecution.js',
  (source) => {
    let out = source;
    out = replaceOnce(
      out,
      '  getOpen = null,\n} = {}) {',
      '  getOpen = null,\n  authoritativeAnalysis = null,\n} = {}) {',
      'ICT execution authoritative analysis option',
    );
    out = replaceOnce(
      out,
      "  const analyze = getAnalysis || ((p) => defaultGetAnalysis(p, { client, now }));\n  let analysis;\n  try {\n    analysis = await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });\n  } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
      "  const analyze = getAnalysis || ((p) => defaultGetAnalysis(p, { client, now }));\n  let analysis;\n  try {\n    analysis = authoritativeAnalysis || await applyStoredStudyCalibration(await analyze(pair), { client, engine: 'ict' });\n  } catch (err) { return blocked(`ICT recompute failed: ${err.message}`); }",
      'ICT execution snapshot use',
    );
    return out;
  },
  ['authoritativeAnalysis = null', 'analysis = authoritativeAnalysis || await applyStoredStudyCalibration'],
);

patchFile(
  'server/ictTargetConfidence.js',
  (source) => {
    let out = source;
    out = out.replace(
      /  const weighted = \(confluence \* 0\.5\) \+ \(timingScore \* 0\.3\) \+ \(geometryScore \* 0\.2\);\n  const confidence = Math\.round\(clamp\(Math\.min\(\n    weighted,\n    timingScore,\n    geometryScore,\n    confluence,\n  \)\)\);/,
      "  const weighted = (confluence * 0.75) + (geometryScore * 0.25);\n  const confidence = Math.round(clamp(Math.min(weighted, geometryScore, confluence)));",
    );
    out = out.replace("  if (!freshImpulse) blockers.push('no fresh 5M impulse/structure trigger');\n", '');
    out = out.replace("  if (age == null || age > 1) blockers.push(`entry trigger is ${age == null ? 'not timestamped' : `${age} bars old`}`);\n", '');
    out = out.replace("  if (drift > 0.35) blockers.push(`market entry drifted ${drift.toFixed(2)} ATR from the ideal entry`);\n", '');
    out = out.replace("  if (consumed > 0.20) blockers.push(`${Math.round(consumed * 100)}% of the target move was already consumed`);\n", '');
    out = out.replace("  if (!priceInsideEntryZone) blockers.push('current market price is outside the valid entry zone');\n", '');
    out = out.replace("  if (targetAdjusted) blockers.push('nearest natural liquidity target did not provide the minimum R:R');\n", '');
    out = out.replace("    model: 'ict_current_entry_target_before_stop_v1',", "    model: 'ict_current_executable_scalp_v2',");
    return out;
  },
  ['const weighted = (confluence * 0.75) + (geometryScore * 0.25);', "model: 'ict_current_executable_scalp_v2'"],
);

patchFile(
  'server/ictEngine.js',
  (source) => {
    let out = source;
    const removable = [
      "  if (!freshImpulse) hardFails.push('Hard gate: no fresh 5M impulse/structure trigger for a market scalp entry.');\n",
      "  if (entryDriftAtr > 0.35) hardFails.push(`Hard gate: late market entry — price drifted ${entryDriftAtr.toFixed(2)} ATR from the ideal ICT entry.`);\n",
      "  if (rewardConsumedFraction > 0.20) hardFails.push(`Hard gate: late market entry — ${Math.round(rewardConsumedFraction * 100)}% of the target move was already consumed.`);\n",
      "  if (!priceInsideEntryZone) hardFails.push('Hard gate: current market price is outside the valid ICT entry zone.');\n",
      "  if (setup?.targetAdjustedToMinRR) hardFails.push('Hard gate: nearest natural liquidity target does not provide the minimum R:R from the current market entry.');\n",
    ];
    for (const line of removable) out = out.replace(line, '');
    out = out.replace(
      '  // A scalp may qualify only from a CURRENT 5M impulse/structure trigger. Static\n  // location context (FVG/OB/OTE) can add confluence but cannot independently\n  // authorize a market order after the move has already happened.',
      '  // Timing diagnostics remain visible but do not veto a valid current-price scalp.\n  // The order decision is current direction plus executable SL/TP geometry.',
    );
    return out;
  },
  ['Timing diagnostics remain visible but do not veto a valid current-price scalp.'],
);

patchFile(
  'web/app/api/cron/auto-ai-trading-extended/route.ts',
  (source) => {
    let out = source;
    out = replaceOnce(
      out,
      `    const configuredEngine = normalizeEngine(row.auto_ai_engine);\n    const selectedEngine = scanMode === 'daily_study' && engineFilter\n      ? engineFilter\n      : configuredEngine;\n    if (scanMode !== 'daily_study' && engineFilter && configuredEngine !== engineFilter) continue;\n    enabledEngines.add(selectedEngine);`,
      `    const configuredEngine = normalizeEngine(row.auto_ai_engine);\n    const selectedEngines: AutoAiEngine[] = scanMode === 'daily_study' && engineFilter\n      ? [engineFilter]\n      : engineFilter\n        ? [engineFilter]\n        : [...AUTO_AI_ENGINES];\n    const selectedEngine = selectedEngines[0] ?? configuredEngine;\n    enabledEngines.add(selectedEngine);`,
      'all-engine route selection',
    );
    out = replaceOnce(
      out,
      `      const result = await callInternalEndpoint('/api/internal/oanda/auto', {`,
      `      for (const selectedEngine of selectedEngines) {\n        enabledEngines.add(selectedEngine);\n\n      const result = await callInternalEndpoint('/api/internal/oanda/auto', {`,
      'all-engine route loop start',
    );
    out = replaceOnce(
      out,
      `        result: payload,\n      });\n    } catch (err) {`,
      `        result: payload,\n      });\n      }\n    } catch (err) {`,
      'all-engine route loop end',
    );
    out = out.replaceAll('selectedEngineOnly=true', 'allEnginesActive=true');
    out = out.replaceAll('selected-engine run', 'all-engine run');
    out = out.replaceAll("'selected_engine_only'", "'all_enabled_engines'");
    out = out.replace(
      "executionWindow: 'V3 02:15, PPR 03:00, ICT 05:00 through 10:00 America/New_York, Monday-Friday',",
      "executionWindow: 'V3/PPR/ICT 02:15-10:00 America/New_York, Monday-Friday',",
    );
    return out;
  },
  [
    'const selectedEngines: AutoAiEngine[]',
    'for (const selectedEngine of selectedEngines)',
    'allEnginesActive=true',
    "executionMode: 'all_enabled_engines'",
    "executionWindow: 'V3/PPR/ICT 02:15-10:00 America/New_York, Monday-Friday'",
  ],
);

console.log('[EXECUTION_FIRST] current-price scalp execution policy applied');
