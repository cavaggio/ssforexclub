import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schedulerPath = path.join(here, '..', 'server', 'ictAutoScheduler.js');
let source = fs.readFileSync(schedulerPath, 'utf8');

const oldWindow = `  if (!inMorningMarketStudyWindow(now)) {\n    return { ok: true, skipped: true, reason: 'outside_morning_market_study_window' };\n  }`;
const catchupWindow = `  // A missed 02:00 run must recover during the live scan window. This is especially\n  // important for FTMO accounts, whose analysis uses a validated OANDA connection\n  // while MT5 remains the only execution transport.\n  if (!inMorningMarketStudyWindow(now) && !inAutoAiWindow(now)) {\n    return { ok: true, skipped: true, reason: 'outside_morning_market_study_and_recovery_window' };\n  }`;
if (!source.includes(catchupWindow)) {
  if (!source.includes(oldWindow)) throw new Error('Morning study window anchor not found');
  source = source.replace(oldWindow, catchupWindow);
}

const morningAnchor = `    results.push(await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {\n      source: 'morning-market-study', runId, scanMode: 'daily_study', pairs: [], engine,\n    }, \`[MORNING_STUDY][\${engine.toUpperCase()}][runId=\${runId}]\`));`;
const morningFtmoCall = `    results.push(await post(nextUrl, secret, '/api/cron/ftmo-market-study', {\n      source: 'morning-market-study', runId, engine,\n    }, \`[MORNING_STUDY][FTMO][\${engine.toUpperCase()}][runId=\${runId}]\`));`;
if (!source.includes(morningFtmoCall)) {
  if (!source.includes(morningAnchor)) throw new Error('Morning study call anchor not found');
  source = source.replace(morningAnchor, `${morningAnchor}\n${morningFtmoCall}`);
}

const endOfDayAnchor = `    results.push(await post(nextUrl, secret, '/api/cron/auto-ai-trading-extended', {\n      source: 'end-of-day-market-review', runId, scanMode: 'daily_study', pairs: [], engine,\n    }, \`[END_OF_DAY_STUDY][\${engine.toUpperCase()}][runId=\${runId}]\`));`;
const endOfDayFtmoCall = `    results.push(await post(nextUrl, secret, '/api/cron/ftmo-market-study', {\n      source: 'end-of-day-market-review', runId, engine,\n    }, \`[END_OF_DAY_STUDY][FTMO][\${engine.toUpperCase()}][runId=\${runId}]\`));`;
if (!source.includes(endOfDayFtmoCall)) {
  if (!source.includes(endOfDayAnchor)) throw new Error('End-of-day study call anchor not found');
  source = source.replace(endOfDayAnchor, `${endOfDayAnchor}\n${endOfDayFtmoCall}`);
}

const oldLog = '`[AUTO_AI] morningStudy=02:00_ET endOfDayReview=17:30_ET scans=02:30–10:30_ET entries=02:30–10:30_ET weekdays_only ` +';
const newLog = '`[AUTO_AI] morningStudy=02:00_ET catchup=until_10:30_ET endOfDayReview=17:30_ET scans=02:30–10:30_ET entries=02:30–10:30_ET weekdays_only ` +';
if (source.includes(oldLog)) source = source.replace(oldLog, newLog);

fs.writeFileSync(schedulerPath, source);
console.log('[FTMO_MARKET_STUDY_RECOVERY] scheduler patch applied');
