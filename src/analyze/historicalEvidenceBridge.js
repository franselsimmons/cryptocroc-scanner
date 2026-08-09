// ================= FILE: src/analyze/historicalEvidenceBridge.js =================
// Read-only bridge from validated historical evidence into weekly selection generation.
// Historical evidence may create OBSERVE preview candidates only.
// It can never manufacture a live PASSED gate and never writes live learning statistics.

import zlib from 'node:zlib';
import { getDurableRedis, getJson } from '../redis.js';
import { safeNumber } from '../utils.js';
import {
  HISTORICAL_GENERATED_FILE_VERSION,
  HISTORICAL_GENERATED_SIDE,
  HISTORICAL_GENERATED_AT,
  HISTORICAL_GENERATED_SELECTION_ELIGIBLE_FAMILIES,
  HISTORICAL_EVIDENCE_GZIP_BASE64,
  HISTORICAL_OUTCOMES_GZIP_BASE64
} from '../historical/generatedEvidence.js';

export const HISTORICAL_EVIDENCE_BRIDGE_VERSION = 'LONG_HISTORICAL_EVIDENCE_BRIDGE_FILE_FIRST_V2';
const SIDE = 'LONG';
const PREFIX = `${SIDE}:`;
const EVIDENCE_VERSION = 'LONG_HISTORICAL_WALK_FORWARD_EVIDENCE_V1';
const MAX_AGE_DAYS = Math.max(2, Number(process.env.HISTORICAL_EVIDENCE_MAX_AGE_DAYS || 14));
const DAY_MS = 86_400_000;

function now(){return Date.now();}
function upper(v=''){return String(v||'').trim().toUpperCase();}
function familyIdOf(row={}){const id=upper(row.trueMicroFamilyId||row.childTrueMicroFamilyId||row.microFamilyId||row.familyId);return /^MICRO_LONG_(BREAKOUT|RETEST|SWEEP_REVERSAL|CONTINUATION|COMPRESSION)_(TREND|CHOP|SQUEEZE)_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA)$/u.test(id)?id:null;}
async function mapLimit(items,limit,fn){const src=Array.from(items||[]),out=new Array(src.length);let c=0;async function w(){while(true){const i=c++;if(i>=src.length)return;out[i]=await fn(src[i],i);}}await Promise.all(Array.from({length:Math.min(Math.max(1,limit),Math.max(1,src.length))},()=>w()));return out;}
function liveCompleted(row={}){return Math.max(0,Math.floor(safeNumber(row.completedCurrentMeasurement??row.completed??row.outcomesCompleted,0)));}
function liveAvgR(row={}){return safeNumber(row.avgR??row.avgNetR,0);}

function decodeGeneratedJson(base64, fallback) {
  try {
    if (!base64) return fallback;
    return JSON.parse(zlib.gunzipSync(Buffer.from(String(base64), 'base64')).toString('utf8'));
  } catch {
    return fallback;
  }
}

function loadGeneratedFileBundle({ cutoffTs = now() } = {}) {
  const expectedFileVersion = 'LONG_HISTORICAL_GENERATED_FILE_V1';
  if (HISTORICAL_GENERATED_FILE_VERSION !== expectedFileVersion || HISTORICAL_GENERATED_SIDE !== SIDE) {
    return { ok:false, reason:'HISTORICAL_GENERATED_FILE_VERSION_MISMATCH', evidence:null, outcomesByFamily:new Map(), eligibleFamilyIds:[] };
  }
  const evidence = decodeGeneratedJson(HISTORICAL_EVIDENCE_GZIP_BASE64, null);
  const byFamily = decodeGeneratedJson(HISTORICAL_OUTCOMES_GZIP_BASE64, {});
  if (!evidence || evidence.side !== SIDE || evidence.historicalEvidenceVersion !== EVIDENCE_VERSION) {
    return { ok:false, reason:'HISTORICAL_GENERATED_FILE_EMPTY', evidence:null, outcomesByFamily:new Map(), eligibleFamilyIds:[] };
  }
  const generatedAt = safeNumber(evidence.generatedAt ?? HISTORICAL_GENERATED_AT, 0);
  if (generatedAt <= 0 || Math.max(0, cutoffTs - generatedAt) > MAX_AGE_DAYS * DAY_MS) {
    return { ok:false, reason:'HISTORICAL_GENERATED_FILE_STALE', evidence, outcomesByFamily:new Map(), eligibleFamilyIds:[] };
  }
  const declared = Array.isArray(HISTORICAL_GENERATED_SELECTION_ELIGIBLE_FAMILIES)
    ? HISTORICAL_GENERATED_SELECTION_ELIGIBLE_FAMILIES : [];
  const eligible = (Array.isArray(evidence.selectionEligibleFamilies) ? evidence.selectionEligibleFamilies : declared)
    .map(upper).filter((id) => familyIdOf({familyId:id}));
  const pairs = eligible.map((familyId) => [familyId, Array.isArray(byFamily?.[familyId]) ? byFamily[familyId] : []]);
  return {
    ok:true, reason:'HISTORICAL_EVIDENCE_READY_FROM_GENERATED_FILE',
    source:'GENERATED_REPOSITORY_FILE', bridgeVersion:HISTORICAL_EVIDENCE_BRIDGE_VERSION,
    evidence, outcomesByFamily:new Map(pairs), eligibleFamilyIds:eligible, redisReadRequired:false
  };
}

export async function loadHistoricalEvidenceBundle({cutoffTs=now()}={}){
  const fileBundle = loadGeneratedFileBundle({ cutoffTs });
  if (fileBundle.ok) return fileBundle;
  // Backward-compatible Vercel fallback only. GitHub Actions does not need Redis secrets.
  try {
    const redis=getDurableRedis();
    const evidence=await getJson(redis,`${PREFIX}HISTORICAL:EVIDENCE:V1`,null).catch(()=>null);
    if(!evidence||evidence.side!==SIDE||evidence.historicalEvidenceVersion!==EVIDENCE_VERSION) return fileBundle;
    const generatedAt=safeNumber(evidence.generatedAt,0);
    if(generatedAt<=0||Math.max(0,cutoffTs-generatedAt)>MAX_AGE_DAYS*DAY_MS) return fileBundle;
    const eligible=(Array.isArray(evidence.selectionEligibleFamilies)?evidence.selectionEligibleFamilies:[]).map(upper).filter((id)=>familyIdOf({familyId:id}));
    const pairs=await mapLimit(eligible,8,async familyId=>[familyId,await getJson(redis,`${PREFIX}HISTORICAL:OUTCOMES:V1:${familyId}`,[]).catch(()=>[])]);
    return {ok:true,reason:'HISTORICAL_EVIDENCE_READY_FROM_REDIS_FALLBACK',source:'REDIS_FALLBACK',bridgeVersion:HISTORICAL_EVIDENCE_BRIDGE_VERSION,evidence,outcomesByFamily:new Map(pairs.map(([id,rows])=>[id,Array.isArray(rows)?rows:[]])),eligibleFamilyIds:eligible,redisReadRequired:true};
  } catch {
    return fileBundle;
  }
}

export function mergeHistoricalSelectionMicros(liveMicros={},bundle={}){
  const result={...(liveMicros||{})};
  if(!bundle?.ok||!bundle?.evidence) return result;
  const familyRows=Array.isArray(bundle.evidence.familyRows)?bundle.evidence.familyRows:[];
  for(const historical of familyRows){
    if(historical?.selectionEligible!==true) continue;
    const id=upper(historical.familyId); if(!familyIdOf({familyId:id})) continue;
    const selection=historical.selectionRow||{};
    const live=result[id]||Object.values(result).find((row)=>familyIdOf(row)===id)||{};
    const n=liveCompleted(live), avg=liveAvgR(live);
    const livePassed=n>=35&&avg>0&&upper(live.activationGateStatus||live.familyGate||live.status)!=='EMPIRICAL_VETO';
    const liveHardVeto=n>=35&&avg<=0;
    const liveRestricted=!liveHardVeto&&((n>=20&&avg<=0)||(n>=12&&avg<=-0.10));
    const selectionAllowed=!liveHardVeto&&!liveRestricted;
    const forwardStatus=liveHardVeto?'BLOCKED':liveRestricted?'RESTRICTED':livePassed?'PASSED':'FORWARD_VALIDATING';
    const historicalCompleted=Math.max(0,Math.floor(safeNumber(selection.historicalCompleted??selection.completed,0)));
    // Historical-only evidence is intentionally capped below the live 35-outcome PASSED gate.
    // That lets OBSERVE preview discover candidates but cannot manufacture strict publish eligibility.
    const previewCompleted=Math.max(n,Math.min(34,Math.max(20,historicalCompleted)));
    const historicalAvg=safeNumber(selection.avgR??selection.avgNetR,0);
    result[id]={
      ...selection,
      ...live,
      trueMicroFamilyId:id,childTrueMicroFamilyId:id,microFamilyId:id,
      historicalEvidenceBridgeVersion:HISTORICAL_EVIDENCE_BRIDGE_VERSION,
      historicalStatus:historical.historicalStatus,
      historicalSelectionAllowed:selectionAllowed,
      forwardValidationStatus:forwardStatus,
      strictDiscordEligibleFromHistorical:false,
      liveForwardConfirmationRequired:true,
      historicalSelectionProjectionOnly:!livePassed,
      activationGateStatus:livePassed?'PASSED':liveHardVeto?'EMPIRICAL_VETO':'ACTIVE_LEARNING',
      familyGate:livePassed?'PASSED':liveHardVeto?'EMPIRICAL_VETO':'ACTIVE_LEARNING',
      learningStatus:livePassed?'PASSED':liveHardVeto?'EMPIRICAL_VETO':'ACTIVE_LEARNING',
      empiricalVeto:liveHardVeto||live.empiricalVeto===true,
      empiricalVetoed:liveHardVeto||live.empiricalVetoed===true,
      completedCurrentMeasurement:livePassed||!selectionAllowed?n:previewCompleted,
      completed:livePassed||!selectionAllowed?n:previewCompleted,
      avgR:livePassed||!selectionAllowed?avg:historicalAvg,
      avgNetR:livePassed||!selectionAllowed?avg:historicalAvg,
      fairWinrate:livePassed||!selectionAllowed?safeNumber(live.fairWinrate??live.winrate,0):safeNumber(selection.fairWinrate??selection.winrate,0),
      winrate:livePassed||!selectionAllowed?safeNumber(live.winrate??live.fairWinrate,0):safeNumber(selection.winrate??selection.fairWinrate,0)
    };
  }
  return result;
}
