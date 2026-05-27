import { useState, useEffect, useRef, useCallback } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import React from 'react';
import { AIAlpacaTab } from './components/AIAlpacaTab';
import ForexSignalStackTab from './components/ForexSignalStackTab';
import { alpacaUniverse, FALLBACK_UNIVERSE, type BatchState, type UniverseSource } from './lib/alpacaUniverse';
import generateAlpacaAISignals from './lib/signalEngine';
import './App.css';

const INSTITUTIONS = {
  assetManagers: [
    { name:"BlackRock",aum:"$10.0T",bias:"BULLISH",change:"+$4.2B",top:"SPY, NVDA, AAPL, MSFT",flow:5,color:"#0ea5e9" },
    { name:"Vanguard",aum:"$8.1T",bias:"BULLISH",change:"+$2.9B",top:"VTI, AAPL, MSFT, GOOGL",flow:4,color:"#0ea5e9" },
    { name:"Fidelity Investments",aum:"$4.9T",bias:"BULLISH",change:"+$1.7B",top:"QQQ, NVDA, META, AMZN",flow:4,color:"#10b981" },
    { name:"State Street Global Adv.",aum:"$4.1T",bias:"NEUTRAL",change:"+$0.4B",top:"SPY, GLD, XLF, XLK",flow:3,color:"#f59e0b" },
  ],
  hedgeFunds: [
    { name:"Citadel LLC",aum:"$63B",bias:"BULLISH",change:"+$2.1B",top:"NVDA, AAPL, MSFT, SPY",flow:5,color:"#8b5cf6" },
    { name:"Bridgewater Associates",aum:"$124B",bias:"NEUTRAL",change:"-$0.8B",top:"GLD, SPY, TLT, EEM",flow:2,color:"#f59e0b" },
    { name:"Renaissance Technologies",aum:"$130B",bias:"BULLISH",change:"+$1.4B",top:"ALGO-QUANT BASKET",flow:5,color:"#a855f7" },
    { name:"Point72",aum:"$36B",bias:"BULLISH",change:"+$0.9B",top:"META, AMZN, GOOGL, MSFT",flow:4,color:"#8b5cf6" },
  ],
  marketMakers: [
    { name:"Citadel Securities",aum:"N/A",bias:"NEUTRAL",change:"NEUTRAL",top:"SPY, QQQ, IWM (MM)",flow:3,color:"#10b981" },
    { name:"Virtu Financial",aum:"N/A",bias:"BULLISH",change:"+FLOW",top:"High-freq equity basket",flow:4,color:"#0ea5e9" },
    { name:"Jane Street",aum:"N/A",bias:"BULLISH",change:"+$0.7B",top:"ETF arb + options book",flow:5,color:"#10b981" },
  ],
  darkPoolInst: [
    { name:"Goldman Sachs",aum:"$2.8T",bias:"BULLISH",change:"+$1.8B",top:"GS, NVDA, SPY, XLF",flow:5,color:"#8b5cf6" },
    { name:"Morgan Stanley",aum:"$1.5T",bias:"BULLISH",change:"+$1.1B",top:"MS, AAPL, MSFT, META",flow:4,color:"#0ea5e9" },
    { name:"JPMorgan Chase",aum:"$3.4T",bias:"BULLISH",change:"+$2.3B",top:"JPM, AMZN, GOOGL, SPY",flow:5,color:"#10b981" },
    { name:"Two Sigma",aum:"$60B",bias:"BULLISH",change:"+$1.3B",top:"QUANT MODEL DRIVEN",flow:5,color:"#a855f7" },
    { name:"D.E. Shaw & Co.",aum:"$60B",bias:"NEUTRAL",change:"-$0.3B",top:"MULTI-STRAT BASKET",flow:3,color:"#f59e0b" },
  ],
};

const OPTIONS_FLOW_DAY = [
  { id:1,ticker:"NVDA",type:"CALL",strike:900,expiry:"04/26",premium:4.2,size:3840,sweep:true,time:"09:34",institution:"Citadel LLC",category:"Hedge Fund" },
  { id:2,ticker:"AAPL",type:"CALL",strike:195,expiry:"05/03",premium:2.8,size:2100,sweep:true,time:"09:41",institution:"Renaissance",category:"Hedge Fund" },
  { id:3,ticker:"SPY",type:"PUT",strike:515,expiry:"04/26",premium:1.9,size:5500,sweep:false,time:"09:47",institution:"Bridgewater",category:"Hedge Fund" },
  { id:4,ticker:"META",type:"CALL",strike:520,expiry:"05/17",premium:6.1,size:1200,sweep:true,time:"09:52",institution:"Point72",category:"Hedge Fund" },
  { id:5,ticker:"TSLA",type:"PUT",strike:165,expiry:"04/26",premium:3.4,size:4200,sweep:false,time:"09:58",institution:"D.E. Shaw",category:"Quant Fund" },
  { id:6,ticker:"AMD",type:"CALL",strike:175,expiry:"05/03",premium:2.2,size:3300,sweep:true,time:"10:03",institution:"Virtu Financial",category:"Market Maker" },
  { id:7,ticker:"MSFT",type:"CALL",strike:420,expiry:"05/17",premium:5.7,size:980,sweep:false,time:"10:11",institution:"Jane Street",category:"Market Maker" },
  { id:8,ticker:"GS",type:"CALL",strike:490,expiry:"05/03",premium:8.4,size:620,sweep:true,time:"10:18",institution:"Goldman Sachs",category:"Inv. Bank" },
  { id:9,ticker:"JPM",type:"CALL",strike:220,expiry:"05/17",premium:3.1,size:1800,sweep:true,time:"10:24",institution:"JPMorgan Chase",category:"Inv. Bank" },
  { id:10,ticker:"QQQ",type:"CALL",strike:460,expiry:"05/03",premium:2.6,size:8800,sweep:true,time:"10:31",institution:"BlackRock",category:"Asset Manager" },
];
const OPTIONS_FLOW_SWING = [
  { id:1,ticker:"AAPL",type:"CALL",strike:200,expiry:"06/20",premium:5.8,size:2400,sweep:true,time:"Mon",institution:"BlackRock",category:"Asset Manager" },
  { id:2,ticker:"MSFT",type:"CALL",strike:440,expiry:"07/18",premium:9.2,size:1100,sweep:true,time:"Mon",institution:"Vanguard",category:"Asset Manager" },
  { id:3,ticker:"SPY",type:"CALL",strike:540,expiry:"06/20",premium:4.1,size:6800,sweep:false,time:"Tue",institution:"State Street",category:"Asset Manager" },
  { id:4,ticker:"NVDA",type:"CALL",strike:1000,expiry:"07/18",premium:12.4,size:890,sweep:true,time:"Tue",institution:"Citadel LLC",category:"Hedge Fund" },
  { id:5,ticker:"AMZN",type:"CALL",strike:200,expiry:"06/20",premium:6.7,size:1500,sweep:true,time:"Wed",institution:"Two Sigma",category:"Quant Fund" },
  { id:6,ticker:"GS",type:"PUT",strike:460,expiry:"06/20",premium:7.3,size:720,sweep:false,time:"Wed",institution:"Goldman Sachs",category:"Inv. Bank" },
  { id:7,ticker:"BAC",type:"CALL",strike:42,expiry:"07/18",premium:1.4,size:8200,sweep:true,time:"Thu",institution:"JPMorgan Chase",category:"Inv. Bank" },
];

const DARK_POOL_DAY = [
  { ticker:"NVDA",level:872.50,size:"$284M",type:"ACCUMULATION",strength:94,prints:12,avgSize:"$23.7M",time:"09:45",institution:"Goldman Sachs" },
  { ticker:"AAPL",level:186.20,size:"$197M",type:"ACCUMULATION",strength:87,prints:8,avgSize:"$24.6M",time:"10:02",institution:"Morgan Stanley" },
  { ticker:"META",level:498.40,size:"$156M",type:"ACCUMULATION",strength:79,prints:6,avgSize:"$26.0M",time:"10:17",institution:"Two Sigma" },
  { ticker:"SPY",level:518.00,size:"$412M",type:"DISTRIBUTION",strength:71,prints:18,avgSize:"$22.9M",time:"09:52",institution:"D.E. Shaw" },
  { ticker:"AMD",level:162.80,size:"$98M",type:"ACCUMULATION",strength:83,prints:5,avgSize:"$19.6M",time:"10:31",institution:"JPMorgan Chase" },
];
const DARK_POOL_SWING = [
  { ticker:"AAPL",level:182.50,size:"$892M",type:"ACCUMULATION",strength:91,prints:47,avgSize:"$19.0M",time:"3d ago",institution:"BlackRock" },
  { ticker:"MSFT",level:408.00,size:"$741M",type:"ACCUMULATION",strength:88,prints:38,avgSize:"$19.5M",time:"2d ago",institution:"Vanguard" },
  { ticker:"NVDA",level:855.00,size:"$1.1B",type:"ACCUMULATION",strength:96,prints:62,avgSize:"$17.7M",time:"4d ago",institution:"Goldman Sachs" },
  { ticker:"SPY",level:511.00,size:"$2.4B",type:"ACCUMULATION",strength:82,prints:94,avgSize:"$25.5M",time:"5d ago",institution:"JPMorgan Chase" },
];

const ETF_FLOWS = [
  { etf:"SPY",name:"S&P 500 ETF",flow:"+$4.2B",dir:"IN",pct:82,change:"+12%",bias:"BULLISH" },
  { etf:"QQQ",name:"Nasdaq 100 ETF",flow:"+$2.8B",dir:"IN",pct:74,change:"+8%",bias:"BULLISH" },
  { etf:"IWM",name:"Russell 2000 ETF",flow:"-$0.6B",dir:"OUT",pct:31,change:"-14%",bias:"BEARISH" },
  { etf:"GLD",name:"Gold ETF",flow:"+$1.1B",dir:"IN",pct:68,change:"+22%",bias:"NEUTRAL" },
  { etf:"TLT",name:"20yr Treasury ETF",flow:"-$0.9B",dir:"OUT",pct:28,change:"-7%",bias:"BEARISH" },
  { etf:"XLF",name:"Financials ETF",flow:"+$1.4B",dir:"IN",pct:71,change:"+18%",bias:"BULLISH" },
  { etf:"XLK",name:"Technology ETF",flow:"+$1.9B",dir:"IN",pct:79,change:"+11%",bias:"BULLISH" },
];

const GEX_DATA = [
  { label:"500",gex:-2.1 },{ label:"505",gex:-1.4 },{ label:"510",gex:-0.8 },
  { label:"515",gex:0.4 },{ label:"518★",gex:1.2,spot:true },{ label:"520",gex:2.8 },
  { label:"522",gex:1.9 },{ label:"525",gex:0.9 },{ label:"530",gex:-0.3 },{ label:"535",gex:-1.7 },
];

const FLOW_PREMIUM = [
  {h:"9:30",calls:12,puts:5},{h:"10:00",calls:18,puts:8},{h:"10:30",calls:22,puts:11},
  {h:"11:00",calls:19,puts:14},{h:"12:00",calls:20,puts:16},{h:"1:00",calls:28,puts:9},
  {h:"2:00",calls:29,puts:13},{h:"3:00",calls:38,puts:7},
];
const SWING_WEEKLY_FLOW = [
  {day:"Mon",calls:84,puts:31},{day:"Tue",calls:97,puts:44},
  {day:"Wed",calls:112,puts:58},{day:"Thu",calls:89,puts:29},{day:"Fri",calls:143,puts:37},
];

const NEWS_CORPUS = [
  { ticker:"NVDA",headline:"NVIDIA datacenter revenue surges 18% — beats consensus by wide margin",source:"Reuters",sentimentScore:92,sentiment:"BULLISH",catalystTag:"EARNINGS",timeframe:"DAY",institution:"Goldman Sachs" },
  { ticker:"AAPL",headline:"Apple announces $110B buyback program — largest in corporate history",source:"WSJ",sentimentScore:88,sentiment:"BULLISH",catalystTag:"CORPORATE",timeframe:"SWING",institution:"Morgan Stanley" },
  { ticker:"META",headline:"Meta raises full-year guidance citing AI-driven ad platform strength",source:"FT",sentimentScore:88,sentiment:"BULLISH",catalystTag:"EARNINGS",timeframe:"DAY",institution:"JPMorgan" },
  { ticker:"TSLA",headline:"Tesla misses delivery estimates for third consecutive quarter",source:"Bloomberg",sentimentScore:18,sentiment:"BEARISH",catalystTag:"EARNINGS",timeframe:"DAY",institution:"Goldman Sachs" },
  { ticker:"AMD",headline:"AMD gains AI chip market share — Wells Fargo raises target to $200",source:"MarketWatch",sentimentScore:82,sentiment:"BULLISH",catalystTag:"UPGRADE",timeframe:"DAY",institution:"JPMorgan" },
  { ticker:"GS",headline:"Goldman Q1 trading revenue surges 32% on elevated market volatility",source:"FT",sentimentScore:86,sentiment:"BULLISH",catalystTag:"EARNINGS",timeframe:"SWING",institution:"Goldman Sachs" },
  { ticker:"JPM",headline:"JPMorgan beats EPS estimates; Dimon flags geopolitical tail risks",source:"Reuters",sentimentScore:71,sentiment:"BULLISH",catalystTag:"EARNINGS",timeframe:"SWING",institution:"JPMorgan" },
  { ticker:"MACRO",headline:"Fed minutes confirm rate cut path intact — inflation trending lower",source:"AP",sentimentScore:74,sentiment:"BULLISH",catalystTag:"MACRO",timeframe:"SWING",institution:"All Banks" },
];

// ── Expanded market universe (100+ tickers) ───────────────────────────────────

const UNIVERSE_SEED: Record<string, any> = {
  // Mega-cap tech
  NVDA:{ price:878.50,prevClose:855.00,support:860.00,resist:920.00,avgVol:42e6,catalyst:"Earnings Beat",newsScore:92,sector:"Tech",optBias:"CALL",ivRank:68 },
  AAPL:{ price:188.20,prevClose:184.70,support:186.20,resist:196.00,avgVol:68e6,catalyst:"Buyback",newsScore:88,sector:"Tech",optBias:"CALL",ivRank:44 },
  META:{ price:501.00,prevClose:493.00,support:498.40,resist:520.00,avgVol:22e6,catalyst:"User Growth",newsScore:85,sector:"Tech",optBias:"CALL",ivRank:52 },
  AMD:{ price:165.40,prevClose:161.00,support:162.80,resist:176.00,avgVol:55e6,catalyst:"Upgrade",newsScore:78,sector:"Tech",optBias:"CALL",ivRank:61 },
  MSFT:{ price:418.00,prevClose:415.00,support:414.00,resist:430.00,avgVol:28e6,catalyst:"Azure Growth",newsScore:82,sector:"Tech",optBias:"CALL",ivRank:38 },
  GOOGL:{ price:172.00,prevClose:169.00,support:168.00,resist:182.00,avgVol:24e6,catalyst:"AI Revenue",newsScore:84,sector:"Tech",optBias:"CALL",ivRank:41 },
  AMZN:{ price:192.00,prevClose:188.00,support:187.00,resist:205.00,avgVol:38e6,catalyst:"AWS Growth",newsScore:83,sector:"Tech",optBias:"CALL",ivRank:46 },
  TSLA:{ price:175.00,prevClose:180.00,support:168.00,resist:192.00,avgVol:95e6,catalyst:"Delivery Miss",newsScore:32,sector:"Auto",optBias:"PUT",ivRank:82 },
  SMCI:{ price:815.00,prevClose:795.00,support:790.00,resist:870.00,avgVol:11e6,catalyst:"Server Demand",newsScore:79,sector:"Tech",optBias:"CALL",ivRank:74 },
  ARM:{ price:126.00,prevClose:122.00,support:120.00,resist:138.00,avgVol:18e6,catalyst:"AI Chips",newsScore:77,sector:"Tech",optBias:"CALL",ivRank:69 },
  // Finance
  GS:{ price:484.00,prevClose:471.00,support:474.20,resist:510.00,avgVol:6e6,catalyst:"Trading Rev",newsScore:86,sector:"Finance",optBias:"CALL",ivRank:39 },
  JPM:{ price:216.50,prevClose:212.00,support:210.00,resist:228.00,avgVol:12e6,catalyst:"Earnings Beat",newsScore:71,sector:"Finance",optBias:"CALL",ivRank:33 },
  BAC:{ price:39.50,prevClose:38.80,support:38.50,resist:42.00,avgVol:45e6,catalyst:"NII Growth",newsScore:68,sector:"Finance",optBias:"CALL",ivRank:35 },
  MS:{ price:108.00,prevClose:105.00,support:104.00,resist:115.00,avgVol:14e6,catalyst:"Wealth Mgmt",newsScore:74,sector:"Finance",optBias:"CALL",ivRank:37 },
  // ETFs
  SPY:{ price:524.00,prevClose:521.00,support:518.00,resist:535.00,avgVol:72e6,catalyst:"Index",newsScore:74,sector:"ETF",optBias:"CALL",ivRank:22 },
  QQQ:{ price:442.00,prevClose:438.00,support:435.00,resist:455.00,avgVol:50e6,catalyst:"Index",newsScore:74,sector:"ETF",optBias:"CALL",ivRank:25 },
  IWM:{ price:198.00,prevClose:196.00,support:194.00,resist:207.00,avgVol:32e6,catalyst:"Rates",newsScore:55,sector:"ETF",optBias:"NEUTRAL",ivRank:30 },
  // Energy
  XOM:{ price:116.00,prevClose:113.00,support:112.00,resist:122.00,avgVol:18e6,catalyst:"Oil Prices",newsScore:72,sector:"Energy",optBias:"CALL",ivRank:31 },
  CVX:{ price:158.00,prevClose:155.00,support:153.00,resist:165.00,avgVol:12e6,catalyst:"Buyback",newsScore:70,sector:"Energy",optBias:"CALL",ivRank:29 },
  // Semis
  MU:{ price:118.00,prevClose:115.00,support:113.00,resist:128.00,avgVol:22e6,catalyst:"AI Memory",newsScore:81,sector:"Tech",optBias:"CALL",ivRank:57 },
  QCOM:{ price:171.00,prevClose:167.00,support:165.00,resist:182.00,avgVol:14e6,catalyst:"Mobile AI",newsScore:76,sector:"Tech",optBias:"CALL",ivRank:48 },
  AVGO:{ price:1390.00,prevClose:1360.00,support:1340.00,resist:1450.00,avgVol:4e6,catalyst:"Custom AI Chips",newsScore:85,sector:"Tech",optBias:"CALL",ivRank:55 },
  // Healthcare
  UNH:{ price:520.00,prevClose:515.00,support:510.00,resist:540.00,avgVol:5e6,catalyst:"Earnings",newsScore:73,sector:"Health",optBias:"CALL",ivRank:27 },
  LLY:{ price:780.00,prevClose:760.00,support:750.00,resist:820.00,avgVol:5e6,catalyst:"GLP-1 Demand",newsScore:89,sector:"Health",optBias:"CALL",ivRank:44 },
  // Consumer
  COST:{ price:840.00,prevClose:828.00,support:820.00,resist:870.00,avgVol:4e6,catalyst:"Membership",newsScore:80,sector:"Consumer",optBias:"CALL",ivRank:28 },
  WMT:{ price:68.00,prevClose:67.00,support:66.00,resist:72.00,avgVol:22e6,catalyst:"E-commerce",newsScore:77,sector:"Consumer",optBias:"CALL",ivRank:24 },
};

const UNIVERSE_SWING_EXTRA: Record<string, any> = {
  NFLX:{ price:625.00,prevClose:615.00,support:605.00,resist:660.00,avgVol:8e6,catalyst:"Streaming",newsScore:81,sector:"Tech",holdDays:"10–21d",optBias:"CALL",ivRank:50 },
  CRM:{ price:285.00,prevClose:278.00,support:274.00,resist:300.00,avgVol:7e6,catalyst:"AI CRM",newsScore:78,sector:"Tech",holdDays:"14–21d",optBias:"CALL",ivRank:46 },
  NOW:{ price:785.00,prevClose:768.00,support:758.00,resist:820.00,avgVol:3e6,catalyst:"IT Demand",newsScore:82,sector:"Tech",holdDays:"10–28d",optBias:"CALL",ivRank:43 },
};

const SEED: Record<string, any> = UNIVERSE_SEED;
const SEED_SWING: Record<string, any> = { ...UNIVERSE_SEED, ...UNIVERSE_SWING_EXTRA };

// ── Options signal enrichment ─────────────────────────────────────────────────

type OptionsSignalData = {
  optionsBias: 'CALL' | 'PUT' | 'NEUTRAL';
  callSweeps: number;
  putSweeps: number;
  oiSpike: boolean;
  unusualVolume: boolean;
  ivRank: number;
  spreadQuality: 'TIGHT' | 'FAIR' | 'WIDE';
  suggestedExpiry: string;
  suggestedStrike: number;
  repeatabilityScore: number;
  winRateSimilar: number;
  avgFollowThrough: number;
  avgDrawdown: number;
  liquidityScore: number;
  catalystScore: number;
  reliabilityGrade: 'A+' | 'A' | 'B' | 'C';
  pastSetups: number;
};

function generateOptionsData(sym: string, seed: any, totalScore: number): OptionsSignalData {
  const r = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
  const ivRank = seed.ivRank ?? r(20, 80);
  const spreadQuality: 'TIGHT' | 'FAIR' | 'WIDE' = ivRank < 40 ? 'TIGHT' : ivRank < 65 ? 'FAIR' : 'WIDE';
  const callSweeps = seed.optBias === 'CALL' ? r(2, 8) : r(0, 2);
  const putSweeps  = seed.optBias === 'PUT'  ? r(2, 8) : r(0, 2);
  const oiSpike = totalScore >= 17 || Math.random() > 0.6;
  const unusualVol = totalScore >= 16 || Math.random() > 0.5;
  const repeatabilityScore = Math.min(10, Math.max(1, Math.round((totalScore / 20) * 8 + Math.random() * 2)));
  const winRateSimilar = Math.min(95, Math.round(45 + (totalScore / 20) * 40 + Math.random() * 8));
  const avgFollowThrough = +(8 + (totalScore / 20) * 18 + Math.random() * 5).toFixed(1);
  const avgDrawdown = +(3 + Math.random() * 6).toFixed(1);
  const liquidityScore = Math.min(10, Math.round((seed.avgVol / 10e6) * 3 + 4 + Math.random()));
  const catalystScore = Math.round((seed.newsScore / 100) * 8 + Math.random() * 2);
  const reliabilityGrade: 'A+' | 'A' | 'B' | 'C' =
    repeatabilityScore >= 8 && winRateSimilar >= 70 ? 'A+' :
    repeatabilityScore >= 6 && winRateSimilar >= 60 ? 'A' :
    repeatabilityScore >= 4 ? 'B' : 'C';
  const pastSetups = r(8, 42);
  // Next weekly Friday expiry from today
  const today = new Date();
  const daysToFri = (5 - today.getDay() + 7) % 7 || 7;
  const expDate = new Date(today.getTime() + daysToFri * 864e5);
  const suggestedExpiry = `${(expDate.getMonth()+1).toString().padStart(2,'0')}/${expDate.getDate().toString().padStart(2,'0')}`;
  const suggestedStrike = seed.optBias === 'PUT'
    ? Math.round(seed.price * 0.97 / 5) * 5
    : Math.round(seed.price * 1.02 / 5) * 5;
  return { optionsBias: (seed.optBias ?? 'NEUTRAL') as 'CALL'|'PUT'|'NEUTRAL', callSweeps, putSweeps, oiSpike, unusualVolume: unusualVol, ivRank, spreadQuality, suggestedExpiry, suggestedStrike, repeatabilityScore, winRateSimilar, avgFollowThrough, avgDrawdown, liquidityScore, catalystScore, reliabilityGrade, pastSetups };
}

let _mkt: any = null;
function simulateMarketAPI() {
  if (!_mkt) _mkt = { spy:{price:524.37,change:1.23,changePct:0.24,trend:"BULLISH",vol:"48.2M"},qqq:{price:441.82,change:2.14,changePct:0.49,trend:"BULLISH",vol:"31.7M"},vix:{price:14.82,change:-0.63,level:"LOW"},putCallRatio:{value:0.72,label:"BULLISH"},sentiment:"BULLISH" };
  const j=(v:number,b:number)=>+(v+(Math.random()-.49)*v*b).toFixed(2);
  const spyP=j(_mkt.spy.price,.0006),qqqP=j(_mkt.qqq.price,.0007),vixP=Math.max(10,j(_mkt.vix.price,.004));
  const pcr=Math.max(.4,Math.min(1.4,+(_mkt.putCallRatio.value+(Math.random()-.5)*.02).toFixed(2)));
  const spyT=spyP>522?"BULLISH":spyP<518?"BEARISH":"NEUTRAL";
  const pcrL=pcr<0.8?"BULLISH":pcr>1.1?"BEARISH":"NEUTRAL";
  const vixL=vixP<15?"LOW":vixP<20?"MODERATE":"HIGH";
  const bp=(spyT==="BULLISH"?2:1)+(pcrL==="BULLISH"?1:0)+(vixL==="LOW"?1:0);
  _mkt={ spy:{price:spyP,change:+(spyP-523.14).toFixed(2),changePct:+((spyP-523.14)/523.14*100).toFixed(2),trend:spyT,vol:`${(47+Math.random()*3).toFixed(1)}M`},qqq:{price:qqqP,change:+(qqqP-439.68).toFixed(2),changePct:+((qqqP-439.68)/439.68*100).toFixed(2),trend:qqqP>440?"BULLISH":"BEARISH",vol:`${(30+Math.random()*3).toFixed(1)}M`},vix:{price:vixP,level:vixL},putCallRatio:{value:pcr,label:pcrL},sentiment:bp>=3?"BULLISH":bp<=1?"BEARISH":"NEUTRAL" };
  return _mkt;
}

function scoreSymbol(sym: string, isSwing=false) {
  const sm=isSwing?SEED_SWING:SEED; const seed=sm[sym]; if(!seed) return null;
  const flowBase: Record<string,number>={NVDA:5,AAPL:4,META:4,AMD:4,MSFT:3,GS:4,JPM:3,AMZN:3,LLY:4,SMCI:4,ARM:3,AVGO:4,MU:3,GOOGL:3};
  const flow=Math.min(5,Math.max(0,(flowBase[sym]??3)+Math.round((Math.random()-.5)*2)));
  const ratio=(seed.avgVol*(0.8+Math.random()*1.6))/seed.avgVol;
  const volume=ratio>=2?5:ratio>=1.5?4:ratio>=1.2?3:2;
  const rawN=Math.min(100,Math.max(0,seed.newsScore+(Math.random()-.5)*10));
  const news=rawN>=80?5:rawN>=65?4:rawN>=50?3:2;
  const price=seed.price*(1+(Math.random()-.49)*.005);
  const pos=(price-seed.support)/(seed.resist-seed.support);
  const rsi=40+Math.random()*40;
  let tech=0;
  if(price>seed.support)tech++;if(pos<0.4)tech++;if(rsi>50&&rsi<70)tech++;
  if(isSwing){if(rsi<65)tech++;if(pos>0.15&&pos<0.55)tech++;}else{if(price>seed.prevClose)tech++;if(pos<0.25)tech++;}
  tech=Math.min(5,tech);
  const totalScore=flow+volume+news+tech;
  const grade=totalScore>=18?"A+":totalScore>=15?"A":"B";
  const bias=news>2&&flow>2?"BULLISH":"NEUTRAL";
  const pts=isSwing?20:12; const base=seed.support*.97,end=seed.price;
  const chartData=Array.from({length:pts},(_,i)=>+(base+(end-base)*(i/(pts-1))+(Math.random()-.48)*(end-base)*.08).toFixed(2));
  const rr=((seed.resist*.98-seed.price)/(seed.price-seed.support*.985));
  const optData = generateOptionsData(sym, seed, totalScore);
  return {
    ticker:sym, bias, totalScore, flow, volume, news, tech,
    entry:+(seed.price*(1+(Math.random()-.5)*.003)).toFixed(2),
    stop:+(seed.support*.985).toFixed(2),
    target:+(seed.resist*.98).toFixed(2),
    level:seed.support,
    catalyst:seed.catalyst,
    sector:seed.sector,
    holdDays:seed.holdDays||"Intraday",
    confidence:Math.min(99,Math.round(50+(totalScore/20)*45+Math.random()*5)),
    grade, chartData, isSwing,
    riskReward: Math.max(0, +rr.toFixed(1)),
    ...optData,
  };
}

// scoreSymbol handles any ticker: uses SEED data if available, otherwise generates
function scoreSymbolAny(sym: string, isSwing: boolean) {
  const sm = isSwing ? SEED_SWING : SEED;

  if (!sm[sym]) return null;

  return scoreSymbol(sym, isSwing);
}

function scanBatchSymbols(batch: string[], isSwing: boolean) {
  return batch
    .map(sym => scoreSymbolAny(sym, isSwing))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.totalScore - a.totalScore);
}

function computeAlignment(mkt: any) {
  if(!mkt) return {score:0,flow:0,darkPool:0,volume:0,news:0,etf:0};
  const flow=mkt.putCallRatio?.value<0.85?5:4;
  return {score:17,flow,darkPool:4,volume:5,news:4,etf:5};
}

function usePolling(fetcher: ()=>any, ms=5000) {
  const [data,setData]=useState<any>(null),[loading,setLoading]=useState(true),[lastUpdated,setLastUpdated]=useState<Date|null>(null);
  const t=useRef<any>(null);
  const load=useCallback(async()=>{ const r=await Promise.resolve(fetcher()); setData(r);setLoading(false);setLastUpdated(new Date()); },[fetcher]);
  useEffect(()=>{ load(); t.current=setInterval(load,ms); return()=>clearInterval(t.current); },[load,ms]);
  return {data,loading,lastUpdated,refresh:load};
}

// ── Styles ──────────────────────────────────────────────────────────────────

const S = {
  app:{ background:"#020817",minHeight:"100vh",color:"#e2e8f0",fontFamily:"'JetBrains Mono',monospace" } as React.CSSProperties,
  hdr:{ background:"#0f172a",borderBottom:"1px solid #1e293b",padding:"10px 20px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap" as const },
  logo:{ width:32,height:32,background:"linear-gradient(135deg,#0ea5e9,#7c3aed)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:15,flexShrink:0 },
  modeBar:(day:boolean):React.CSSProperties=>({ padding:"6px 20px",borderBottom:"1px solid",background:day?"rgba(124,45,18,.12)":"rgba(88,28,135,.12)",borderColor:day?"rgba(154,52,18,.3)":"rgba(107,33,168,.3)",color:day?"#fb923c":"#c084fc",fontSize:10,fontWeight:700 }),
  main:{ padding:"14px 20px",display:"flex",flexDirection:"column" as const,gap:14 },
  row:{ display:"grid",gap:12 } as React.CSSProperties,
  panel:(accent:string):React.CSSProperties=>({ background:"#0f172a",border:`1px solid ${accent}33`,borderRadius:8,overflow:"hidden",position:"relative" }),
  panelTop:(accent:string):React.CSSProperties=>({ position:"absolute",top:0,left:0,right:0,height:2,background:accent }),
  ph:{ padding:"10px 14px",borderBottom:"1px solid #1e293b",display:"flex",alignItems:"center",justifyContent:"space-between" } as React.CSSProperties,
  pt:{ fontSize:11,fontWeight:700,letterSpacing:".15em",color:"#cbd5e1",textTransform:"uppercase" as const },
  ps:{ fontSize:9,color:"#475569",marginTop:2 },
  pb:{ padding:"12px 14px" } as React.CSSProperties,
  statBox:{ background:"#1e293b",border:"1px solid #334155",borderRadius:6,padding:"8px 10px" } as React.CSSProperties,
  grid2:{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 } as React.CSSProperties,
  grid3:{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8 } as React.CSSProperties,
  grid4:{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6 } as React.CSSProperties,
  scroll:{ maxHeight:200,overflowY:"auto" as const },
  tab:(active:boolean,color:string):React.CSSProperties=>({ padding:"4px 12px",fontSize:10,fontWeight:700,borderRadius:6,border:`1px solid ${active?color+"66":"#334155"}`,background:active?color+"22":"transparent",color:active?color:"#475569",cursor:"pointer" }),
  navBtn:(active:boolean):React.CSSProperties=>({ padding:"5px 10px",fontSize:10,fontWeight:700,borderRadius:6,border:`1px solid ${active?"rgba(14,165,233,.4)":"transparent"}`,background:active?"rgba(14,165,233,.12)":"transparent",color:active?"#38bdf8":"#475569",cursor:"pointer" }),
  modeBtn:(active:boolean,day:boolean):React.CSSProperties=>({ padding:"4px 12px",fontSize:10,fontWeight:700,borderRadius:6,border:`1px solid ${active?(day?"rgba(249,115,22,.4)":"rgba(168,85,247,.4)"):"transparent"}`,background:active?(day?"rgba(249,115,22,.12)":"rgba(168,85,247,.12)"):"transparent",color:active?(day?"#fb923c":"#c084fc"):"#64748b",cursor:"pointer" }),
  badge:(t:string):React.CSSProperties=>{
    const m:Record<string,string>={BULLISH:"#10b981",BEARISH:"#ef4444",NEUTRAL:"#eab308","A+":"#f59e0b","A":"#0ea5e9",EARNINGS:"#f97316",UPGRADE:"#0ea5e9",CORPORATE:"#8b5cf6",GROWTH:"#10b981",MACRO:"#eab308",ACCUMULATION:"#10b981",DISTRIBUTION:"#ef4444",LOW:"#10b981",MODERATE:"#eab308",HIGH:"#ef4444","Hedge Fund":"#8b5cf6","Asset Manager":"#0ea5e9","Market Maker":"#10b981","Quant Fund":"#a855f7","Inv. Bank":"#f59e0b",Tech:"#0ea5e9",Finance:"#8b5cf6"};
    const c=m[t]||"#64748b";
    return {fontSize:9,fontWeight:700,letterSpacing:".1em",border:`1px solid ${c}44`,padding:"2px 6px",borderRadius:3,textTransform:"uppercase" as const,background:`${c}18`,color:c,whiteSpace:"nowrap" as const};
  },
  barBg:{ background:"#1e293b",borderRadius:99,overflow:"hidden",height:5 } as React.CSSProperties,
};

function Badge({label}:{label:string}){ return <span style={S.badge(label)}>{label}</span>; }
function BarFill({pct,color}:{pct:number,color:string}){ return <div style={S.barBg}><div style={{height:5,width:`${pct}%`,background:color,borderRadius:99,transition:"width .5s"}}/></div>; }
function Dot({color}:{color:string}){
  return <span style={{position:"relative",display:"inline-flex",width:8,height:8}}>
    <span style={{position:"absolute",inset:0,borderRadius:"50%",background:color,animation:"ping 1.5s ease infinite",opacity:.5}}/>
    <span style={{position:"relative",borderRadius:"50%",background:color,width:"100%",height:"100%"}}/>
  </span>;
}

function Panel({title,subtitle,accent="#0ea5e9",children,badge,right}:any){
  return <div style={S.panel(accent)}>
    <div style={S.panelTop(accent)}/>
    <div style={S.ph}>
      <div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={S.pt}>{title}</span>
          {badge && <Badge label={badge}/>}
        </div>
        {subtitle && <div style={S.ps}>{subtitle}</div>}
      </div>
      {right}
    </div>
    <div style={S.pb}>{children}</div>
  </div>;
}

// ── Alignment Score ─────────────────────────────────────────────────────────

function AlignmentScore({market}:{market:any}){
  const al=computeAlignment(market);
  const grade=al.score>=18?"A+":al.score>=15?"A":"B";
  const gc=grade==="A+"?"#f59e0b":grade==="A"?"#38bdf8":"#84cc16";
  const R=44,cx=50,cy=50,full=2*Math.PI*R*.75,dash=full*(al.score/20);
  return <Panel title="Institutional Alignment Score" subtitle="All pillars · Live composite" accent="#0ea5e9"
    right={<span style={{...S.badge(grade),fontSize:11}}>{grade}</span>}>
    <div style={{display:"flex",gap:16,alignItems:"center"}}>
      <div style={{position:"relative",flexShrink:0}}>
        <svg width="100" height="100" viewBox="0 0 100 100">
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="#1e293b" strokeWidth="8" strokeDasharray={`${full*.75} ${full*.25}`} strokeDashoffset={full*.25} strokeLinecap="round"/>
          <circle cx={cx} cy={cy} r={R} fill="none" stroke={gc} strokeWidth="8" strokeDasharray={`${dash} ${full-dash}`} strokeLinecap="round" transform={`rotate(-225 ${cx} ${cy})`}/>
          <text x={cx} y={cy+6} textAnchor="middle" fontSize="20" fontWeight="700" fill={gc} fontFamily="JetBrains Mono,monospace">{al.score}</text>
          <text x={cx} y={cy+18} textAnchor="middle" fontSize="9" fill="#475569" fontFamily="JetBrains Mono,monospace">/20</text>
        </svg>
      </div>
      <div style={{flex:1}}>
        {([["Flow","Hedge Funds",al.flow,"#8b5cf6"],["Dark Pool","Asset Mgrs",al.darkPool,"#0ea5e9"],["Volume","Quants",al.volume,"#10b981"],["News","Banks",al.news,"#f59e0b"],["ETF","Passive",al.etf,"#14b8a6"]] as any[]).map(([l,s,v,c])=>(
          <div key={l} style={{marginBottom:6}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
              <span style={{fontSize:10,fontWeight:700,color:"#cbd5e1"}}>{l} <span style={{fontSize:9,color:"#475569"}}>{s}</span></span>
              <span style={{fontSize:9,color:"#475569"}}>{v}/5</span>
            </div>
            <BarFill pct={(v/5)*100} color={c}/>
          </div>
        ))}
      </div>
    </div>
    <div style={{marginTop:10,padding:"8px 10px",borderRadius:6,border:"1px solid",textAlign:"center",fontSize:10,fontWeight:700,letterSpacing:".06em",background:al.score>=15?"rgba(16,185,129,.08)":"rgba(239,68,68,.08)",borderColor:al.score>=15?"rgba(16,185,129,.25)":"rgba(239,68,68,.25)",color:al.score>=15?"#34d399":"#f87171"}}>
      {al.score>=18?"⚡ A+ SETUP — All institutions aligned":al.score>=15?"✓ TRADE VIABLE — Proceed with entry":"✗ WAIT — Insufficient alignment"}
    </div>
  </Panel>;
}

// ── Market Overview ─────────────────────────────────────────────────────────

const SPY_SEED=[520.1,521.4,520.8,522.3,521.9,523.1,522.7,523.4,522.8,523.9,524.1,523.6,524.37];
const SPY_LBLS=["9:30","10:00","10:30","11:00","11:30","12:00","12:30","1:00","1:30","2:00","2:30","3:00","4:00"];

function MarketOverview({tradeMode,onMarket}:{tradeMode:string,onMarket:(m:any)=>void}){
  const fetcher=useCallback(()=>Promise.resolve(simulateMarketAPI()),[]);
  const {data:market,lastUpdated}=usePolling(fetcher,5000);
  const [hist,setHist]=useState(SPY_SEED.map((v,i)=>({t:SPY_LBLS[i],v})));
  useEffect(()=>{ if(!market) return; setHist(p=>[...p.slice(-14),{t:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}),v:market.spy.price}]); onMarket(market); },[market,onMarket]);
  const gc=tradeMode==="DAY"?"#f97316":"#a855f7";
  if(!market) return <Panel title="Market Overview" accent="#0ea5e9"><div style={{color:"#475569",fontSize:11}}>Loading…</div></Panel>;
  return <Panel title="Market Overview" subtitle="Live · 5s" accent="#0ea5e9" badge={market.sentiment}
    right={lastUpdated&&<div style={{display:"flex",gap:5,alignItems:"center"}}><Dot color="#0ea5e9"/><span style={{fontSize:9,color:"#475569"}}>{lastUpdated.toLocaleTimeString()}</span></div>}>
    <div style={{...S.grid2,marginBottom:10}}>
      {([["SPY",market.spy],["QQQ",market.qqq]] as any[]).map(([sym,d])=>(
        <div key={sym} style={S.statBox}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:11,fontWeight:700,color:"#f1f5f9"}}>{sym}</span><Badge label={d.trend}/></div>
          <div style={{fontSize:20,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{d.price.toFixed(2)}</div>
          <div style={{fontSize:10,fontWeight:700,color:d.change>=0?"#34d399":"#f87171"}}>{d.change>=0?"▲":"▼"} {Math.abs(d.change).toFixed(2)} ({Math.abs(d.changePct).toFixed(2)}%)</div>
        </div>
      ))}
    </div>
    <div style={{...S.grid3,marginBottom:10}}>
      <div style={{...S.statBox,textAlign:"center"}}><div style={{fontSize:9,color:"#64748b"}}>VIX</div><div style={{fontSize:18,fontWeight:700,color:"#f59e0b"}}>{market.vix.price.toFixed(2)}</div><Badge label={market.vix.level}/></div>
      <div style={{...S.statBox,textAlign:"center"}}><div style={{fontSize:9,color:"#64748b"}}>P/C Ratio</div><div style={{fontSize:18,fontWeight:700,color:"#34d399"}}>{market.putCallRatio.value.toFixed(2)}</div><Badge label={market.putCallRatio.label}/></div>
      <div style={{...S.statBox,textAlign:"center"}}><div style={{fontSize:9,color:"#64748b"}}>Bias</div><div style={{fontSize:12,fontWeight:700,color:gc}}>{market.sentiment}</div><Dot color={gc}/></div>
    </div>
    <div style={{fontSize:9,color:"#64748b",marginBottom:4}}>{tradeMode==="DAY"?"SPY Intraday":"SPY Weekly"}</div>
    <ResponsiveContainer width="100%" height={70}>
      <AreaChart data={hist} margin={{top:4,right:0,left:-30,bottom:0}}>
        <defs><linearGradient id="spyGr" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={gc} stopOpacity={.25}/><stop offset="95%" stopColor={gc} stopOpacity={0}/></linearGradient></defs>
        <XAxis dataKey="t" tick={{fontSize:8,fill:"#475569"}} tickLine={false} axisLine={false}/>
        <YAxis domain={["auto","auto"]} tick={{fontSize:8,fill:"#475569"}} tickLine={false} axisLine={false}/>
        <Tooltip contentStyle={{background:"#0f172a",border:"1px solid #334155",borderRadius:6,fontSize:10}} itemStyle={{color:gc}} labelStyle={{color:"#94a3b8"}}/>
        <Area type="monotone" dataKey="v" stroke={gc} strokeWidth={1.5} fill="url(#spyGr)" dot={false}/>
      </AreaChart>
    </ResponsiveContainer>
  </Panel>;
}

// ── Options Flow ─────────────────────────────────────────────────────────────

function OptionsFlow({tradeMode}:{tradeMode:string}){
  const fd=tradeMode==="DAY"?OPTIONS_FLOW_DAY:OPTIONS_FLOW_SWING;
  const cd=tradeMode==="DAY"?FLOW_PREMIUM:SWING_WEEKLY_FLOW;
  const xKey=tradeMode==="DAY"?"h":"day";
  const calls=fd.filter(f=>f.type==="CALL").reduce((s,f)=>s+f.premium*f.size,0);
  const puts=fd.filter(f=>f.type==="PUT").reduce((s,f)=>s+f.premium*f.size,0);
  const total=calls+puts;
  const catColor:Record<string,string>={"Hedge Fund":"#8b5cf6","Asset Manager":"#0ea5e9","Market Maker":"#10b981","Quant Fund":"#a855f7","Inv. Bank":"#f59e0b"};
  return <Panel title="Options Flow · Hedge Funds" subtitle="Sweeps · Premium size · Institution" accent="#8b5cf6">
    <div style={{...S.grid3,marginBottom:10}}>
      <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:6,padding:"8px 10px"}}><div style={{fontSize:9,color:"#10b981"}}>Call Premium</div><div style={{fontSize:16,fontWeight:700,color:"#34d399",fontFamily:"monospace"}}>${(calls/1000).toFixed(1)}M</div><div style={{fontSize:9,color:"#64748b"}}>{((calls/total)*100).toFixed(0)}%</div></div>
      <div style={{background:"rgba(239,68,68,.08)",border:"1px solid rgba(239,68,68,.2)",borderRadius:6,padding:"8px 10px"}}><div style={{fontSize:9,color:"#ef4444"}}>Put Premium</div><div style={{fontSize:16,fontWeight:700,color:"#f87171",fontFamily:"monospace"}}>${(puts/1000).toFixed(1)}M</div><div style={{fontSize:9,color:"#64748b"}}>{((puts/total)*100).toFixed(0)}%</div></div>
      <div style={S.statBox}><div style={{fontSize:9,color:"#64748b"}}>Sweeps</div><div style={{fontSize:16,fontWeight:700,color:"#a78bfa",fontFamily:"monospace"}}>{fd.filter(f=>f.sweep).length}</div><div style={{fontSize:9,color:"#64748b"}}>of {fd.length}</div></div>
    </div>
    <ResponsiveContainer width="100%" height={55}>
      <BarChart data={(cd as any[]).slice(-6)} margin={{top:0,right:0,left:-30,bottom:0}}>
        <XAxis dataKey={xKey} tick={{fontSize:8,fill:"#475569"}} tickLine={false} axisLine={false}/>
        <Bar dataKey="calls" fill="#10b981" opacity={.8} radius={[2,2,0,0]}/>
        <Bar dataKey="puts" fill="#f87171" opacity={.8} radius={[2,2,0,0]}/>
      </BarChart>
    </ResponsiveContainer>
    <div style={{...S.scroll,marginTop:8}}>
      {fd.map(f=>(
        <div key={f.id} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",borderRadius:6,border:`1px solid ${f.type==="CALL"?"rgba(16,185,129,.2)":"rgba(239,68,68,.2)"}`,background:f.type==="CALL"?"rgba(16,185,129,.04)":"rgba(239,68,68,.04)",marginBottom:4,fontSize:10,fontFamily:"monospace"}}>
          <span style={{fontWeight:700,color:f.type==="CALL"?"#34d399":"#f87171",width:40}}>{f.ticker}</span>
          <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:f.type==="CALL"?"rgba(16,185,129,.2)":"rgba(239,68,68,.2)",color:f.type==="CALL"?"#6ee7b7":"#fca5a5"}}>{f.type}</span>
          <span style={{color:"#94a3b8"}}>${f.strike}</span>
          <span style={{color:"#64748b",fontSize:9}}>{f.expiry}</span>
          <span style={{color:"#f1f5f9"}}>{f.size.toLocaleString()}</span>
          {f.sweep&&<span style={{fontSize:9,padding:"1px 4px",borderRadius:3,background:"rgba(139,92,246,.2)",color:"#c4b5fd",border:"1px solid rgba(139,92,246,.3)"}}>SWEEP</span>}
          <span style={{marginLeft:"auto",fontSize:9,color:catColor[f.category]||"#64748b"}}>{f.institution}</span>
          <span style={{fontSize:9,color:"#475569"}}>{f.time}</span>
        </div>
      ))}
    </div>
  </Panel>;
}

// ── Dark Pool ────────────────────────────────────────────────────────────────

function DarkPool({tradeMode}:{tradeMode:string}){
  const data=tradeMode==="DAY"?DARK_POOL_DAY:DARK_POOL_SWING;
  return <Panel title="Dark Pool · Asset Managers" subtitle="Block prints · Accumulation levels · Key support" accent="#f59e0b">
    <div style={S.scroll}>
      {data.map((d,i)=>(
        <div key={i} style={{padding:"8px 10px",borderRadius:6,border:`1px solid ${d.type==="ACCUMULATION"?"rgba(16,185,129,.2)":"rgba(239,68,68,.2)"}`,background:d.type==="ACCUMULATION"?"rgba(16,185,129,.05)":"rgba(239,68,68,.05)",marginBottom:6}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontWeight:700,color:"#f1f5f9",fontSize:13,fontFamily:"monospace"}}>{d.ticker}</span><Badge label={d.type}/></div>
            <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:9,color:"#fcd34d"}}>{d.institution}</span><span style={{fontSize:12,fontWeight:700,color:"#f59e0b",fontFamily:"monospace"}}>{d.size}</span></div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#64748b",marginBottom:5}}>
            <span>Level: <span style={{color:"#f1f5f9",fontFamily:"monospace"}}>${d.level}</span></span>
            <span>{d.prints} prints · avg {d.avgSize} · {d.time}</span>
          </div>
          <BarFill pct={d.strength} color={d.type==="ACCUMULATION"?"#10b981":"#ef4444"}/>
        </div>
      ))}
    </div>
  </Panel>;
}

// ── GEX ─────────────────────────────────────────────────────────────────────

function GEXPanel(){
  const maxG=Math.max(...GEX_DATA.map(d=>Math.abs(d.gex)));
  return <Panel title="Gamma Exposure (GEX)" subtitle="Market maker traps · Squeeze zones · Pin risk" accent="#14b8a6">
    <div style={{fontSize:9,color:"#64748b",marginBottom:6}}>SPY GEX by Strike ($B) — Spot at $518★</div>
    <div style={{display:"flex",height:90,alignItems:"center",gap:3,paddingBottom:20,position:"relative"}}>
      {GEX_DATA.map((d,i)=>{
        const pct=Math.abs(d.gex)/maxG*100;
        const col=d.spot?"#f59e0b":d.gex>=0?"#34d399":"#f87171";
        return <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",height:"100%",justifyContent:"center"}}>
          <div style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",height:"80px",justifyContent:"center"}}>
            <div style={{width:"100%",borderRadius:"2px 2px 0 0",background:d.gex>=0?col:"transparent",height:`${d.gex>=0?pct:0}%`}}/>
            <div style={{width:"100%",height:1,background:"#334155"}}/>
            <div style={{width:"100%",borderRadius:"0 0 2px 2px",background:d.gex<0?col:"transparent",height:`${d.gex<0?pct:0}%`}}/>
          </div>
          <div style={{fontSize:7,color:d.spot?"#f59e0b":"#475569",marginTop:3,textAlign:"center"}}>{d.label}</div>
        </div>;
      })}
    </div>
    <div style={{...S.grid2,gap:6,marginTop:6}}>
      <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:5,padding:8}}><div style={{fontSize:9,color:"#34d399",fontWeight:700}}>Positive GEX Zone</div><div style={{fontSize:12,fontWeight:700,color:"#f1f5f9"}}>$518–$525</div><div style={{fontSize:9,color:"#64748b"}}>MMs short gamma → dampened vol</div></div>
      <div style={{background:"rgba(239,68,68,.08)",border:"1px solid rgba(239,68,68,.2)",borderRadius:5,padding:8}}><div style={{fontSize:9,color:"#f87171",fontWeight:700}}>Negative GEX Zone</div><div style={{fontSize:12,fontWeight:700,color:"#f1f5f9"}}>Below $510</div><div style={{fontSize:9,color:"#64748b"}}>MMs long gamma → amplified moves</div></div>
    </div>
    <div style={{background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:5,padding:8,marginTop:6,fontSize:9}}>
      <span style={{color:"#fbbf24",fontWeight:700}}>⚡ Squeeze Zone</span> — Max pain: <strong style={{color:"#f1f5f9"}}>$520</strong> · GEX flip: <strong style={{color:"#f1f5f9"}}>$514</strong> · Break below <strong style={{color:"#f87171"}}>$510</strong> = negative GEX amplifies selling
    </div>
  </Panel>;
}

// ── ETF Flows ────────────────────────────────────────────────────────────────

function ETFFlowPanel(){
  const netIn=ETF_FLOWS.filter(e=>e.dir==="IN").reduce((s,e)=>s+parseFloat(e.flow.replace(/[$B+]/g,"")),0);
  return <Panel title="ETF Flow Tracker · Passive Giants" subtitle="BlackRock · Vanguard · State Street flows" accent="#0ea5e9">
    <div style={{...S.grid3,marginBottom:10}}>
      <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:6,padding:8,textAlign:"center"}}><div style={{fontSize:9,color:"#10b981"}}>Total Inflow</div><div style={{fontSize:14,fontWeight:700,color:"#34d399",fontFamily:"monospace"}}>+${netIn.toFixed(1)}B</div></div>
      <div style={{background:"rgba(239,68,68,.08)",border:"1px solid rgba(239,68,68,.2)",borderRadius:6,padding:8,textAlign:"center"}}><div style={{fontSize:9,color:"#ef4444"}}>Total Outflow</div><div style={{fontSize:14,fontWeight:700,color:"#f87171",fontFamily:"monospace"}}>-$1.5B</div></div>
      <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:6,padding:8,textAlign:"center"}}><div style={{fontSize:9,color:"#64748b"}}>Macro Bias</div><div style={{fontSize:13,fontWeight:700,color:"#34d399"}}>BULLISH</div></div>
    </div>
    {ETF_FLOWS.map((e,i)=>(
      <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
        <span style={{fontWeight:700,color:"#f1f5f9",fontFamily:"monospace",width:34,fontSize:11}}>{e.etf}</span>
        <div style={{flex:1}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
            <span style={{fontSize:9,color:"#64748b"}}>{e.name}</span>
            <div style={{display:"flex",gap:6}}><span style={{fontSize:10,fontWeight:700,color:e.dir==="IN"?"#34d399":"#f87171"}}>{e.flow}</span><span style={{fontSize:9,color:e.change.startsWith("+")?"#34d399":"#f87171"}}>{e.change}</span></div>
          </div>
          <BarFill pct={e.pct} color={e.dir==="IN"?"#10b981":"#ef4444"}/>
        </div>
        <Badge label={e.bias}/>
      </div>
    ))}
  </Panel>;
}

// ── Institution Tracker ──────────────────────────────────────────────────────

const CAT_META:Record<string,any>={
  assetManagers:{label:"Asset Managers",accent:"#0ea5e9",desc:"Long-only passive giants — BlackRock, Vanguard, Fidelity, State Street drive ETF/index macro direction"},
  hedgeFunds:{label:"Hedge Funds",accent:"#8b5cf6",desc:"Active long/short — Citadel, Bridgewater, Renaissance, Point72 telegraphs directional bets via options sweeps"},
  marketMakers:{label:"Market Makers",accent:"#10b981",desc:"Citadel Securities, Virtu, Jane Street — their order flow reveals pressure and GEX exposure"},
  darkPoolInst:{label:"Dark Pool / Banks",accent:"#f59e0b",desc:"Goldman, Morgan Stanley, JPMorgan + Two Sigma, D.E. Shaw execute massive off-exchange block trades"},
};

function InstitutionTracker(){
  const [expanded,setExpanded]=useState("hedgeFunds");
  return <Panel title="Institutional Activity Tracker" subtitle="Asset Managers · Hedge Funds · Market Makers · Banks · Quant Funds" accent="#8b5cf6">
    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
      {Object.keys(CAT_META).map(k=>{
        const m=CAT_META[k];
        return <button key={k} onClick={()=>setExpanded(k)} style={S.tab(expanded===k,m.accent)}>{m.label}</button>;
      })}
    </div>
    {Object.keys(CAT_META).map(k=>{
      if(k!==expanded) return null;
      const m=CAT_META[k];
      const insts=(INSTITUTIONS as any)[k];
      return <div key={k}>
        <div style={{fontSize:10,color:"#64748b",padding:"6px 10px",background:"rgba(30,41,59,.6)",borderRadius:6,border:"1px solid #1e293b",marginBottom:10}}>{m.desc}</div>
        <div style={{...S.grid2,gap:8}}>
          {insts.map((inst:any,i:number)=>(
            <div key={i} style={{background:`${inst.color}10`,border:`1px solid ${inst.color}33`,borderRadius:6,padding:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><span style={{fontSize:12,fontWeight:700,color:"#f1f5f9"}}>{inst.name}</span><Badge label={inst.bias}/></div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:4}}><span style={{color:"#64748b"}}>AUM: <span style={{color:"#cbd5e1"}}>{inst.aum}</span></span><span style={{color:inst.change.startsWith("+")||inst.change==="NEUTRAL"||inst.change==="+FLOW"?"#34d399":"#f87171",fontWeight:700}}>{inst.change}</span></div>
              <div style={{fontSize:9,color:"#64748b",marginBottom:6}}>Top: <span style={{color:"#94a3b8"}}>{inst.top}</span></div>
              <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:9,color:"#475569"}}>Flow</span><div style={{flex:1}}><BarFill pct={(inst.flow/5)*100} color={inst.color}/></div><span style={{fontSize:9,fontWeight:700,color:inst.color}}>{inst.flow}/5</span></div>
            </div>
          ))}
        </div>
      </div>;
    })}
  </Panel>;
}

// ── News ─────────────────────────────────────────────────────────────────────

function NewsSentiment({tradeMode}:{tradeMode:string}){
  const fetcher=useCallback(()=>Promise.resolve(NEWS_CORPUS.filter(n=>tradeMode==="DAY"?n.timeframe==="DAY"||n.catalystTag==="MACRO":true)),[tradeMode]);
  const {data:news,lastUpdated}=usePolling(fetcher,30000);
  return <Panel title="News · Banks + Catalysts" subtitle="Goldman · JPMorgan · Morgan Stanley narrative" accent="#10b981" right={lastUpdated&&<div style={{display:"flex",gap:5,alignItems:"center"}}><Dot color="#10b981"/><span style={{fontSize:9,color:"#475569"}}>{lastUpdated.toLocaleTimeString()}</span></div>}>
    <div style={S.scroll}>
      {(news||[]).map((n:any,i:number)=>(
        <div key={i} style={{padding:"8px 10px",background:"rgba(30,41,59,.5)",borderRadius:6,border:"1px solid #1e293b",marginBottom:6}}>
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:5}}>
            <span style={{fontWeight:700,fontSize:10,color:"#f1f5f9",fontFamily:"monospace"}}>{n.ticker}</span>
            <Badge label={n.sentiment}/><Badge label={n.catalystTag}/>
            <span style={{fontSize:9,color:"#f59e0b",marginLeft:"auto"}}>{n.institution}</span>
          </div>
          <p style={{fontSize:11,color:"#94a3b8",lineHeight:1.5,margin:0}}>{n.headline}</p>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6}}>
            <span style={{fontSize:9,color:"#475569"}}>{n.source}</span>
            <div style={{flex:1}}><BarFill pct={n.sentimentScore} color={n.sentiment==="BULLISH"?"#10b981":n.sentiment==="BEARISH"?"#ef4444":"#eab308"}/></div>
            <span style={{fontSize:9,fontWeight:700,color:n.sentiment==="BULLISH"?"#34d399":n.sentiment==="BEARISH"?"#f87171":"#fde68a"}}>{n.sentimentScore}</span>
          </div>
        </div>
      ))}
    </div>
  </Panel>;
}

// ── Signals ──────────────────────────────────────────────────────────────────

function SignalsTab({tradeMode}:{tradeMode:string}){
  const isSwing=tradeMode==="SWING";
  const [list, setList] = useState<any[]>([]);
  const [batchState, setBatchState] = useState<BatchState | null>(null);
  const [sel,setSel]=useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>|null>(null);

  const runScanCycle = useCallback(async () => {
    const { batch, state } = await alpacaUniverse.nextBatch();
    const results = scanBatchSymbols(batch, isSwing);
    state.qualifiedSignals = results.length;
    setList(results);
    setBatchState(state);
    setSel(0);
  }, [isSwing]);

  useEffect(() => {
    runScanCycle();
    // Re-scan every 30 seconds (rotates to next batch)
    intervalRef.current = setInterval(runScanCycle, 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [runScanCycle]);

  const aPlus=list.filter(w=>w.grade==="A+").length;
  const aG=list.filter(w=>w.grade==="A").length;
  const mc=isSwing?"#a855f7":"#f97316";
  const s=list[sel]||null;
  const isAlpaca = batchState?.dataSource === "alpaca";
  const sourceLabel = isAlpaca ? "Alpaca Full Market" : "Demo Fallback";

  return <div>
    {/* ── Alpaca Fallback Warning ── */}
    {batchState?.warning && (
      <div style={{padding:"8px 12px",borderRadius:6,border:"1px solid rgba(245,158,11,.3)",background:"rgba(245,158,11,.08)",color:"#fbbf24",fontSize:9,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
        <span>⚠</span>{batchState.warning}
      </div>
    )}

    {/* ── Scanner Status Bar ── */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:8,marginBottom:12}}>
      {([
        ["Market Universe", sourceLabel, isAlpaca?"#10b981":"#f59e0b"],
        ["Total Symbols",   batchState ? `${batchState.totalSymbols.toLocaleString()} loaded` : "Loading…", "#0ea5e9"],
        ["Current Batch",   batchState ? `${batchState.currentBatchStart}–${batchState.currentBatchEnd}` : "—", "#38bdf8"],
        ["Scanned Today",   batchState ? `${batchState.scannedSymbolsToday.toLocaleString()} symbols` : "—", "#f59e0b"],
        ["Qualified",       `${list.length} signals (≥15)`, "#34d399"],
        ["Data Source",     isAlpaca ? "Alpaca API" : "Demo Fallback", isAlpaca?"#10b981":"#94a3b8"],
        ["Last Scan",       batchState?.lastScanTime || "--:--:--", "#64748b"],
      ] as any[]).map(([label,val,color]:any)=>(
        <div key={label} style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:8,fontWeight:700,color:"#475569",letterSpacing:".08em",textTransform:"uppercase" as const,marginBottom:3}}>{label}</div>
          <div style={{fontSize:10,fontWeight:700,color,fontFamily:"monospace"}}>{val}</div>
        </div>
      ))}
    </div>

    {/* ── Scoring mode label ── */}
    <div style={{marginBottom:10,padding:"5px 10px",borderRadius:5,border:"1px solid #1e293b",background:"#0f172a",fontSize:9,color:"#475569",display:"inline-flex",alignItems:"center",gap:6}}>
      <Dot color={isAlpaca?"#10b981":"#f59e0b"}/>
      {isAlpaca
        ? "Live Universe · Dashboard uses simulated scoring · Use AI-Alpaca tab for live execution"
        : "Demo Universe · Simulated Signal Scoring"}
    </div>

    {/* ── Header bar ── */}
    <div style={{padding:12,borderRadius:8,border:`1px solid ${mc}33`,background:`${mc}0a`,display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
      <div style={{width:3,height:36,background:mc,borderRadius:99}}/>
      <div>
        <div style={{fontSize:10,fontWeight:700,letterSpacing:".1em",color:mc}}>{isSwing?"SWING SIGNAL STACK — Options + Multi-Day":"DAY TRADE SIGNAL STACK — Options + Intraday"}</div>
        <div style={{fontSize:10,color:"#64748b",marginTop:2}}>Small repeatable wins · Batch {batchState?.currentBatchStart}–{batchState?.currentBatchEnd} of {batchState?.totalSymbols} · Defined risk only</div>
      </div>
      <div style={{marginLeft:"auto",display:"flex",gap:8}}>
        <div style={{display:"flex",gap:5,alignItems:"center",background:"#1e293b",border:"1px solid #334155",borderRadius:6,padding:"4px 8px"}}><Dot color={isSwing?"#a855f7":"#f97316"}/><span style={{fontSize:9,color:"#64748b"}}>{batchState?.lastScanTime||"—"}</span></div>
        <div style={{background:"rgba(245,158,11,.12)",border:"1px solid rgba(245,158,11,.25)",borderRadius:6,padding:"4px 10px",textAlign:"center"}}><div style={{fontSize:9,color:"#f59e0b"}}>A+</div><div style={{fontSize:16,fontWeight:700,color:"#fbbf24",fontFamily:"monospace"}}>{aPlus}</div></div>
        <div style={{background:"rgba(14,165,233,.12)",border:"1px solid rgba(14,165,233,.25)",borderRadius:6,padding:"4px 10px",textAlign:"center"}}><div style={{fontSize:9,color:"#0ea5e9"}}>A</div><div style={{fontSize:16,fontWeight:700,color:"#38bdf8",fontFamily:"monospace"}}>{aG}</div></div>
      </div>
    </div>

    {/* ── Signal Cards ── */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8,marginBottom:12}}>
      {list.map((sig:any,i:number)=>{
        const rr=((sig.target-sig.entry)/(sig.entry-sig.stop)).toFixed(1);
        const optColor=sig.optionsBias==="CALL"?"#10b981":sig.optionsBias==="PUT"?"#ef4444":"#f59e0b";
        return <div key={sig.ticker} onClick={()=>setSel(i)} style={{background:sel===i?"rgba(14,165,233,.08)":"#0f172a",border:`1px solid ${sel===i?"rgba(14,165,233,.4)":"#1e293b"}`,borderRadius:8,padding:10,cursor:"pointer",transition:"border-color .15s"}}>
          {/* Ticker + grade */}
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
            <div>
              <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontSize:13,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{sig.ticker}</span>
                <Badge label={sig.grade}/>
              </div>
              <div style={{fontSize:8,color:"#64748b",marginTop:2}}>{sig.sector} · {sig.holdDays}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{sig.totalScore}<span style={{fontSize:9,color:"#475569"}}>/20</span></div>
            </div>
          </div>

          {/* Options Flow labels */}
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
            <span style={{fontSize:8,fontWeight:700,padding:"2px 5px",borderRadius:3,background:optColor+"22",color:optColor,border:`1px solid ${optColor}44`}}>{sig.optionsBias} SWEEP</span>
            {sig.oiSpike&&<span style={{fontSize:8,fontWeight:700,padding:"2px 5px",borderRadius:3,background:"rgba(245,158,11,.15)",color:"#fbbf24",border:"1px solid rgba(245,158,11,.3)"}}>OI SPIKE</span>}
            {sig.unusualVolume&&<span style={{fontSize:8,fontWeight:700,padding:"2px 5px",borderRadius:3,background:"rgba(14,165,233,.15)",color:"#38bdf8",border:"1px solid rgba(14,165,233,.3)"}}>UNUV</span>}
          </div>

          {/* F/V/N/T scores */}
          <div style={{...S.grid4,marginBottom:6}}>
            {([["F",sig.flow,"#8b5cf6"],["V",sig.volume,"#0ea5e9"],["N",sig.news,"#10b981"],["T",sig.tech,"#f59e0b"]] as any[]).map(([l,v,c])=>(
              <div key={l} style={{background:"#1e293b",borderRadius:4,padding:"3px 0",textAlign:"center"}}><div style={{fontSize:7,color:"#64748b"}}>{l}</div><div style={{fontSize:10,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}/5</div></div>
            ))}
          </div>

          {/* Entry/Stop/Target */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4,fontSize:9,fontFamily:"monospace",marginBottom:5}}>
            <div><div style={{color:"#64748b",fontSize:7}}>ENTRY</div><div style={{fontWeight:700,color:"#f1f5f9"}}>${sig.entry}</div></div>
            <div><div style={{color:"#ef4444",fontSize:7}}>STOP</div><div style={{fontWeight:700,color:"#f87171"}}>${sig.stop}</div></div>
            <div><div style={{color:"#10b981",fontSize:7}}>TARGET</div><div style={{fontWeight:700,color:"#34d399"}}>${sig.target}</div></div>
          </div>

          {/* Expiry + Strike suggestion */}
          <div style={{display:"flex",gap:6,marginBottom:4}}>
            <span style={{fontSize:8,color:"#94a3b8"}}>EXP <span style={{color:"#f1f5f9",fontWeight:700}}>{sig.suggestedExpiry}</span></span>
            <span style={{fontSize:8,color:"#94a3b8"}}>STK <span style={{color:"#f1f5f9",fontWeight:700}}>${sig.suggestedStrike}</span></span>
            <span style={{fontSize:8,color:"#94a3b8",marginLeft:"auto"}}>IV <span style={{color:sig.ivRank>60?"#f87171":sig.ivRank>40?"#fbbf24":"#34d399",fontWeight:700}}>{sig.ivRank}</span></span>
          </div>

          {/* R/R + Conf + Repeatability */}
          <div style={{display:"flex",justifyContent:"space-between",fontSize:8}}>
            <span style={{color:"#f59e0b",fontWeight:700}}>R/R 1:{rr}</span>
            <span style={{color:"#38bdf8",fontWeight:700}}>{sig.confidence}%</span>
            <span style={{color:"#a78bfa",fontWeight:700}}>REP {sig.repeatabilityScore}/10</span>
          </div>
        </div>;
      })}
    </div>

    {/* ── Selected Signal Detail ── */}
    {s&&<div style={{background:"#0f172a",border:"1px solid rgba(14,165,233,.25)",borderRadius:10,padding:16}}>
      {/* Title row */}
      <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:14}}>
        <span style={{fontSize:22,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{s.ticker}</span>
        <Badge label={s.grade}/><Badge label={s.bias}/><Badge label={s.sector}/>
        {s.oiSpike&&<Badge label="OI SPIKE"/>}
        {s.unusualVolume&&<Badge label="UNUSUAL VOL"/>}
        <span style={{fontSize:10,color:"#64748b",marginLeft:"auto"}}>Score: <strong style={{color:"#f1f5f9"}}>{s.totalScore}/20</strong> · Conf: <strong style={{color:"#38bdf8"}}>{s.confidence}%</strong> · Hold: <strong style={{color:"#c084fc"}}>{s.holdDays}</strong></span>
      </div>

      {/* Signal pillars */}
      <div style={{...S.grid4,marginBottom:14}}>
        {([["Options Flow",s.flow,"#8b5cf6",`${s.callSweeps} call / ${s.putSweeps} put sweeps`],["Volume Confirm",s.volume,"#0ea5e9","Above avg · Relative vol"],["News Catalyst",s.news,"#10b981",s.catalyst||"—"],["Technical",s.tech,"#f59e0b","Clean structure"]] as any[]).map(([label,val,color,note])=>(
          <div key={label} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:12}}>
            <div style={{fontSize:9,color:"#64748b",marginBottom:4}}>{label}</div>
            <div style={{fontSize:26,fontWeight:700,color,fontFamily:"monospace"}}>{val}<span style={{fontSize:11,color:"#334155"}}>/5</span></div>
            <BarFill pct={(val/5)*100} color={color}/>
            <div style={{fontSize:9,color:"#64748b",marginTop:4}}>{note}</div>
          </div>
        ))}
      </div>

      {/* Entry/Stop/Target */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
        <div style={{background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:12}}>
          <div style={{fontSize:9,color:"#64748b",marginBottom:4}}>Entry Zone</div>
          <div style={{fontSize:22,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>${s.entry}</div>
          <div style={{fontSize:9,color:"#64748b",marginTop:4}}>Opt: {s.suggestedExpiry} ${s.suggestedStrike} {s.optionsBias}</div>
        </div>
        <div style={{background:"rgba(239,68,68,.08)",border:"1px solid rgba(239,68,68,.2)",borderRadius:8,padding:12}}>
          <div style={{fontSize:9,color:"#ef4444",marginBottom:4}}>Stop Loss · -8% option target</div>
          <div style={{fontSize:22,fontWeight:700,color:"#f87171",fontFamily:"monospace"}}>${s.stop}</div>
          <div style={{fontSize:9,color:"#64748b"}}>Risk: ${(s.entry-s.stop).toFixed(2)} · -{(((s.entry-s.stop)/s.entry)*100).toFixed(1)}%</div>
        </div>
        <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:8,padding:12}}>
          <div style={{fontSize:9,color:"#10b981",marginBottom:4}}>Price Target · +20% option target</div>
          <div style={{fontSize:22,fontWeight:700,color:"#34d399",fontFamily:"monospace"}}>${s.target}</div>
          <div style={{fontSize:9,color:"#64748b"}}>Reward: ${(s.target-s.entry).toFixed(2)} · +{(((s.target-s.entry)/s.entry)*100).toFixed(1)}%</div>
        </div>
      </div>

      {/* Reliability / Repeatability Scorecard */}
      <div style={{background:"rgba(167,139,250,.06)",border:"1px solid rgba(167,139,250,.2)",borderRadius:8,padding:14,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:".1em",color:"#a78bfa"}}>RELIABILITY / REPEATABILITY SCORECARD</div>
            <div style={{fontSize:9,color:"#64748b",marginTop:2}}>Small repeatable wins · Ross Cameron framework · {s.pastSetups} similar past setups</div>
          </div>
          <div style={{textAlign:"center",background:"rgba(167,139,250,.12)",border:"1px solid rgba(167,139,250,.3)",borderRadius:8,padding:"8px 16px"}}>
            <div style={{fontSize:8,color:"#a78bfa",marginBottom:2}}>RELIABILITY</div>
            <div style={{fontSize:22,fontWeight:700,color:s.reliabilityGrade==="A+"?"#fbbf24":s.reliabilityGrade==="A"?"#38bdf8":"#84cc16",fontFamily:"monospace"}}>{s.reliabilityGrade}</div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
          {([
            ["Repeatability",`${s.repeatabilityScore}/10`,s.repeatabilityScore>=7?"#34d399":s.repeatabilityScore>=5?"#fbbf24":"#f87171","Clean pattern, consistent structure"],
            ["Win Rate (similar)",`${s.winRateSimilar}%`,s.winRateSimilar>=65?"#34d399":s.winRateSimilar>=55?"#fbbf24":"#f87171",`${s.pastSetups} past setups tracked`],
            ["Avg Follow-Through",`+${s.avgFollowThrough}%`,s.avgFollowThrough>=15?"#34d399":s.avgFollowThrough>=10?"#fbbf24":"#f87171","Option premium avg gain"],
            ["Avg Max Drawdown",`-${s.avgDrawdown}%`,"#94a3b8","Before target hit"],
          ] as any[]).map(([label,val,color,note])=>(
            <div key={label} style={{background:"#0f172a",borderRadius:6,padding:10}}>
              <div style={{fontSize:8,color:"#64748b",marginBottom:3}}>{label}</div>
              <div style={{fontSize:16,fontWeight:700,color,fontFamily:"monospace"}}>{val}</div>
              <div style={{fontSize:8,color:"#475569",marginTop:3}}>{note}</div>
            </div>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
          {([
            ["Liquidity Score",s.liquidityScore,10,"#0ea5e9","Bid-ask spread · volume"],
            ["Risk/Reward Score",Math.min(10,Math.round(((s.target-s.entry)/(s.entry-s.stop||1))*2.5)),10,"#f59e0b","R/R ratio quality"],
            ["Catalyst Score",s.catalystScore,10,"#10b981","News · earnings · upgrade"],
          ] as any[]).map(([label,val,max,color,note])=>(
            <div key={label} style={{background:"#0f172a",borderRadius:6,padding:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:8,color:"#64748b"}}>{label}</span>
                <span style={{fontSize:9,fontWeight:700,color}}>{val}/{max}</span>
              </div>
              <BarFill pct={(val/max)*100} color={color}/>
              <div style={{fontSize:8,color:"#475569",marginTop:3}}>{note}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,padding:"8px 10px",borderRadius:6,border:"1px solid rgba(167,139,250,.2)",background:"rgba(15,23,42,.6)",fontSize:9,color:"#94a3b8",lineHeight:1.6}}>
          <span style={{color:"#a78bfa",fontWeight:700}}>Strategy: </span>
          {s.spreadQuality==="TIGHT"?"Tight spread — ideal for options entry. ":"Fair/wide spread — use limit orders only. "}
          {s.repeatabilityScore>=7?"High repeatability: similar setups have consistent follow-through. ":"Moderate repeatability: confirm all pillars before entry. "}
          Target <strong style={{color:"#34d399"}}>+20% option gain</strong>, hard stop <strong style={{color:"#f87171"}}>-8%</strong>. Max {isSwing?"3":"5"} trades/day. No revenge trading.
        </div>
      </div>

      {/* Options flow detail */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        {([
          ["Call Sweeps",s.callSweeps,"#10b981","Unusual call activity"],
          ["Put Sweeps",s.putSweeps,"#ef4444","Unusual put activity"],
          ["IV Rank",`${s.ivRank}%`,s.ivRank>65?"#f87171":s.ivRank>40?"#fbbf24":"#34d399","Implied volatility rank"],
          ["Spread",s.spreadQuality,s.spreadQuality==="TIGHT"?"#34d399":s.spreadQuality==="FAIR"?"#fbbf24":"#f87171","Bid-ask quality"],
        ] as any[]).map(([label,val,color,note])=>(
          <div key={label} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:6,padding:10}}>
            <div style={{fontSize:8,color:"#64748b",marginBottom:3}}>{label}</div>
            <div style={{fontSize:16,fontWeight:700,color,fontFamily:"monospace"}}>{val}</div>
            <div style={{fontSize:8,color:"#475569",marginTop:2}}>{note}</div>
          </div>
        ))}
      </div>

      {/* Disclaimer */}
      <div style={{marginTop:12,padding:"8px 10px",borderRadius:5,border:"1px solid #1e293b",background:"rgba(15,23,42,.8)",fontSize:8,color:"#475569",lineHeight:1.6}}>
        <strong style={{color:"#64748b"}}>EDUCATIONAL DISCLAIMER:</strong> Signal Stack is an analytical tool for educational purposes only. All signals are simulated/scored based on public data models and do not constitute financial advice. Options trading involves substantial risk and is not suitable for all investors. You can lose 100% of your investment. Always consult a licensed financial advisor before making any trades. Past signal performance does not guarantee future results. Journal every trade and practice strict risk management.
      </div>
    </div>}
  </div>;
}

// ── Risk ─────────────────────────────────────────────────────────────────────

function RiskManagement({tradeMode}:{tradeMode:string}){
  const [balance,setBalance]=useState(2500);
  const [riskPct,setRiskPct]=useState(1.5);
  const riskAmt=(balance*riskPct)/100;
  const maxLoss=balance*(tradeMode==="DAY"?.04:.06);
  const phase=balance<1000?1:balance<2500?2:3;
  const phasePct=phase===1?((balance-500)/500)*100:phase===2?((balance-1000)/1500)*100:((balance-2500)/2500)*100;
  const trades=[["NVDA","+$187","+28%",true],["AAPL","+$94","+22%",true],["META","-$47","-18%",false],["GS","+$211","+38%",true],["TSLA","-$38","-15%",false]];
  return <Panel title="Risk Management" subtitle={tradeMode==="DAY"?"Day sizing · 4% max loss":"Swing sizing · 6% max loss"} accent="#f43f5e">
    <div style={{...S.grid2,marginBottom:12}}>
      <div><div style={{fontSize:9,color:"#64748b",marginBottom:4}}>Account Balance</div><div style={{display:"flex",background:"#1e293b",border:"1px solid #334155",borderRadius:6,overflow:"hidden"}}><span style={{padding:"6px 8px",color:"#64748b"}}>$</span><input type="number" value={balance} onChange={e=>setBalance(Number(e.target.value))} style={{background:"transparent",border:"none",color:"#f1f5f9",fontFamily:"monospace",fontSize:12,padding:"6px 4px",outline:"none",width:90}}/></div></div>
      <div><div style={{fontSize:9,color:"#64748b",marginBottom:4}}>Risk Per Trade</div><div style={{display:"flex",background:"#1e293b",border:"1px solid #334155",borderRadius:6,overflow:"hidden"}}><input type="number" step={.5} min={.5} max={3} value={riskPct} onChange={e=>setRiskPct(Number(e.target.value))} style={{background:"transparent",border:"none",color:"#f1f5f9",fontFamily:"monospace",fontSize:12,padding:"6px 8px",outline:"none",width:60}}/><span style={{padding:"6px 8px",color:"#64748b"}}>%</span></div></div>
    </div>
    <div style={{...S.grid3,marginBottom:12}}>
      {([["Risk/Trade",`$${riskAmt.toFixed(0)}`,"#f59e0b"],["Max Daily Loss",`$${maxLoss.toFixed(0)}`,"#ef4444"],["Win Rate","67%","#10b981"]] as any[]).map(([l,v,c])=>(
        <div key={l} style={{...S.statBox,textAlign:"center"}}><div style={{fontSize:9,color:"#64748b"}}>{l}</div><div style={{fontSize:16,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div></div>
      ))}
    </div>
    <div style={{background:"rgba(139,92,246,.1)",border:"1px solid rgba(139,92,246,.2)",borderRadius:6,padding:10,marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:9,color:"#a78bfa",fontWeight:700}}>Phase {phase} of 3</span><span style={{fontSize:9,color:"#c4b5fd",fontWeight:700}}>{Math.max(0,phasePct).toFixed(0)}%</span></div>
      <BarFill pct={Math.min(100,Math.max(0,phasePct))} color="#8b5cf6"/>
      <div style={{fontSize:9,color:"#64748b",marginTop:4}}>{phase===1?"Focus on consistency. 2–3 trades/day max.":phase===2?"Maintain discipline. Scale on A+ setups only.":"Scale into high-confidence trades only."}</div>
    </div>
    {trades.map(([t,r,p,w],i)=>(
      <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",borderRadius:5,border:`1px solid ${w?"rgba(16,185,129,.2)":"rgba(239,68,68,.2)"}`,background:w?"rgba(16,185,129,.05)":"rgba(239,68,68,.05)",marginBottom:5,fontSize:10,fontFamily:"monospace"}}>
        <span style={{fontWeight:700,color:"#f1f5f9"}}>{t}</span>
        <span style={{color:w?"#34d399":"#f87171"}}>{r}</span>
        <span style={{color:w?"#6ee7b7":"#fca5a5",marginLeft:"auto"}}>{p}</span>
        <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:w?"rgba(16,185,129,.2)":"rgba(239,68,68,.2)",color:w?"#6ee7b7":"#fca5a5"}}>{w?"WIN":"LOSS"}</span>
      </div>
    ))}
  </Panel>;
}

// ── Playbook ─────────────────────────────────────────────────────────────────

function Playbook({tradeMode}:{tradeMode:string}){
  const now=new Date(),h=now.getHours(),m=now.getMinutes();
  const isSwing=tradeMode==="SWING";
  const activeId=h<9||(h===9&&m<30)?"PREMARKET":h<11?"OPEN":h<15?"MIDDAY":"POWERHOUR";
  const phases=isSwing?[
    {id:"PREMARKET",label:"Weekly Research",time:"Sun–Mon",col:"#f59e0b",steps:["Review 13F: BlackRock / Vanguard / Fidelity changes","Scan dark pool weekly (Goldman, JPMorgan, MS)","Identify 3+ weeks of hedge fund accumulation","Confirm GEX weekly — avoid high negative GEX","ETF flows confirm sector: XLK / XLF"]},
    {id:"OPEN",label:"Entry Days",time:"Mon–Tue",col:"#a855f7",steps:["Enter Mon/Tue pullbacks to dark pool support","ETF inflow + alignment score ≥15","Limit orders at dark pool prints only","1.5–2% risk · 30–60d expiry options","Target 2–4 week hold period"]},
    {id:"MIDDAY",label:"Position Mgmt",time:"Wed–Thu",col:"#0ea5e9",steps:["Check new institutional sweeps same direction","GEX expanding negative → reduce size","Trail stop to breakeven at +10%","Exit 1d before earnings unless confirmed","Monitor ETF — sector rotates out → exit"]},
    {id:"POWERHOUR",label:"Exit Strategy",time:"Thu–Fri",col:"#10b981",steps:["Exit Thu/Fri on weekly options","Take profit if within 10% of target","Hold core if institutional flow confirms","Check next week: FOMC, CPI, earnings","Log P&L and R/R vs plan"]},
  ]:[
    {id:"PREMARKET",label:"Pre-Market",time:"7:00–9:30 AM",col:"#f59e0b",steps:["Scan GEX — note max pain and flip level","Check ETF flows: SPY/QQQ confirm macro","Review dark pool prints from overnight","Screen options for early sweeps (HFs)","Build watchlist: alignment score ≥15 only"]},
    {id:"OPEN",label:"Market Open",time:"9:30–10:30 AM",col:"#10b981",steps:["Watch GEX flip zone — above = suppressed vol","Type 1: Breakout above PM high + sweep","Type 2: Pullback to dark pool + buyers confirm","All pillars ≥15 before entry","Max 2 positions — no chasing, no FOMO"]},
    {id:"MIDDAY",label:"Midday",time:"11:00–2:00 PM",col:"#0ea5e9",steps:["Avoid new entries — algo chop","Manage open: trail stops on winners","Re-check ETF flow + GEX afternoon read","Dark pool spike → reassess setup","Scan for power hour setups at 2:30"]},
    {id:"POWERHOUR",label:"Power Hour",time:"3:00–4:00 PM",col:"#8b5cf6",steps:["Late dark pool prints = institutional signal","MMs hedge positions — GEX can flip","Continuation trades on day momentum","Trim into close — no overnight risk","Log trades: catalyst, score, outcome"]},
  ];
  return <Panel title={isSwing?"Swing Playbook":"Intraday Playbook"} subtitle={isSwing?"Weekly execution · GEX-aware · ETF-confirmed":"GEX-aware · Flow-confirmed · Step-by-step"} accent={isSwing?"#a855f7":"#0ea5e9"}>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {phases.map(p=>{
        const active=!isSwing&&p.id===activeId;
        return <div key={p.id} style={{border:`1px solid ${p.col}33`,borderRadius:6,padding:10,background:`${p.col}08`,outline:active?"1px solid rgba(255,255,255,.1)":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
            <span style={{color:p.col,fontWeight:700,fontSize:12}}>{p.label}</span>
            <span style={{fontSize:9,color:"#64748b"}}>{p.time}</span>
            {active&&<span style={{marginLeft:"auto",fontSize:9,fontWeight:700,color:"#f1f5f9",background:"rgba(255,255,255,.1)",padding:"2px 8px",borderRadius:99,display:"flex",alignItems:"center",gap:4}}><Dot color={p.col}/>ACTIVE</span>}
          </div>
          {p.steps.map((s,i)=>(
            <div key={i} style={{display:"flex",gap:6,fontSize:10,color:"#94a3b8",marginBottom:3}}>
              <span style={{width:5,height:5,borderRadius:"50%",background:p.col,flexShrink:0,marginTop:4}}/>
              {s}
            </div>
          ))}
        </div>;
      })}
    </div>
  </Panel>;
}

// ── Fidelity Bridge ──────────────────────────────────────────────────────────

function FidelityPanel(){
  const [autoApprove,setAutoApprove]=useState(false);
  const pending=[{ticker:"NVDA",grade:"A+",score:19,conf:94,action:"BUY 10 @ $878.50"},{ticker:"GS",grade:"A",score:17,conf:87,action:"BUY 5 @ $484.00"}];
  return <Panel title="AI → Fidelity Bridge" subtitle="Signal confirmation · Manual approval required" accent="#10b981">
    <div style={{...S.grid3,marginBottom:12}}>
      {([["Signal Engine","LIVE","#10b981"],["Fidelity API","PENDING","#f59e0b"],["Auto-Trade","OFF","#ef4444"]] as any[]).map(([l,v,c])=>(
        <div key={l} style={{...S.statBox,textAlign:"center"}}><div style={{fontSize:9,color:"#64748b"}}>{l}</div><div style={{fontSize:11,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div><div style={{display:"flex",justifyContent:"center",marginTop:4}}><Dot color={c}/></div></div>
      ))}
    </div>
    <div style={{background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:6,padding:10,marginBottom:10}}>
      <div style={{fontSize:9,color:"#fbbf24",fontWeight:700,marginBottom:8}}>⚠ PENDING SIGNALS</div>
      {pending.map((t,i)=>(
        <div key={i} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:6,padding:8,marginBottom:6}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{t.ticker}</span><Badge label={t.grade}/></div><span style={{fontSize:10,color:"#38bdf8",fontWeight:700}}>Conf {t.conf}%</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,fontFamily:"monospace",marginBottom:8}}><span style={{color:"#34d399"}}>{t.action}</span><span style={{color:"#64748b"}}>Score {t.score}/20</span></div>
          <div style={{display:"flex",gap:6}}>
            <button style={{flex:1,padding:"5px 0",fontSize:10,fontWeight:700,borderRadius:5,border:"1px solid rgba(16,185,129,.3)",background:"rgba(16,185,129,.12)",color:"#34d399",cursor:"pointer"}}>✓ APPROVE</button>
            <button style={{flex:1,padding:"5px 0",fontSize:10,fontWeight:700,borderRadius:5,border:"1px solid rgba(239,68,68,.3)",background:"rgba(239,68,68,.12)",color:"#f87171",cursor:"pointer"}}>✗ REJECT</button>
          </div>
        </div>
      ))}
    </div>
    <div style={{background:"rgba(139,92,246,.08)",border:"1px solid rgba(139,92,246,.2)",borderRadius:6,padding:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <span style={{fontSize:9,color:"#a78bfa",fontWeight:700}}>AUTO-APPROVE MODE</span>
        <button onClick={()=>setAutoApprove(!autoApprove)} style={{width:36,height:18,borderRadius:9,border:"none",cursor:"pointer",position:"relative",background:autoApprove?"#8b5cf6":"#334155",transition:"background .2s",flexShrink:0}}>
          <span style={{position:"absolute",top:2,width:14,height:14,borderRadius:"50%",background:"#f1f5f9",transition:"left .2s",left:autoApprove?20:2}}/>
        </button>
      </div>
      <p style={{fontSize:9,color:"#64748b",lineHeight:1.5,margin:0}}>{autoApprove?"⚠ AUTO ON — A+ signals (≥18/20) execute automatically. Monitor closely.":"Disabled. Manual approval required. Recommended until 90%+ win rate over 30+ trades."}</p>
    </div>
  </Panel>;
}

// ── Header ───────────────────────────────────────────────────────────────────

const TABS=["Dashboard","Signals","Institutions","GEX+ETF","Playbook","Risk","AI-Fidelity","AI-Alpaca","💹 Forex"];

function Header({activeTab,setActiveTab,tradeMode,setTradeMode}:any){
  const [time,setTime]=useState(new Date());
  useEffect(()=>{ const i=setInterval(()=>setTime(new Date()),1000); return()=>clearInterval(i); },[]);
  return <header style={S.hdr}>
    <div style={S.logo}>Σ</div>
    <div><div style={{fontSize:11,fontWeight:700,letterSpacing:".15em",color:"#f1f5f9"}}>SIGNAL STACK</div><div style={{fontSize:9,color:"#475569"}}>Institutional Terminal v3</div></div>
    <div style={{display:"flex",background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:2,gap:2}}>
      {["DAY","SWING"].map(m=><button key={m} onClick={()=>setTradeMode(m)} style={S.modeBtn(tradeMode===m,m==="DAY")}>{m==="DAY"?"⚡ Day":"📈 Swing"}</button>)}
    </div>
    <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
      {TABS.map(t=><button key={t} onClick={()=>setActiveTab(t)} style={S.navBtn(activeTab===t)}>{t}</button>)}
    </div>
    <div style={{marginLeft:"auto",display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
      <div style={{display:"flex",gap:5,alignItems:"center",fontSize:10,fontWeight:700,padding:"4px 8px",borderRadius:6,border:`1px solid ${tradeMode==="DAY"?"rgba(249,115,22,.3)":"rgba(168,85,247,.3)"}`,background:tradeMode==="DAY"?"rgba(249,115,22,.08)":"rgba(168,85,247,.08)",color:tradeMode==="DAY"?"#fb923c":"#c084fc"}}>
        <Dot color={tradeMode==="DAY"?"#f97316":"#a855f7"}/>{tradeMode} MODE
      </div>
      <div style={{display:"flex",gap:5,alignItems:"center"}}><Dot color="#10b981"/><span style={{fontSize:10,color:"#34d399",fontWeight:700}}>LIVE</span></div>
      <div style={{fontSize:11,fontFamily:"monospace",color:"#64748b"}}>{time.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</div>
    </div>
  </header>;
}

export default function AppWrapper(){
  const [activeTab,setActiveTab]=useState("Dashboard");

  console.log("ACTIVE TAB:", activeTab);

  const [tradeMode,setTradeMode]=useState("DAY");
  const [market,setMarket]=useState<any>(null);
  const handleMode=(m:string)=>{ setTradeMode(m); setActiveTab("Dashboard"); };

  // ── Shared signal state ────────────────────────────────────────────────
  const [signals, setSignals] = useState<any[]>([]);

  useEffect(() => {
    const runScan = async () => {
      try {
        const { batch } = await alpacaUniverse.nextBatch();
        if (!batch.length) return;
        const results = scanBatchSymbols(batch, tradeMode === 'SWING');
        setSignals(results);
        console.log("APP SHARED SIGNALS:", results.length);
      } catch { /* silent */ }
    };
    runScan();
    const t = setInterval(runScan, 30_000);
    return () => clearInterval(t);
  }, [tradeMode]);

  return <div style={S.app}>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#020817}
      ::-webkit-scrollbar{width:4px;height:4px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:#334155;border-radius:2px}
      @keyframes ping{0%{transform:scale(1);opacity:.5}70%{transform:scale(2);opacity:0}100%{opacity:0}}
      @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      .fade-in{animation:fadeIn .3s ease forwards}
      button:hover{opacity:.85}
    `}</style>

    <Header activeTab={activeTab} setActiveTab={setActiveTab} tradeMode={tradeMode} setTradeMode={handleMode}/>

    <div style={S.modeBar(tradeMode==="DAY")}>
      {tradeMode==="DAY"?"⚡ DAY MODE — Options flow (HFs) · Dark pool (AMs) · Volume (Quants) · News (Banks) · ETF (Passive)":"📈 SWING MODE — 13F flows · Dark pool zones · GEX weekly · ETF sector rotation · 7–30d holds"}
    </div>

    <main style={S.main}>
      {activeTab==="Dashboard"&&<div className="fade-in">
        <div style={{...S.row,gridTemplateColumns:"300px 280px 1fr 280px",marginBottom:12}}>
          <AlignmentScore market={market}/>
          <MarketOverview tradeMode={tradeMode} onMarket={setMarket}/>
          <OptionsFlow tradeMode={tradeMode}/>
          <DarkPool tradeMode={tradeMode}/>
        </div>
        <div style={{...S.row,gridTemplateColumns:"1fr 1fr 1fr 1fr"}}>
          <GEXPanel/>
          <ETFFlowPanel/>
          <NewsSentiment tradeMode={tradeMode}/>
          <FidelityPanel/>
        </div>
      </div>}

      {activeTab==="Signals"&&<div className="fade-in"><SignalsTab tradeMode={tradeMode}/></div>}

      {activeTab==="Institutions"&&<div className="fade-in" style={{...S.row,gridTemplateColumns:"1fr 360px",gap:12}}>
        <InstitutionTracker/>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <DarkPool tradeMode={tradeMode}/>
          <AlignmentScore market={market}/>
        </div>
      </div>}

      {activeTab==="GEX+ETF"&&<div className="fade-in" style={{...S.row,gridTemplateColumns:"1fr 1fr 300px",gap:12}}>
        <GEXPanel/><ETFFlowPanel/><AlignmentScore market={market}/>
      </div>}

      {activeTab==="Playbook"&&<div className="fade-in" style={{...S.row,gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Playbook tradeMode={tradeMode}/>
        <Panel title="Pillar Breakdown" subtitle="Who drives each signal" accent="#f59e0b">
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {([["⚡","Options Flow","Hedge Funds","Citadel · Bridgewater · Renaissance · Point72","Sweeps telegraph directional bets days before price moves. Large premium = conviction.","#8b5cf6"],["🌑","Dark Pool","Asset Managers + Banks","BlackRock · Vanguard · Goldman · JPMorgan · Two Sigma","Off-exchange block prints show accumulation. Dark pool level becomes future support.","#f59e0b"],["📊","Volume + Price","Quant Funds","Two Sigma · D.E. Shaw · Renaissance","Momentum confirmation — quants trigger when price + volume break levels algorithmically.","#0ea5e9"],["📰","News Catalysts","Investment Banks","Goldman Sachs · Morgan Stanley · JPMorgan","Upgrades, earnings, rate decisions shift institutional narrative and drive flows.","#10b981"],["🏛","ETF Flows","Passive Giants","BlackRock · Vanguard · Fidelity · State Street","SPY/QQQ inflows confirm macro direction. Passive giants move the entire market.","#14b8a6"]] as any[]).map(([icon,label,who,players,desc,col])=>(
              <div key={label} style={{background:`${col}08`,border:`1px solid ${col}22`,borderRadius:6,padding:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}><span style={{fontSize:14}}>{icon}</span><span style={{fontSize:11,fontWeight:700,color:col}}>{label}</span><span style={{fontSize:9,color:"#64748b"}}>→ {who}</span></div>
                <div style={{fontSize:9,color:"#475569",marginBottom:4}}>{players}</div>
                <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.5}}>{desc}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>}

      {activeTab==="Risk"&&<div className="fade-in" style={{...S.row,gridTemplateColumns:"400px 1fr",gap:12}}>
        <RiskManagement tradeMode={tradeMode}/>
        <Panel title="Capital Scaling Roadmap" subtitle="$500 → $5,000" accent="#8b5cf6">
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {([
              [1,"$500","$1K","#0ea5e9",tradeMode==="DAY"?["1% risk max","2 trades/day","1 setup type","Track all","60% WR target"]:["1% risk max","1–2 positions","14–21d holds","Log all","55% WR"]],
              [2,"$1K","$2.5K","#8b5cf6",tradeMode==="DAY"?["1–1.5% risk","3 trades/day","Two setups","R/R 1:2 min","Scale winners"]:["1.5% risk","2–3 positions","10–21d holds","A+ only scale","Partial +15%"]],
              [3,"$2.5K","$5K","#f59e0b",tradeMode==="DAY"?["1.5–2% risk","4 trades/day","A+ gets size","Add to winners","Full playbook"]:["2% risk","4 positions","Full playbook","Trail stops","Options on A+"]],
            ] as any[]).map(([phase,from,to,col,rules])=>(
              <div key={phase} style={{background:`${col}08`,border:`1px solid ${col}33`,borderRadius:8,padding:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <div><span style={{fontSize:11,fontWeight:700,color:col}}>Phase {phase}</span><span style={{fontSize:9,color:"#64748b",marginLeft:8}}>{from} → {to}</span></div>
                  <span style={{fontSize:16,fontWeight:700,color:col,fontFamily:"monospace"}}>×{phase===1?"2.0":phase===2?"2.5":"2.0"}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5}}>
                  {rules.map((r:string,i:number)=><div key={i} style={{background:"rgba(15,23,42,.6)",borderRadius:4,padding:"6px 4px",textAlign:"center",fontSize:9,color:"#94a3b8"}}>{r}</div>)}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>}

      {activeTab==="AI-Alpaca" && (
        <div className="fade-in">
          <AIAlpacaTab signals={signals} />
        </div>
      )}
      {activeTab==="💹 Forex" && (
        <div className="fade-in">
          <ForexSignalStackTab />
        </div>
      )}
      {activeTab==="AI-Fidelity"&&<div className="fade-in" style={{...S.row,gridTemplateColumns:"400px 1fr",gap:12}}>
        <FidelityPanel/>
        <Panel title="AI Autonomous Trading Roadmap" subtitle="Path to Fidelity auto-execution" accent="#0ea5e9">
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {([
              ["1","Signal Validation","ACTIVE","#0ea5e9","Run for 30 trading days. Log every A+ signal vs actual market outcome. Build accuracy baseline.","Target: 65%+ directional accuracy"],
              ["2","Paper Trading","NEXT","#8b5cf6","Execute every signal on Fidelity paper account. Track P&L vs signal score rigorously.","Target: 60%+ win rate · 1:2+ R/R average"],
              ["3","Manual Execution","LOCKED","#475569","Trade real capital, approve manually. Learn which conditions AI excels and struggles in.","Target: 90%+ A+ accuracy over 30 trades"],
              ["4","Autonomous Trading","LOCKED","#475569","Enable auto-approve for A+ only (18–20). Monitor daily. Override any time.","Only enable after 3+ months consistent results"],
            ] as any[]).map(([n,label,status,col,desc,metric])=>(
              <div key={n} style={{background:status==="ACTIVE"?"rgba(14,165,233,.08)":status==="NEXT"?"rgba(139,92,246,.08)":"rgba(30,41,59,.4)",border:`1px solid ${status==="ACTIVE"?"rgba(14,165,233,.3)":status==="NEXT"?"rgba(139,92,246,.3)":"#1e293b"}`,borderRadius:6,padding:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                  <span style={{fontSize:11,fontWeight:700,color:col}}>Phase {n}: {label}</span>
                  <span style={{fontSize:9,padding:"2px 7px",borderRadius:3,fontWeight:700,background:status==="ACTIVE"?"rgba(14,165,233,.2)":status==="NEXT"?"rgba(139,92,246,.2)":"rgba(30,41,59,.8)",color:status==="ACTIVE"?"#38bdf8":status==="NEXT"?"#a78bfa":"#475569"}}>{status}</span>
                </div>
                <p style={{fontSize:10,color:"#64748b",lineHeight:1.5,margin:"0 0 5px 0"}}>{desc}</p>
                <div style={{fontSize:9,fontWeight:700,color:"#f59e0b"}}>{metric}</div>
              </div>
            ))}
            <div style={{background:"rgba(239,68,68,.08)",border:"1px solid rgba(239,68,68,.2)",borderRadius:6,padding:10}}>
              <div style={{fontSize:9,color:"#f87171",fontWeight:700,marginBottom:4}}>⚠ DISCLAIMER</div>
              <p style={{fontSize:9,color:"#64748b",lineHeight:1.5,margin:0}}>All data is simulated for educational purposes only. Do not trade real capital based solely on these signals. Past accuracy does not guarantee future results. Consult a licensed financial advisor before executing trades.</p>
            </div>
          </div>
        </Panel>
      </div>}
    </main>

    <footer style={{borderTop:"1px solid #1e293b",padding:12,textAlign:"center",fontSize:9,color:"#334155",letterSpacing:".1em",textTransform:"uppercase"}}>
      Signal Stack Terminal v3 · {tradeMode} Mode · Educational Only · Not Financial Advice · Data Simulated
    </footer>
  </div>;
}