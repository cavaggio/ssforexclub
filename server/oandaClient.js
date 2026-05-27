/**
 * server/oandaClient.js
 * Core OANDA v20 REST API HTTP helpers.
 * All OANDA communication flows through these functions.
 */

export function getOandaBaseUrl() {
  const env = process.env.OANDA_ENV || 'practice';
  if (env === 'live') {
    return process.env.OANDA_API_BASE_LIVE || 'https://api-fxtrade.oanda.com';
  }
  return process.env.OANDA_API_BASE_PRACTICE || 'https://api-fxpractice.oanda.com';
}

export function oandaHeaders() {
  const apiKey = process.env.OANDA_API_KEY || '';
  if (!apiKey) {
    throw new Error('OANDA_API_KEY is not set in environment variables.');
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept-Datetime-Format': 'UNIX',
  };
}

export function getAccountId() {
  const id = process.env.OANDA_ACCOUNT_ID || '';
  if (!id) {
    throw new Error('OANDA_ACCOUNT_ID is not set in environment variables.');
  }
  return id;
}

export async function oandaGet(path) {
  const base = getOandaBaseUrl();
  const url = `${base}${path}`;
  console.log(`[OANDA] GET ${url}`);
  const res = await fetch(url, { headers: oandaHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OANDA GET ${path} → [${res.status}]: ${text}`);
  }
  return res.json();
}

export async function oandaPost(path, body) {
  const base = getOandaBaseUrl();
  const url = `${base}${path}`;
  console.log(`[OANDA] POST ${url}`, JSON.stringify(body));
  const res = await fetch(url, {
    method: 'POST',
    headers: oandaHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`OANDA POST ${path} → [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function oandaPut(path, body) {
  const base = getOandaBaseUrl();
  const url = `${base}${path}`;
  console.log(`[OANDA] PUT ${url}`, JSON.stringify(body));
  const res = await fetch(url, {
    method: 'PUT',
    headers: oandaHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`OANDA PUT ${path} → [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}
