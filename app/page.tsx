'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts'
import GlassCard from '@/components/brain/shared/GlassCard'
import _AnimatedCounter from '@/components/brain/shared/AnimatedCounter'
import StatusBadge from '@/components/brain/shared/StatusBadge'
import LoadingState from '@/components/brain/shared/LoadingState'
import SvgIcon from '@/components/brain/shared/SvgIcon'
import DeadSniperPanel from '@/components/brain/trading/dead-sniper-panel'
import BucketSniperV2 from '@/components/brain/trading/bucket-sniper-v2'
import { StatusCell } from '@/components/brain/trading/StatusCell'
import { FreshnessBar } from '@/components/brain/trading/FreshnessBar'
import LiveObservationsPanel, { type CityCardLite } from '@/components/brain/trading/LiveObservationsPanel'
import SniperIntelStrip from '@/components/brain/trading/SniperIntelStrip'
import UnifiedEngineBadge from '@/components/brain/trading/UnifiedEngineBadge'
import LiveBucketStrip from '@/components/brain/trading/LiveBucketStrip'
import CanonicalPeakBar from '@/components/brain/trading/CanonicalPeakBar'
import { usePathname } from 'next/navigation'
import { STATION_REGISTRY } from '@/lib/weather-cities'
import { type FreshnessPayload } from '@/lib/freshness'
import { authedFetch } from '@/lib/authed-fetch'
import { wilsonCI, wrRegime, bestIsDistinguishable } from '@/lib/wilson-ci'
import pkgJson from '@/package.json'
import {
  type DriftEvent,
  type SignalSnapshot,
  BANNER_TTL_MS,
  classifyDrift,
  diffSnapshots,
  formatBannerText,
  makeSnapshot,
  pruneExpired,
} from '@/lib/drift-detection'
import { compareCitiesByStatus } from '@/lib/city-status-sort'
import Logo from '@/components/Logo'
import PolymarketLogo from '@/components/PolymarketLogo'
import InfraCosts from '@/components/InfraCosts'
import DataProvenance from '@/components/DataProvenance'

/* ─── Status-grouped city sort ────────────────────────────────────────────────
 * Classification + comparator live in `@/lib/city-status-sort` (v3.77.20).
 * Shared with the weather-data page so every city list on the dashboard uses
 * the same LIVE > SLEEP > LOCKED ordering (v3.77.15 established the sort on
 * the trading page; v3.77.20 extracted it into a shared utility).
 * ─────────────────────────────────────────────────────────────────────────── */

/* ─── Types ───────────────────────────────────────────────── */

interface Position {
  asset: string
  conditionId: string
  market: string
  outcome: string
  outcomeIndex: number
  size: number
  avgPrice: number
  curPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  realizedPnl: number
  percentPnl: number
  closed: boolean
}

interface Trade {
  id: string
  timestamp: number
  market: string
  outcome: string
  side: string
  price: number
  size: number
}

interface PnlData {
  totalBuyUsdc: number
  totalSellUsdc: number
  totalRedeemUsdc: number
  totalRewardUsdc?: number
  totalReturnedUsdc?: number
  totalMarkets: number
  activityEntries?: number
  activityPages?: number
  activityComplete?: boolean
  activitySource?: 'api' | 'ledger'
}

interface BotConfig {
  [key: string]: unknown
  last_updated?: string
  updated_by?: string
}

interface WeatherCity {
  city: string
  station: string
  unit: 'F' | 'C'
  currentTemp: number | null
  dayHigh: number | null
  dataSource: string
  obsCount: number
  ecmwf: number | null
  gfs: number | null
  icon: number | null
  gem: number | null
  jma: number | null
  ensemble: number | null
  spread: number | null
  gap: number | null
  bestModel: string | null
  bestModelWR: number | null
  bestModelTemp: number | null
}

interface WeatherReport {
  timestamp: string
  cities: WeatherCity[]
}

interface BucketIntel {
  label: string
  lower: number
  upper: number
  yesPrice: number
  noPrice: number
  status: 'CONFIRMED_YES' | 'FADE_LOCK' | 'DEAD' | 'UNCERTAIN'
  edge: number | null
  ensembleProb: number | null
  recommendation: string
  // Phase 02.6 (project law 2026-04-07): empirical per-bucket probability from
  // the 730-day residual pipeline. `empProb` is null when the residual file has
  // fewer than 100 samples for this (city, model) pair.
  bucketType?: 'between' | 'exact' | 'wide_below' | 'wide_above'
  empProb?: number | null
  empN?: number
  empHits?: number
  probSource?: 'empirical' | 'insufficient_data'
}

interface WUCityIntel {
  city: string
  station: string
  unit: 'F' | 'C'
  timezone: string
  localTime: string
  localHour: number
  currentTemp: number | null
  runningHigh: number | null
  // v3.99.23: 3-source contract. NEVER blend these in the UI.
  // v1ArchiveHigh = pure WU V1 historical peak (PM resolution source). Lags up to 90m.
  // v3LiveCurrent = pure WU V3 current (may interpolate between METAR reports).
  // metarPeak = METAR body integer peak today (independent near-real-time cross-ref).
  v1ArchiveHigh: number | null
  v3LiveCurrent: number | null
  metarPeak: number | null
  obsCount: number
  highIsDeclining: boolean
  hoursSincePeak: number
  peakHourLocal: number
  peakMinuteLocal: number
  trendLabel: string
  wuLink: string
  weatherComLink: string
  resolutionLink?: string
  resolutionSource?: string
  polymarketUrl: string
  // v3.100.43: target market date (YYYY-MM-DD). Cascade fix in v3.100.41 can
  // jump the displayed buckets to a future date if today's market is missing.
  // UI must warn loudly when eventDate != city local today.
  eventDate?: string
  ecmwf: number | null
  gfs: number | null
  icon: number | null
  gem: number | null
  jma: number | null
  ensemble: number | null
  spread: number | null
  bestModel: string | null
  bestModelWR: number | null
  bestModelTemp: number | null
  // v3.99.78 — today-applicable model/WR (falls back to single-model when combo isn't firing)
  todayApplicableModel?: string | null
  todayApplicableWR?: number | null
  comboHistoricalWR?: number | null
  comboStatus?: 'NO_COMBO' | 'FIRING' | 'PENDING' | 'DISAGREEMENT' | 'INACTIVE'
  comboNotFiringReason?: string | null
  pendingModels?: string[]
  isAggregateWR?: boolean
  activeBuckets: BucketIntel[]
  liveMarkets?: number
  totalMarkets?: number
  recommendation: 'BUY' | 'FADE_BUY' | 'WATCH' | 'SKIP' | 'CLOSED'
  recommendationReason: string
  signalConfidence: 'HIGH' | 'MEDIUM' | 'LOW'
  obsTimeline?: { hour: number; minute: number; temp: number; label: string }[]
  metarTimeline?: { hour: number; minute: number; temp: number; label: string; timestamp?: number }[]
  metarHigh?: number | null
  metarCurrent?: number | null
  metarLastObsTime?: string | null
  // METAR reliability grade from backtest verification
  metarGrade?: 'A+' | 'A' | 'B+' | 'B' | 'C' | null
  metarMatchPct?: number | null
  // METAR dynamic interval detection — server-side computed (mirrors V1 algorithm)
  metarObsIntervalMin?: number | null
  metarLastObsTimestamp?: number | null
  metarTypicalMinutes?: number[]
  metarNextExpectedTimestamp?: number | null
  asosTimeline?: {
    hour: number
    minute: number
    temp: number
    label: string
    timestamp?: number
    source?: 'nws' | 'metar' | 'v3' | 'edge' | 'phone'
    precision?: string
  }[]
  asosHigh?: number | null
  asosCurrent?: number | null
  asosLastObsTime?: string | null
  // WU daily forecast predicted high/low
  wuFcstHigh?: number | null
  wuFcstLow?: number | null
  wuForecastWR?: number | null
  // Phase 02.6 Task 2 (project law 2026-04-07): WU-proxy WR labelled with the
  // best single NWP model. NOT real WU forecast WR — that data is impossible
  // until wu_forecast_archive matures past 2026-05-02. Stand-in only.
  bestNwpModel?: string | null
  bestNwpSingleWR?: number | null
  // Phase 02.6.2 HARD TRADE GATE (project law 2026-04-07): the API forces
  // tradeBlocked=true on cities whose ICAO resolution station was recently
  // changed and whose 730-day backtest residuals have not yet been recomputed.
  // The UI must refuse to render any tradable verdict for these cities and
  // must show a red banner with the reason.
  tradeBlocked?: boolean
  tradeBlockedReason?: string | null
  tradeBlockedOldStation?: string | null
  tradeBlockedNewStation?: string | null
  // v3.99.52 (project law 2026-04-19): station-change WARNING (soft, not a
  // hard block). Surfaces when the resolution station was recently
  // corrected — derived data (residuals, ground truth, ASOS 730d) may still
  // be keyed to the old station until the rebuild PR lands. the operator's rule
  // 2026-04-19: warn but do not block; the operator personally will not trade the
  // affected cities until cleared.
  stationWarning?: {
    oldStation: string
    newStation: string
    changedAt: string
    reason: string
  } | null
  // WU current conditions phrase (e.g. "Partly Cloudy")
  wuConditions?: string | null
  // WU hourly forecast — remaining hours through end of day
  wuHourlyForecast?: {
    hour: string
    temp: number
    conditions: string
    precipChance: number
    windSpeed: number
    cloudCover: number
  }[]
  // Dynamic interval detection — measured from actual data
  obsIntervalMin?: number | null
  lastObsTimestamp?: number | null
  lastObsLocalTime?: string | null
  nextExpectedTimestamp?: number | null
  typicalMinutes?: number[]
  wuWebsiteTime?: string | null
  wuWebsiteHigh?: number | null
  kalshiBuckets?: unknown[]
  kalshiUrl?: string | null
  // New: tier, FADE LOCK, center rate, per-city weights
  tier?: 'S' | 'A' | 'B' | 'C' | 'D'
  centerRate?: number | null
  isFadeLock?: boolean
  modelWeights?: Record<string, number>
  fadeLockData?: {
    peakHour: string
    peakPct: number
    window12to5Pct: number
    fade1hEvents: number
    fade1hHeldPct: number
    fade2hEvents: number
    fade2hHeldPct: number
    fade3hEvents: number
    fade3hHeldPct: number
  } | null
  tempPath?: {
    predictedBucket: string | null
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null
    closestBuckets: Array<{
      label: string
      days: number
      avgAtCurrentHour: number | null
      delta: number
      isMatch: boolean
      hourlyAvg: Record<number, number>
    }>
    currentTemp: number | null
    currentHour: number | null
    hours: number[]
  } | null
  // Clock-hour hold rates (2yr backtest)
  hourlyHoldRates?: Record<string, number> | null
  seasonalHoldRates?: Record<string, { h15: number; h16: number }> | null
  // Additional model forecasts
  ukmo?: number | null
  meteofrance?: number | null
  knmi?: number | null
  kma?: number | null
  cma?: number | null
  // Strategy metadata
  strategyName?: string | null
  strategyWR?: number | null
  betsPerYear?: number | null
  marketSpeed?: 'SLOW' | 'MEDIUM' | 'FAST' | null
  // WU V3 current conditions
  wxPhrase?: string
  windSpeed?: number | null
  windDirection?: string | null
  humidity?: number | null
  pressure?: number | null
  pressureTrend?: string | null
  // Open-Meteo current observations
  openMeteoObs?: {
    temperature: number | null
    windSpeed: number | null
    windDirection: number | null
    humidity: number | null
    cloudCover: number | null
    pressure: number | null
    precipitation: number | null
    conditions: string | null
    fcstHigh: number | null
    hourlyForecast: {
      hour: string
      temp: number
      conditions: string
      precipChance: number
      windSpeed: number
      cloudCover: number
    }[]
  } | null
  // Decoded METAR — actual station sensor data
  decodedMetar?: {
    temp: number | null
    dewpoint: number | null
    windSpeed: number | null
    windDirection: number | null
    windGust: number | null
    visibility: number | null
    pressure: number | null
    cloudCover: string | null
    clouds: { cover: string; base: number }[]
    conditions: string | null
    rawMetar: string | null
    obsTime: string | null
    fltCat: string | null
  } | null
  // AI Prediction Engine v2 (payload key jarvisPrediction is the upstream API contract)
  jarvisPrediction?: {
    prediction: number
    confidence: number
    standardDeviation: number
    method: 'ENSEMBLE' | 'TRAJECTORY' | 'CONFIRMED' | 'BLEND'
    adjustments: {
      ensembleRaw: number
      biasCorrection: number
      conditionBias: number
      trajectoryAdj: number
      marketSignal: number
      windAdj: number
      pressureAdj: number
      humidityAdj: number
      v1Floor: number
      total: number
    }
    bucketProbabilities: Record<string, number>
    marketEdge: Array<{
      bucket: string
      ourProb: number
      marketProb: number
      edge: number
      side: 'YES' | 'NO'
      recommendation: string
    }>
    consensus?: 'THREE_AGREE' | 'TWO_AGREE' | 'TIGHT_SPREAD' | 'SEASONAL_WEIGHTED' | 'NONE'
    consensusBucket?: number | null
    climatologyPeakHour?: number
  } | null
  // Dynamic signal — real-time WR based on live model agreement
  dynamicSignal?: {
    currentWR: number
    // Phase 02.6: the old city-wide "currentWR" kept for transparency only —
    // empirical per-bucket probs live on each BucketIntel.empProb now.
    modelAccuracy?: number
    method: 'CONSENSUS' | 'SINGLE_MODEL' | 'TIGHT_SPREAD'
    label: string
    modelsAgreeing: string[]
    agreedBucket: string | null
    bestSingleModel: string
    bestSingleWR: number
    consensusWR: number | null
    confidence: 'HIGH' | 'MEDIUM' | 'LOW'
    betsPerYear: number
    nBets: number
    signalAge: string
    // V2 Prediction Engine signals
    compositeConfidence: number
    seasonalWR: number
    seasonalRanking: string[]
    biasCorrection: number
    holdRate: number
    holdRateSeason: string
    holdRateHour: number | null
    // Phase 02.20.1: numeric bucket the signal recommends. Sniper card + popup
    // MUST both consume this so they never disagree on which bucket to bet.
    targetBucketNum: number | null
    expectedROI: number
    riskOfRuin: number
    // V3: Monthly WR
    monthlyWR: number | null
    monthlyWRMonth: string
    monthlyWRSample: number
    prevMonthWR: number | null
    prevMonthName: string
    // Phase 02.21 (2026-04-16): REAL monthly + seasonal WR from ASOS 730d
    seasonalWRAsos: number | null
    seasonalWRAsosN: number
    monthlyWRAsos: number | null
    monthlyWRAsosN: number
  } | null
  // Model change alerts
  modelChanges?: Array<{
    model: string
    oldValue: number
    newValue: number
    bucketChanged: boolean
    detectedAt: string
  }>
  // Per-model last-changed timestamps (detected from actual value changes)
  modelLastChanged?: Record<string, { at: string; oldValue: number; newValue: number }>
  tomorrowForecast?: {
    ecmwf: number | null
    gfs: number | null
    icon: number | null
    gem: number | null
    jma: number | null
    ukmo: number | null
    mf: number | null
    knmi: number | null
    kma: number | null
    cma: number | null
    graphcast: number | null
    best: number | null
    model: string
  } | null
  forecastDeltas?: {
    today: Record<string, { previous: number | null; delta: number | null; updatedAt: string }>
    tomorrow: Record<string, { previous: number | null; delta: number | null; updatedAt: string }>
  } | null
  // v3.76.6: 12-hour lookback from forecast_audit_snapshots. Always shows a prev
  // value even when the most recent cron write didn't change the stored number.
  forecastDeltas12h?: {
    today: Record<string, { value12hAgo: number | null; fetchedAt: string }>
    tomorrow: Record<string, { value12hAgo: number | null; fetchedAt: string }>
  } | null
  perModelWinRates?: Record<string, number> | null
  // v3.99.61 — sample-size stats paralleling perModelWinRates so the UI can
  // compute Wilson CI + suppress low-n cells. Same keys (short model names);
  // value is { rate (%), hits, attempts }.
  perModelWinRateStats?: Record<string, { rate: number; hits: number; attempts: number }> | null
  // v3.83.0: Polymarket WU audit-status classification per PM city.
  // - 'clean'        → Phase 02.15 V1 API verified ASOS≈WU equivalence (12 cities)
  // - 'contaminated' → Phase 02.15 V1 API flagged WU station drift (London — blocks tradable)
  // - 'unverified'   → only lower-fidelity buynosafe audit exists (Denver, LA — V1 audit pending Issue #493)
  // - 'unavailable'  → no WU station data (currently unused, reserved)
  // - null           → non-Polymarket city (no badge displayed)
  // See route.ts WU_AUDIT_STATUS constant for evidence + classification rules.
  wuAuditStatus?:
    | 'clean'
    | 'contaminated'
    | 'proxy_verified'
    | 'proxy_contaminated'
    | 'unverified'
    | 'unavailable'
    | null
  // v3.82.0: Full 25-model map surfaced from API. Keys are short model names
  // (gfs, ecmwf, icon, gem, jma, ukmo, meteofrance, knmi, cma, gfs_hrrr,
  // ecmwf_aifs, gem_hrdps, metno, dmi, arpege_world, jma_gsm, arome_fr,
  // arome_hd, arpege_eu, ukmo_2km, icon_d2, icon_eu, harmonie_nl,
  // harmonie_eu, metno_nordic). Values are bias-corrected today-high forecasts
  // or null if the city is outside the model's coverage.
  allModels?: Record<string, number | null>
  // METAR T-group precision data (0.1°C from METAR remarks)
  tgroupData?: {
    tempC: number
    tempF: number
    tempFRounded: number
    time: string
    rawMetar: string
  } | null
  // Data freshness — how stale is each source?
  dataFreshness?: {
    asosStaleMins: number | null
    phoneStaleMins: number | null
    edgeStaleMins: number | null
    tgroupAvailable: boolean
    asosCurrentSource: string // 'phone', 'metar', 'nws', 'v3', 'edge', 'none'
    displayedSourceStaleMins: number | null
  } | null
  // HKO Observatory data (Hong Kong only) — Polymarket resolution source
  hkoTemp?: number | null
  hkoDecimal?: {
    current: number | null
    runningHigh: number | null
    officialMax: number | null
    bucket: number | null
    readingCount: number
    isDecimal: boolean
  } | null
  // VHHH airport reference data (Hong Kong only)
  vhhhTemp?: number | null
  vhhhHigh?: number | null
  // HKO Observatory timeline (Hong Kong only) — resolution source readings from Supabase
  hkoTimeline?: {
    hour: number
    minute: number
    temp: number
    label: string
    timestamp: number
    officialMax: number | null
  }[]
  // HKO running daily max (Hong Kong only)
  hkoRunningMax?: number | null
  // Snipe strategy — penny snipe EV for current hour
  snipe?: {
    currentHourEV: number | null
    bestEntryPrice: number
    bestBuckets: number
    hitProbability: number
    roiPct: number
    holdRate: number
    phase: 'midnight' | 'morning' | 'afternoon' | null
  } | null
  // buyNoSafe: WU NEVER reports lower than METAR (730-day verified)
  buyNoSafe?: boolean
  // deadBucketNOs: dead buckets where NO is a guaranteed win
  deadBucketNOs?: {
    bucket: string
    noPrice: number
    profitPerShare: number
    quotedAt: string
    buyNoSafe: boolean
  }[]
  // v3.99.44: ENS freshness — populated alongside bucket_probs. ensStale=true
  // when the ENS bucket distribution is older than 90 minutes.
  ensFetchedAt?: string | null
  ensAgeMinutes?: number | null
  ensStale?: boolean
  // v3.99.42: runtime-detected model duplicates. child → parent pairs where
  // upstream Open-Meteo is serving byte-identical data (e.g. gfs_hrrr = gfs
  // in LA). Display-only decoration — does NOT affect consensus math.
  runtimeDuplicateModels?: Record<string, string> | null
  // v3.99.46: detected when jarvisPrediction (point estimate) and ensembleProb
  // top bucket disagree by ≥2°. The recommendation is still rendered; this
  // chip just warns the trader before sizing up.
  pipelineDisagreement?: {
    detected: boolean
    gap: number
    jpBucket: number
    ensTopBucket: number
    ensTopLabel: string
    ensTopProb: number | null
  } | null
  // v3.99.43: cache-forward staleness tracking. Populated by the weather-intel
  // cache-restore layer when a CRITICAL trading field was carried over from
  // the previous successful compute because the fresh compute returned null.
  _staleForecast?: boolean
  _staleFields?: string[]
  _staleFieldsMinor?: string[]
}

interface MetarReliabilityData {
  station: string
  totalDays: number
  exactMatchPct: number
  within1Pct: number
  within2Pct: number
  meanBias: number
  maxDisagreement: number
  obsPerDay: number
  reportingFreq: string
  has5minAsos: boolean
  v1LeadTimeMins: number
  dstIssue: boolean
  dstDates: string
  notes: string
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C'
}

interface SnipePlaybook {
  activePhase: 'midnight' | 'morning' | 'afternoon'
  topPlays: Array<{
    city: string
    entryPrice: number
    buckets: number
    hitProb: number
    ev: number
    roi: number
    holdRate: number
  }>
}

// City display names — use the full name always (project law 2026-04-16).
// Abbreviations like KL/LA/SF read as cheap; full names always.
const CITY_DISPLAY: Record<string, string> = {
  'san-francisco': 'San Francisco',
  'los-angeles': 'Los Angeles',
  'buenos-aires': 'Buenos Aires',
  'hong-kong': 'Hong Kong',
  'mexico-city': 'Mexico City',
  'panama-city': 'Panama City',
  'kuala-lumpur': 'Kuala Lumpur',
  'sao-paulo': 'São Paulo',
}
function cityDisplay(slug: string): string {
  return CITY_DISPLAY[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface PennyBid {
  city: string
  date: string
  bucket: string
  lower: number
  upper: number
  unit: string
  forecastHigh: number
  distFromForecast: number
  probability: number
  bidLadder: Array<{ price: number; shares: number; cost: number; potentialReturn: number; multiplier: number }>
  isTargetBucket: boolean
  polymarketSlug: string
  marketUrl: string
  currentYesPrice: number | null
  fillable?: boolean
  fillStatus?: 'PENNY' | 'CHEAP' | 'PRICED' | 'EXPENSIVE'
  smartAction?: string
  smartEntry?: number | null
  actualROI?: number | null
  bucketType?: 'wide_below' | 'wide_above' | 'between' | 'exact'
  sniperRank?: number // 1=primary, 2=alt, 0=avoid
  sniperReason?: string
  // Strategy cost fields
  mintShares?: number
  mintCost?: number
  extraYesShares?: number
  extraYesCost?: number
  totalDeployed?: number
  ifHitPnl?: number
  ifMissPnl?: number
  ifHitROI?: number
  breakEvenWR?: number
}

interface PennyBidCity {
  city: string
  unit: string
  timezone: string
  localTime: string
  localHour: number
  forecastHigh: number | null
  forecastModel?: string
  ecmwfForecast?: number | null
  forecastSpread: number | null
  totalBids: number
  totalCost: number
  expectedReturn: number
  expectedROI: number
  hitRate: number
  fillableBids?: number
  marketDepthOk?: boolean
  bids: PennyBid[]
}

interface PennyBidBoard {
  targetDate: string
  generatedAt: string
  totalCities: number
  totalBids: number
  totalCostAtPenny: number
  fillableBids?: number
  strategy: string
  strategyNote?: string
  totalMintCost?: number
  totalExtraYesCost?: number
  cities: PennyBidCity[]
}

interface HKOMultiStationResponse {
  stations: { place: string; value: number; unit: string }[]
  observatoryTemp: number | null
  minTemp: number | null
  maxTemp: number | null
  minPlace: string | null
  maxPlace: string | null
  spread: number | null
  observatoryVsMaxDelta: number | null
  observatoryVsMinDelta: number | null
  divergenceFlag: boolean
  recordTime: string | null
  fetchedAt: string
}

interface WeatherIntelResponse {
  timestamp: string
  cities: WUCityIntel[]
  metarReliability?: Record<string, MetarReliabilityData>
  snipePlaybook?: SnipePlaybook | null
  pennyBidBoard?: PennyBidBoard | null
  phoneEnabled?: boolean
  edgeLastUpdate?: string | null
  hongKongMultiStation?: HKOMultiStationResponse | null
}

interface EdgeStationReading {
  station: string
  city: string
  temp_f: number
  day_high_f: number
  source: string
  precision: string
  obs_time_utc: string
  captured_at: string
  bucket_status: Array<{ bucket: string; status: string }>
}

interface EdgeKill {
  station: string
  city: string
  bucket: string
  killed_at: string
  temp_at_kill: number
  v1_confirmed: boolean
  polymarket_yes_price: number | null
  minutes_since_kill: number
}

interface EdgePanelData {
  timestamp: string
  stations: Record<string, EdgeStationReading>
  kills_today: EdgeKill[]
}

interface ProfileStats {
  portfolioValue: number
  cashBalance: number
  biggestWin: number
  predictions: number
  activityEntries?: number
  activityPages?: number
  activityComplete?: boolean
  activitySource?: 'api' | 'ledger'
  pnl: Record<string, number>
}

interface SniperBotStatus {
  status: {
    timestamp: string
    version: string
    fills_today: number
    total_profit: number
    total_cost: number
    budget_spent?: number
    budget_remaining: number
    asks_seen: number
    dead_bucket_count: number
    websocket_status: string
    subscribed_tokens: number
    maker_bids_active: number
    cities: Record<
      string,
      {
        v1_high: number | null
        v3_current: number | null
        dead_buckets: string[]
        obs_count: number
        status?: string
        local_hour?: number
        rising?: boolean
        gap?: number
        metar?: number | null
      }
    >
    capital_recycling?: {
      enabled: boolean
      positions: Array<{
        city: string
        bucket: string
        side: string
        shares: number
        entry_price: number
        realized_pnl: number
        sell_orders: number
        token_id: string
      }>
      open_sells: number
      trades_today: number
      realized_pnl: number
      capital_recycled: number
      price_range: { min: number; max: number }
      scanning: boolean
    } | null
    self_learning?: {
      enabled: boolean
      transitions: number
      attempts: number
      fills: number
      current_fok_max: number
      min_fok: number
      max_fok: number
      last_adaptation: number
    } | null
    trades: Array<{
      city: string
      bucket: string
      price: number
      roi_pct: number
      cost: number
      profit: number
      type: string
      status: string
      time: string
    }>
    onchain_fills_today?: number
    onchain_sells_today?: number
    onchain_total_cost?: number
    onchain_sell_revenue?: number
    onchain_no_fills?: number
    onchain_no_cost?: number
    onchain_no_potential?: number
    onchain_total_trades?: number
    onchain_potential_roi?: number
    onchain_today_pnl?: number
    onchain_today_roi?: number
    onchain_trades_complete?: boolean
    onchain_trade_pages?: number
    onchain_trades?: Array<{
      time: string
      city: string
      bucket: string
      side: string
      outcome: string
      price: number
      size: number
      cost: number
      profit: number
      roi_pct: number
      status: string
      tx: string
    }>
    budget_total?: number
    scan_log?: Array<{ time: string; type: string; message: string; data?: Record<string, unknown> }>
    reports?: Array<{
      timestamp: string
      mode: string
      summary: {
        open_cities: number
        resolved_cities: number
        dead_buckets: number
        fills: number
        asks_seen: number
        maker_bids: number
        profit: number
      }
      open_cities: Array<{ city: string; v1_high: number; unit: string; local_hour: number; dead_count: number }>
      resolved_cities: Array<{ city: string; v1_high: number; unit: string }>
      self_checks: Array<{ check: string; status: string; detail: string }>
      all_checks_pass: boolean
      watching_next: Array<{ city: string; v1_high: number; v3_current: number; unit: string; reason: string }>
      narrative: string
    }>
  }
  config: {
    enabled: boolean
    mode: string
    daily_budget: number
    max_single_trade: number
    min_roi_pct: number
    maker_bid_enabled: boolean
    maker_bid_price: number
    fok_snipe_enabled: boolean
    fok_max_price: number
  }
}

interface StrategyTrade {
  bucket: string
  lower: number
  upper: number
  yesPrice: number
  noPrice?: number
  multiplier: number
  suggestedSize: number
  maxFillable: number
  actualSize: number
  expectedReturn: number
  bucketType: 'NO_CONVICTION' | 'NO_ELIMINATION'
  layer: 1 | 2 | 3
  edge?: number
  modelProb?: number
  orderType: 'LIMIT' | 'MARKET'
  limitOffset?: number
  timeoutMinutes?: number
  timeoutAction?: 'CANCEL_REPOST_AT_ASK' | 'BUMP_TO_ASK'
  reason: string
}

interface StrategyRec {
  city: string
  station: string
  unit: 'F' | 'C'
  localTime: string
  localHour: number
  currentTemp: number | null
  runningHigh: number | null
  trendLabel: string
  highIsDeclining: boolean
  weatherCondition: string
  weatherBias: 'OVER' | 'UNDER' | 'NEUTRAL'
  ensemble: number | null
  spread: number | null
  bestModel: string | null
  bestModelTemp: number | null
  conviction: 'HIGH' | 'MEDIUM' | 'LOW' | 'SKIP'
  convictionReasons: string[]
  trades: StrategyTrade[]
  inTradingWindow: boolean
  windowLabel: string
  budgetPhase: 'AM' | 'PM' | 'CLOSED'
  // Signal timing
  signalStatus: 'READY' | 'WAIT' | 'STALE'
  signalLabel: string
  bestModelCycle: string
  nextModelDrop: string
  hoursUntilSignal: number
  signalIsFresh: boolean
}

interface BotStrategyResponse {
  timestamp: string
  config: {
    dailyBudget: number
    amRatio: number
    pmRatio: number
    amBudget: number
    pmBudget: number
    layers: {
      l1: { noRange: string; sizeRange: string; maxPerDay: number; minEdge: string; minDegrees: number }
      l2: { noMin: string; size: string; maxPerDay: number; minDegrees: number }
      l3: { yesRange: string; sizeRange: string; maxPerDay: number; maxSpread: number; minConviction: number }
    }
  }
  summary: {
    totalCities: number
    layer1: { trades: number; exposure: number; avgEdge: number }
    layer2: { trades: number; exposure: number }
    layer3: { trades: number; exposure: number }
    totalExposure: number
    existingPositions: number
    existingCities: string[]
  }
  recommendations: StrategyRec[]
}

interface ActiveWxPosition {
  title: string
  city: string
  size: number
  avgPrice: number
  curPrice: number
  currentValue: number
  outcome: string
  runningHigh: number | null
  bucketCeiling: number | null
  health: 'ALIVE' | 'THREATENED' | 'DEAD'
  bestModel: string | null
  bestModelWR: number | null
}

interface ModelStatusData {
  timestamp: string
  positions: ActiveWxPosition[]
  summary: { total: number; alive: number; threatened: number; dead: number }
}

interface DailyScorecard {
  timestamp: string
  backtestPeriod: string
  totalDays: number
  dataVerified: string
  cityAccuracy: Record<string, { bestModel: string; winRate: number; mae: number }>
  topStrategies: { rank: number; name: string; win_rate: number; wins: number; total: number }[]
  overallWR: number | null
}

interface StrategyBreakdown {
  wins: number
  losses: number
  winRate: number
  profit: number
  roi: number
}

interface TradeScorecard {
  timestamp: string
  totalTrades: number
  totalResolved: number
  wins: number
  losses: number
  winRate: number
  totalInvested: number
  totalReturned: number
  totalProfit: number
  roi: number
  perCity: Record<
    string,
    {
      trades: number
      wins: number
      losses: number
      winRate: number
      invested: number
      profit: number
      roi: number
      bestTrade: { bucket: string; multiplier: number; profit: number } | null
    }
  >
  recentResolved: Array<{
    city: string
    bucket: string
    outcome: 'WIN' | 'LOSS'
    invested: number
    returned: number
    profit: number
    multiplier: number
    resolvedAt: string
  }>
  daily?: StrategyBreakdown
  weekly?: StrategyBreakdown
  byStrategy?: {
    sniper: StrategyBreakdown
    guaranteed: StrategyBreakdown
  }
}

type PositionFilter = 'all' | 'open' | 'closed' | 'weather' | 'nba' | 'soccer'

/* ─── Signal Schedule Data ─────────────────────────────────── */

// v3.99.49 (2026-04-19): full model roster. Every NWP model the engine actually
// consumes from Open-Meteo shows up here with its real run cadence, real
// provider delay (upper bound), and the perModelWinRates lookup key so the
// schedule's top-WR cities compute correctly. The prior 6-entry list only
// covered the globals that happened to also appear as a bestModel — that
// caused ICON (#1 single-model NYC but rarely strictly highest WR elsewhere)
// to display 0% in the TOP SIGNAL CITY slot.
//
// Fields:
//   model       — display name on the card
//   runsUTC     — the UTC run hours this model actually ships (not always 4x)
//   delayHours  — provider publish delay upper bound (Open-Meteo archive lag)
//   wrKey       — the short key used in weatherIntel.cities[].perModelWinRates
//   cadence     — grouping label ('4x/day' | '2x/day' | 'regional' | 'on-demand')
//   color/bg/border — accent colors (must stay consistent with pre-v3.99.49)
//   desc        — one-line description (kept terse; card shows top-3 WR cities
//                 inline instead of hard-coded anchor cities in the desc)
//   verifyUrl   — upstream forecast product page (opens in new tab)
interface SignalDef {
  model: string
  runsUTC: number[]
  delayHours: number
  wrKey: string
  cadence: '4x/day' | '2x/day' | 'regional' | 'on-demand'
  color: string
  bg: string
  border: string
  desc: string
  verifyUrl: string
}

const SIGNAL_SCHEDULE: SignalDef[] = [
  // ─── Global globals — 4x/day ────────────────────────────────────────────
  {
    model: 'ECMWF IFS',
    runsUTC: [0, 6, 12, 18],
    delayHours: 6,
    wrKey: 'ecmwf',
    cadence: '4x/day',
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/20',
    border: 'border-cyan-500/30',
    desc: 'European Centre — flagship deterministic global.',
    verifyUrl: 'https://charts.ecmwf.int/products/opcharts_d-hres-tmax',
  },
  {
    model: 'GFS',
    runsUTC: [0, 6, 12, 18],
    delayHours: 3.5,
    wrKey: 'gfs',
    cadence: '4x/day',
    color: 'text-green-400',
    bg: 'bg-green-500/20',
    border: 'border-green-500/30',
    desc: 'NOAA US global — strong US cities.',
    verifyUrl: 'https://www.tropicaltidbits.com/analysis/models/?model=gfs&region=us&pkg=T2m',
  },
  {
    model: 'ICON',
    runsUTC: [0, 6, 12, 18],
    delayHours: 2.5,
    wrKey: 'icon',
    cadence: '4x/day',
    color: 'text-amber-400',
    bg: 'bg-amber-500/20',
    border: 'border-amber-500/30',
    desc: 'DWD German global — key in 3-of-3 consensus strategies.',
    verifyUrl: 'https://www.tropicaltidbits.com/analysis/models/?model=icon&region=eu&pkg=T2m',
  },
  {
    model: 'JMA GSM',
    runsUTC: [0, 6, 12, 18],
    delayHours: 5,
    wrKey: 'jma',
    cadence: '4x/day',
    color: 'text-purple-400',
    bg: 'bg-purple-500/20',
    border: 'border-purple-500/30',
    desc: 'Japan Meteorological Agency — best for Asia-Pacific.',
    verifyUrl: 'https://www.tropicaltidbits.com/analysis/models/?model=jma&region=wpac&pkg=T2m',
  },
  {
    model: 'UKMO Global',
    runsUTC: [0, 6, 12, 18],
    delayHours: 4,
    wrKey: 'ukmo',
    cadence: '4x/day',
    color: 'text-rose-400',
    bg: 'bg-rose-500/20',
    border: 'border-rose-500/30',
    desc: 'UK Met Office — flagship for London + ensemble member.',
    verifyUrl: 'https://www.tropicaltidbits.com/analysis/models/?model=ukmet&region=eu&pkg=T2m',
  },
  {
    model: 'MeteoFrance ARPEGE',
    runsUTC: [0, 6, 12, 18],
    delayHours: 5,
    wrKey: 'mf',
    cadence: '4x/day',
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/20',
    border: 'border-indigo-500/30',
    desc: 'Météo-France ARPEGE world — strong for Europe.',
    verifyUrl: 'https://www.tropicaltidbits.com/analysis/models/?model=arpege&region=eu&pkg=T2m',
  },
  {
    model: 'KNMI Harmonie',
    runsUTC: [0, 6, 12, 18],
    delayHours: 4,
    wrKey: 'knmi',
    cadence: '4x/day',
    color: 'text-sky-400',
    bg: 'bg-sky-500/20',
    border: 'border-sky-500/30',
    desc: 'Dutch KNMI — high-res over NL/EU.',
    verifyUrl: 'https://www.knmi.nl/nederland-nu/weer/waarschuwingen-en-verwachtingen',
  },
  {
    model: 'CMA',
    runsUTC: [0, 6, 12, 18],
    delayHours: 5,
    wrKey: 'cma',
    cadence: '4x/day',
    color: 'text-red-400',
    bg: 'bg-red-500/20',
    border: 'border-red-500/30',
    desc: 'China Meteorological Administration — strong inside China.',
    verifyUrl: 'https://www.nmc.cn/publish/numericalforecast/tmp-t2m.html',
  },
  // ─── Globals — 2x/day ───────────────────────────────────────────────────
  {
    model: 'ECMWF AIFS',
    runsUTC: [0, 6, 12, 18],
    delayHours: 6,
    wrKey: 'ecmwf_aifs',
    cadence: '4x/day',
    color: 'text-teal-400',
    bg: 'bg-teal-500/20',
    border: 'border-teal-500/30',
    desc: 'AI/ML ensemble from ECMWF — newer, trained on IFS.',
    verifyUrl: 'https://charts.ecmwf.int/products/aifs_medium-mslp-wind850',
  },
  {
    model: 'GEM',
    runsUTC: [0, 12],
    delayHours: 4,
    wrKey: 'gem',
    cadence: '2x/day',
    color: 'text-orange-400',
    bg: 'bg-orange-500/20',
    border: 'border-orange-500/30',
    desc: 'Canadian CMC global — key signal for Toronto + US north.',
    verifyUrl: 'https://weather.gc.ca/ensemble/index_e.html',
  },
  {
    model: 'KMA GDAPS',
    runsUTC: [0, 12],
    delayHours: 4,
    wrKey: 'kma',
    cadence: '2x/day',
    color: 'text-pink-400',
    bg: 'bg-pink-500/20',
    border: 'border-pink-500/30',
    desc: 'Korea Meteorological Administration — inside Korea.',
    verifyUrl: 'https://www.weather.go.kr/w/weather/forecast/short-term.do',
  },
  {
    model: 'BOM ACCESS',
    runsUTC: [0, 12],
    delayHours: 5,
    wrKey: 'bom',
    cadence: '2x/day',
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/20',
    border: 'border-yellow-500/30',
    desc: 'Australian Bureau of Meteorology — Oceania.',
    verifyUrl: 'http://www.bom.gov.au/australia/charts/viewer/',
  },
  {
    model: 'MetNo',
    runsUTC: [0, 6, 12, 18],
    delayHours: 3,
    wrKey: 'metno',
    cadence: '4x/day',
    color: 'text-violet-400',
    bg: 'bg-violet-500/20',
    border: 'border-violet-500/30',
    desc: 'Norwegian MET — Nordic + global blend.',
    verifyUrl: 'https://www.yr.no/en',
  },
  {
    model: 'DMI HARMONIE',
    runsUTC: [0, 3, 6, 9, 12, 15, 18, 21],
    delayHours: 3,
    wrKey: 'dmi',
    cadence: '4x/day',
    color: 'text-fuchsia-400',
    bg: 'bg-fuchsia-500/20',
    border: 'border-fuchsia-500/30',
    desc: 'Danish Meteorological Institute — Nordic.',
    verifyUrl: 'https://www.dmi.dk/vejrarkiv/',
  },
  // ─── Regional / short-range ─────────────────────────────────────────────
  {
    model: 'HRRR',
    runsUTC: [0, 6, 12, 18],
    delayHours: 1.5,
    wrKey: 'gfs_hrrr',
    cadence: 'regional',
    color: 'text-lime-400',
    bg: 'bg-lime-500/20',
    border: 'border-lime-500/30',
    desc: 'NOAA rapid-refresh CONUS — US only, 3km.',
    verifyUrl: 'https://rapidrefresh.noaa.gov/hrrr/',
  },
  {
    model: 'HRDPS',
    runsUTC: [0, 6, 12, 18],
    delayHours: 1.5,
    wrKey: 'gem_hrdps',
    cadence: 'regional',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/20',
    border: 'border-emerald-500/30',
    desc: 'Canadian high-res — Canada/border, 2.5km.',
    verifyUrl: 'https://weather.gc.ca/grib/grib2_HRDPS_HR_e.html',
  },
  {
    model: 'AROME France',
    runsUTC: [0, 3, 6, 9, 12, 15, 18, 21],
    delayHours: 2,
    wrKey: 'arome_fr',
    cadence: 'regional',
    color: 'text-blue-400',
    bg: 'bg-blue-500/20',
    border: 'border-blue-500/30',
    desc: 'MeteoFrance AROME — Paris-region high-res.',
    verifyUrl: 'https://meteofrance.com/previsions-meteo-france/previsions-france',
  },
  {
    model: 'UKMO 2km',
    runsUTC: [0, 6, 12, 18],
    delayHours: 3,
    wrKey: 'ukmo_2km',
    cadence: 'regional',
    color: 'text-red-300',
    bg: 'bg-red-400/20',
    border: 'border-red-400/30',
    desc: 'UK Met Office 2km — London/UK high-res.',
    verifyUrl: 'https://www.metoffice.gov.uk/public/weather/forecast/',
  },
  {
    model: 'ICON-D2',
    runsUTC: [0, 3, 6, 9, 12, 15, 18, 21],
    delayHours: 1.5,
    wrKey: 'icon_d2',
    cadence: 'regional',
    color: 'text-amber-300',
    bg: 'bg-amber-400/20',
    border: 'border-amber-400/30',
    desc: 'DWD ICON-D2 — Germany high-res.',
    verifyUrl: 'https://www.dwd.de/DE/leistungen/opendata/opendata.html',
  },
  {
    model: 'ICON-EU',
    runsUTC: [0, 6, 12, 18],
    delayHours: 3,
    wrKey: 'icon_eu',
    cadence: 'regional',
    color: 'text-amber-200',
    bg: 'bg-amber-300/20',
    border: 'border-amber-300/30',
    desc: 'DWD ICON-EU — Europe 6km.',
    verifyUrl: 'https://www.dwd.de/DE/leistungen/opendata/opendata.html',
  },
  {
    model: 'JMA MSM',
    runsUTC: [0, 3, 6, 9, 12, 15, 18, 21],
    delayHours: 2,
    wrKey: 'jma_gsm',
    cadence: 'regional',
    color: 'text-purple-300',
    bg: 'bg-purple-400/20',
    border: 'border-purple-400/30',
    desc: 'JMA MSM — Japan high-res.',
    verifyUrl: 'https://www.jma.go.jp/jma/en/menu.html',
  },
  {
    model: 'Harmonie NL',
    runsUTC: [0, 6, 12, 18],
    delayHours: 2,
    wrKey: 'harmonie_nl',
    cadence: 'regional',
    color: 'text-sky-300',
    bg: 'bg-sky-400/20',
    border: 'border-sky-400/30',
    desc: 'KNMI Harmonie Netherlands.',
    verifyUrl: 'https://www.knmi.nl/',
  },
  {
    model: 'Harmonie EU',
    runsUTC: [0, 6, 12, 18],
    delayHours: 3,
    wrKey: 'harmonie_eu',
    cadence: 'regional',
    color: 'text-sky-200',
    bg: 'bg-sky-300/20',
    border: 'border-sky-300/30',
    desc: 'KNMI Harmonie EU 2.5km.',
    verifyUrl: 'https://www.knmi.nl/',
  },
  {
    model: 'MetNo Nordic',
    runsUTC: [0, 6, 12, 18],
    delayHours: 2,
    wrKey: 'metno_nordic',
    cadence: 'regional',
    color: 'text-violet-300',
    bg: 'bg-violet-400/20',
    border: 'border-violet-400/30',
    desc: 'MET Norway AROME-Nordic.',
    verifyUrl: 'https://www.yr.no/en',
  },
  {
    model: 'ARPEGE-EU',
    runsUTC: [0, 6, 12, 18],
    delayHours: 4,
    wrKey: 'arpege_eu',
    cadence: 'regional',
    color: 'text-indigo-300',
    bg: 'bg-indigo-400/20',
    border: 'border-indigo-400/30',
    desc: 'MeteoFrance ARPEGE Europe.',
    verifyUrl: 'https://meteofrance.com/',
  },
  {
    model: 'AROME HD',
    runsUTC: [0, 3, 6, 9, 12, 15, 18, 21],
    delayHours: 2,
    wrKey: 'arome_hd',
    cadence: 'regional',
    color: 'text-blue-300',
    bg: 'bg-blue-400/20',
    border: 'border-blue-400/30',
    desc: 'MeteoFrance AROME HD 1.3km.',
    verifyUrl: 'https://meteofrance.com/',
  },
  // ─── On-demand / AI ────────────────────────────────────────────────────
  {
    model: 'GraphCast',
    runsUTC: [0, 6, 12, 18],
    delayHours: 5,
    wrKey: 'graphcast',
    cadence: 'on-demand',
    color: 'text-slate-300',
    bg: 'bg-slate-400/20',
    border: 'border-slate-400/30',
    desc: 'Google DeepMind AI weather — research-grade.',
    verifyUrl:
      'https://deepmind.google/discover/blog/graphcast-ai-model-for-faster-and-more-accurate-global-weather-forecasting/',
  },
]

const RUN_TIMES_UTC = [0, 6, 12, 18] // legacy 4x/day (kept for back-compat callers)
const DELAY_HOURS: Record<string, number> = Object.fromEntries(SIGNAL_SCHEDULE.map((s) => [s.model, s.delayHours]))

function getActiveRun(modelName: string): number {
  // v3.99.49: look up this model's actual per-run schedule first so models
  // that don't run 4x/day (GEM, KMA, BOM = 2x; DMI/AROME/ICON-D2 = 8x) get
  // correct active-run indexing instead of being forced into the 00/06/12/18 grid.
  const sig = SIGNAL_SCHEDULE.find((s) => s.model === modelName)
  const runs = sig?.runsUTC ?? RUN_TIMES_UTC
  const delay = sig?.delayHours ?? DELAY_HOURS[modelName] ?? 4
  const now = new Date()
  const utcFrac = now.getUTCHours() + now.getUTCMinutes() / 60
  let activeIdx = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (utcFrac >= runs[i] + delay) {
      activeIdx = i
      break
    }
  }
  return activeIdx
}

function utcToET(h: number): string {
  // Use Intl to handle DST automatically
  const now = new Date()
  now.setUTCHours(h, 0, 0, 0)
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true })
  return `${etStr} ET`
}

/** Returns a human-readable string describing the last available run for a model */
function _getModelLastRunLabel(modelName: string): string {
  const idx = getActiveRun(modelName)
  if (idx < 0 || idx >= RUN_TIMES_UTC.length) return 'Last: unknown'
  const runZ = `${String(RUN_TIMES_UTC[idx]).padStart(2, '0')}Z`
  const delay = DELAY_HOURS[modelName] || 4
  const availableUTC = RUN_TIMES_UTC[idx] + delay
  const etLabel = utcToET(availableUTC % 24)
  return `Last: ${runZ} run (avail ~${etLabel})`
}

/** Map tooltip short names → DELAY_HOURS keys */
const MODEL_DISPLAY_TO_DELAY_KEY: Record<string, string> = {
  GFS: 'GFS',
  ICON: 'ICON',
  ECMWF: 'ECMWF IFS',
  JMA: 'JMA',
  UKMO: 'UKMO',
  MF: 'MeteoFrance',
  GEM: 'GFS',
  KMA: 'JMA',
  KNMI: 'ECMWF IFS',
  CMA: 'JMA',
  AIFS: 'ECMWF IFS',
  HRRR: 'GFS',
  HRDPS: 'GFS',
  METNO: 'ECMWF IFS',
  DMI: 'ECMWF IFS',
  ARPW: 'MeteoFrance',
  JGSM: 'JMA',
  AROME: 'MeteoFrance',
  AMHD: 'MeteoFrance',
  ARPE: 'MeteoFrance',
  UK2k: 'UKMO',
  ICD2: 'ICON',
  ICEU: 'ICON',
  HRNL: 'ECMWF IFS',
  HREU: 'ECMWF IFS',
  NORD: 'ECMWF IFS',
  GCAST: 'GFS',
}

interface ModelRunInfo {
  lastRunZ: string // e.g. "12Z"
  hoursAgo: number // hours since this run's data became available
  nextRunZ: string // e.g. "18Z"
  nextAvailIn: string // e.g. "2h 15m"
  freshness: 'fresh' | 'aging' | 'stale' // <2h fresh, <4h aging, >4h stale
  // Phase 02.6 (the operator 2026-04-07): absolute Puerto Rico time of when this
  // model run's data became available (AST). Computed from the SCHEDULED run
  // time + delay, not from the upstream response timestamp — Open-Meteo's free
  // endpoint does not expose the actual archive write time.
  lastRunAvailAST: string // e.g. "1:08 AM AST"
  lastRunAvailISO: string // ISO 8601 for tooltip / sorting
}

// v3.99.13 — region-gated model badge. Some NWP models only serve data for a
// specific geographic domain (HRRR = US CONUS, HRDPS = Canada/border,
// AROME = France, UK2k = UK, etc). When a model has no value for a city,
// distinguish "legitimately out of domain" from "data gap" so the popup
// shows "— US-only" instead of a bare "—" which reads like broken data.
const US_CITIES = new Set([
  'atlanta',
  'austin',
  'chicago',
  'dallas',
  'denver',
  'houston',
  'los-angeles',
  'miami',
  'nyc',
  'san-francisco',
  'seattle',
])
const CA_BORDER_CITIES = new Set([
  ...US_CITIES, // HRDPS extends into CONUS border latitudes
  'toronto',
])
function regionGateLabel(displayName: string, city: string): string | null {
  const name = displayName.toUpperCase()
  if (name === 'HRRR' && !US_CITIES.has(city)) return '— US-only'
  if (name === 'HRDPS' && !CA_BORDER_CITIES.has(city)) return '— CA-only'
  if (name === 'BOM') return '— Oceania-only' // every non-Australia city
  if (name === 'AROME' && city !== 'paris') return '— FR-only'
  if (name === 'AMHD' && city !== 'paris') return '— FR-only'
  if (name === 'UK2K' && city !== 'london') return '— UK-only'
  if (name === 'ICD2' && !['munich', 'milan', 'amsterdam'].includes(city)) return '— DE-only'
  if (name === 'HRNL' && city !== 'amsterdam') return '— NL-only'
  if (
    (name === 'HREU' || name === 'ICEU' || name === 'ARPE') &&
    !['amsterdam', 'london', 'paris', 'munich', 'milan', 'madrid', 'helsinki', 'warsaw', 'ankara'].includes(city)
  ) {
    return '— EU-only'
  }
  if (name === 'NORD' && city !== 'helsinki') return '— Nordic-only'
  return null
}

// v3.99.11 — display-name → short-key for per-model updated_at lookup.
// When a call site has access to the city object, it can pass
// `c.perModelUpdatedAt` and getModelRunInfo will find the right short key
// automatically. That avoids wiring every one of 12+ call sites explicitly.
const DISPLAY_TO_SHORT_KEY: Record<string, string> = {
  GFS: 'gfs',
  ICON: 'icon',
  ECMWF: 'ecmwf',
  GEM: 'gem',
  UKMO: 'ukmo',
  MF: 'mf',
  KNMI: 'knmi',
  JMA: 'jma',
  CMA: 'cma',
  AIFS: 'ecmwf_aifs',
  HRRR: 'gfs_hrrr',
  HRDPS: 'gem_hrdps',
  METNO: 'metno',
  DMI: 'dmi',
  ARPW: 'arpege_world',
  JGSM: 'jma_gsm',
  BOM: 'bom',
  GCAST: 'graphcast',
  AROME: 'arome_fr',
  AMHD: 'arome_hd',
  ARPE: 'arpege_eu',
  UK2k: 'ukmo_2km',
  ICD2: 'icon_d2',
  ICEU: 'icon_eu',
  HRNL: 'harmonie_nl',
  HREU: 'harmonie_eu',
  NORD: 'metno_nordic',
}

/** Get detailed run timing info for a model.
 *
 * v3.99.11: the caller can pass either:
 *   - `actualUpdatedAt`: an ISO string for THIS specific model, OR
 *   - `perModelUpdatedAt`: the whole city blob — the function looks up
 *     the short key via `DISPLAY_TO_SHORT_KEY[displayName]`.
 *
 * When a real timestamp is found, "Updated Nm ago / AST" reflects DB truth.
 * Otherwise falls back to the legacy schedule calc (same as pre-fix).
 * `lastRunZ` / `nextRunZ` / `nextAvailIn` always come from the NWP schedule —
 * those are upstream-cadence facts, not "when was my DB row written" facts.
 */
function getModelRunInfo(
  displayName: string,
  actualUpdatedAt?: string | null | Record<string, string | null | undefined>,
): ModelRunInfo {
  // Normalise: actualUpdatedAt can be a string (specific model) or a record
  // (city's perModelUpdatedAt blob) — in the latter case, look up the short key.
  let resolvedUpdatedAt: string | null | undefined = null
  if (typeof actualUpdatedAt === 'string') {
    resolvedUpdatedAt = actualUpdatedAt
  } else if (actualUpdatedAt && typeof actualUpdatedAt === 'object') {
    const short = DISPLAY_TO_SHORT_KEY[displayName]
    if (short) resolvedUpdatedAt = actualUpdatedAt[short] ?? null
  }

  const delayKey = MODEL_DISPLAY_TO_DELAY_KEY[displayName] || displayName
  const delay = DELAY_HOURS[delayKey] || 4
  const now = new Date()
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60

  // Find the most recent run whose data is ACTUALLY available now.
  // Walk backwards through today's runs first, then wrap to yesterday.
  let activeIdx = -1
  for (let i = RUN_TIMES_UTC.length - 1; i >= 0; i--) {
    if (utcH >= RUN_TIMES_UTC[i] + delay) {
      activeIdx = i
      break
    }
  }

  let scheduleHoursAgo: number
  let lastRunZ: string
  if (activeIdx >= 0) {
    // Found a run today whose data is available
    const lastRun = RUN_TIMES_UTC[activeIdx]
    lastRunZ = `${String(lastRun).padStart(2, '0')}Z`
    scheduleHoursAgo = utcH - (lastRun + delay)
  } else {
    // No run available today yet -- wrap to yesterday's latest run
    // Use the last run in the schedule (e.g. 18Z from yesterday)
    const lastRun = RUN_TIMES_UTC[RUN_TIMES_UTC.length - 1]
    lastRunZ = `${String(lastRun).padStart(2, '0')}Z`
    const availableAtYesterday = lastRun + delay // e.g. 18 + 3.5 = 21.5 UTC yesterday
    scheduleHoursAgo = utcH + (24 - availableAtYesterday) // hours since yesterday's availability
    activeIdx = RUN_TIMES_UTC.length - 1
  }

  // Next run (always from schedule — upstream cadence fact)
  const nextIdx = (activeIdx + 1) % RUN_TIMES_UTC.length
  const nextRun = RUN_TIMES_UTC[nextIdx]
  const nextRunZ = `${String(nextRun).padStart(2, '0')}Z`
  const nextAvailUTC = nextRun + delay
  const hoursUntilNext = nextAvailUTC > utcH ? nextAvailUTC - utcH : 24 - utcH + nextAvailUTC
  const h = Math.floor(hoursUntilNext)
  const m = Math.round((hoursUntilNext - h) * 60)
  const nextAvailIn = h > 0 ? `${h}h ${m}m` : `${m}m`

  // v3.99.15 — project law (2026-04-18): "Updated X AST" MUST reflect when
  // the UPSTREAM NWP model published its latest run (e.g. GFS publishes 4x/day
  // at 00Z+3.5h, 06Z+3.5h, 12Z+3.5h, 18Z+3.5h). That's the schedule-based
  // calculation. v3.99.11 briefly replaced this with Supabase `updated_at`
  // (DB write time) which was wrong for a trading dashboard — the trader
  // cares about upstream publication recency, not cron batch timing.
  //
  // perModelUpdatedAt (the DB timestamp) is still emitted for potential
  // secondary "ingested N min ago" UI in a future ship but does NOT override
  // the primary "Updated" label.
  const hoursAgo = scheduleHoursAgo
  const lastRunAvailDate = new Date(now.getTime() - scheduleHoursAgo * 3600_000)
  void resolvedUpdatedAt // reserved for secondary label later

  const freshness: ModelRunInfo['freshness'] = hoursAgo < 2 ? 'fresh' : hoursAgo < 4 ? 'aging' : 'stale'

  // Puerto Rico time the row actually landed (or when the schedule says it became available).
  const lastRunAvailAST =
    lastRunAvailDate.toLocaleTimeString('en-US', {
      timeZone: 'America/Puerto_Rico',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }) + ' AST'
  const lastRunAvailISO = lastRunAvailDate.toISOString()

  return { lastRunZ, hoursAgo, nextRunZ, nextAvailIn, freshness, lastRunAvailAST, lastRunAvailISO }
}

/* ─── Per-city model win rates — sourced from API (perModelWinRates, bestModel, bestModelWR) ─── */
// Previously hardcoded as CITY_MODEL_WR. Now reads from weatherIntel.cities to prevent drift.

const SIGNAL_MODEL_KEY: Record<string, string> = {
  'ECMWF IFS': 'ECMWF',
  GFS: 'GFS',
  ICON: 'ICON',
  JMA: 'JMA',
  UKMO: 'UKMO',
  MeteoFrance: 'MeteoFrance',
  ENSEMBLE: 'ENSEMBLE',
}

/** Special-case slug-to-label mapping; fallback: title-case with hyphens → spaces */
const CITY_LABEL_OVERRIDES: Record<string, string> = {
  nyc: 'NYC',
  'sao-paulo': 'Sao Paulo',
  'buenos-aires': 'Buenos Aires',
  'hong-kong': 'Hong Kong',
  'mexico-city': 'Mexico City',
}

function citySlugToLabel(slug: string): string {
  if (CITY_LABEL_OVERRIDES[slug]) return CITY_LABEL_OVERRIDES[slug]
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function getCitiesForModel(
  modelName: string,
  apiCities: WUCityIntel[],
): { slug: string; label: string; winRate: number }[] {
  // v3.99.49 (project law 2026-04-19): rewrite to use `perModelWinRates[wrKey]`
  // directly. The old implementation filtered on `bestModel === key`, which
  // only surfaced cities where this specific model was the SINGLE top model —
  // so ICON (often #2 behind GFS in US cities) returned zero cities and the
  // Top Signal City slot displayed 0%. The correct question is "where is THIS
  // model's win rate strongest?", regardless of whether it's the overall best.
  const sig = SIGNAL_SCHEDULE.find((s) => s.model === modelName)
  const wrKey = sig?.wrKey ?? SIGNAL_MODEL_KEY[modelName] ?? modelName
  return apiCities
    .map((c) => {
      const rates = c.perModelWinRates ?? {}
      const raw = (rates as Record<string, number | undefined>)[wrKey]
      const winRate = typeof raw === 'number' ? Math.round(raw * 10) / 10 : 0
      return { slug: c.city, label: citySlugToLabel(c.city), winRate }
    })
    .filter((c) => c.winRate > 0)
    .sort((a, b) => b.winRate - a.winRate)
}

interface NextDrop {
  model: string
  runLabel: string
  dropTimeUTC: number
  hoursUntil: number
  cities: { slug: string; label: string; winRate: number }[]
  bestCity: string
  bestWR: number
  color: string
  bg: string
  border: string
}

function getNextSignalDrops(apiCities: WUCityIntel[]): NextDrop[] {
  // v3.99.49: iterate each model's actual `runsUTC` so GEM (2x) and AROME
  // France (8x) enumerate their true drop times instead of the old shared
  // 4x grid. Also pass `nowMs` so the caller can tick every second without
  // every consumer re-reading the date.
  const now = new Date()
  const utcH = now.getUTCHours()
  const utcM = now.getUTCMinutes()
  const utcS = now.getUTCSeconds()
  const currentFrac = utcH + utcM / 60 + utcS / 3600

  const drops: NextDrop[] = []

  for (const s of SIGNAL_SCHEDULE) {
    const delay = s.delayHours
    const cities = getCitiesForModel(s.model, apiCities)
    const best = cities[0]

    for (let i = 0; i < s.runsUTC.length; i++) {
      const runTime = s.runsUTC[i]
      const dropTime = runTime + delay
      let hoursUntil = dropTime - currentFrac
      if (hoursUntil <= 0) hoursUntil += 24

      drops.push({
        model: s.model,
        runLabel: `${String(runTime).padStart(2, '0')}Z`,
        dropTimeUTC: dropTime % 24,
        hoursUntil,
        cities,
        bestCity: best?.label || '',
        bestWR: best?.winRate || 0,
        color: s.color,
        bg: s.bg,
        border: s.border,
      })
    }
  }

  drops.sort((a, b) => a.hoursUntil - b.hoursUntil)
  return drops
}

interface LastDrop {
  model: string
  runLabel: string
  dropTimeUTC: number
  minutesAgo: number
  cities: { slug: string; label: string; winRate: number }[]
  bestCity: string
  bestWR: number
  color: string
  bg: string
  border: string
}

function getLastSignalDrop(apiCities: WUCityIntel[]): LastDrop | null {
  // v3.99.49: same per-model runsUTC change as getNextSignalDrops. Models
  // with 2x/day or 8x/day cadence were being marked "dropped N hours ago"
  // against the 4x grid; now uses their real runs.
  const now = new Date()
  const currentFrac = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600

  let best: LastDrop | null = null

  for (const s of SIGNAL_SCHEDULE) {
    const delay = s.delayHours
    const cities = getCitiesForModel(s.model, apiCities)
    const topCity = cities[0]

    for (let i = 0; i < s.runsUTC.length; i++) {
      const runTime = s.runsUTC[i]
      const dropTime = runTime + delay
      let minutesAgo = (currentFrac - dropTime) * 60
      if (minutesAgo < 0) minutesAgo += 24 * 60 // wrapped to previous day

      // Only consider drops that have already happened
      if (minutesAgo >= 0 && (!best || minutesAgo < best.minutesAgo)) {
        best = {
          model: s.model,
          runLabel: `${String(runTime).padStart(2, '0')}Z`,
          dropTimeUTC: dropTime % 24,
          minutesAgo,
          cities,
          bestCity: topCity?.label || '',
          bestWR: topCity?.winRate || 0,
          color: s.color,
          bg: s.bg,
          border: s.border,
        }
      }
    }
  }

  return best
}

function formatAgo(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m ago`
  return `${h}h ${m}m ago`
}

function isoTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatCountdown(hours: number): string {
  const totalSec = Math.max(0, Math.floor(hours * 3600))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h === 0 && m === 0) return `${s}s`
  if (h === 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
}

// v3.99.49: Compact countdown for tight spaces (Up Next queue). Keeps
// just H/M so the queue rows stay on one line, but updates every second.
function formatCountdownCompact(hours: number): string {
  const totalMin = Math.max(0, Math.floor(hours * 60))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

// Weather condition phrase → emoji icon for hourly forecast display
const WX_SUN = (
  <g>
    <circle cx="8" cy="8" r="3" fill="#fbbf24" />
    <g stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round">
      <line x1="8" y1="1" x2="8" y2="2.8" />
      <line x1="8" y1="13.2" x2="8" y2="15" />
      <line x1="1" y1="8" x2="2.8" y2="8" />
      <line x1="13.2" y1="8" x2="15" y2="8" />
      <line x1="3.05" y1="3.05" x2="4.3" y2="4.3" />
      <line x1="11.7" y1="11.7" x2="12.95" y2="12.95" />
      <line x1="3.05" y1="12.95" x2="4.3" y2="11.7" />
      <line x1="11.7" y1="4.3" x2="12.95" y2="3.05" />
    </g>
  </g>
)
const WX_CLOUD = (fill: string, small = false) =>
  small ? (
    <path d="M9.2 14.6H4.9a2.4 2.4 0 0 1-.4-4.77 3.1 3.1 0 0 1 5.9-.83 2.35 2.35 0 0 1-1.2 5.6z" fill={fill} />
  ) : (
    <path d="M11.4 13H4.4a2.9 2.9 0 0 1-.45-5.77A3.9 3.9 0 0 1 11.5 6.1 3 3 0 0 1 11.4 13z" fill={fill} />
  )
const WX_ICONS: Record<string, React.ReactNode> = {
  CLR: WX_SUN,
  NT: <path d="M12.6 10.2A5.4 5.4 0 0 1 5.8 3.4 5.4 5.4 0 1 0 12.6 10.2z" fill="#cbd5e1" />,
  FEW: (
    <g>
      {WX_SUN}
      {WX_CLOUD('#d1d5db', true)}
    </g>
  ),
  SCT: (
    <g>
      <g transform="translate(1.5,-1.5)">{WX_SUN}</g>
      {WX_CLOUD('#d1d5db')}
    </g>
  ),
  BKN: (
    <g>
      <g transform="translate(3,-2) scale(0.8)">{WX_SUN}</g>
      {WX_CLOUD('#9ca3af')}
    </g>
  ),
  OVC: WX_CLOUD('#9ca3af'),
  FG: (
    <g stroke="#9ca3af" strokeWidth="1.4" strokeLinecap="round">
      <line x1="2" y1="5" x2="14" y2="5" />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="2" y1="11" x2="14" y2="11" />
    </g>
  ),
  RA: (
    <g>
      <g transform="translate(0,-1.5)">{WX_CLOUD('#9ca3af')}</g>
      <g stroke="#60a5fa" strokeWidth="1.3" strokeLinecap="round">
        <line x1="5" y1="13" x2="4.4" y2="15" />
        <line x1="8" y1="13" x2="7.4" y2="15" />
        <line x1="11" y1="13" x2="10.4" y2="15" />
      </g>
    </g>
  ),
  SHRA: (
    <g>
      <g transform="translate(0,-1.5)">{WX_CLOUD('#d1d5db')}</g>
      <g stroke="#60a5fa" strokeWidth="1.3" strokeLinecap="round">
        <line x1="6" y1="13" x2="5.4" y2="15" />
        <line x1="10" y1="13" x2="9.4" y2="15" />
      </g>
    </g>
  ),
  SN: (
    <g>
      <g transform="translate(0,-1.5)">{WX_CLOUD('#d1d5db')}</g>
      <g fill="#e5e7eb">
        <circle cx="5" cy="13.7" r="0.9" />
        <circle cx="8" cy="14.6" r="0.9" />
        <circle cx="11" cy="13.7" r="0.9" />
      </g>
    </g>
  ),
  TS: (
    <g>
      <g transform="translate(0,-1.5)">{WX_CLOUD('#6b7280')}</g>
      <path d="M8.6 10.2 6.4 13.4h1.7l-1 2.6 3.1-3.6H8.5l1.2-2.2z" fill="#facc15" />
    </g>
  ),
  FZ: (
    <g>
      <g transform="translate(0,-1.5)">{WX_CLOUD('#d1d5db')}</g>
      <path d="M8 12.4l1.5 1.9a1.9 1.9 0 1 1-3 0z" fill="#22d3ee" />
    </g>
  ),
  WND: (
    <g stroke="#94a3b8" strokeWidth="1.4" strokeLinecap="round" fill="none">
      <path d="M2 6h8a2 2 0 1 0-2-2" />
      <path d="M2 10h10a2 2 0 1 1-2 2" />
    </g>
  ),
  DEFAULT: <circle cx="8" cy="8" r="2.5" fill="#94a3b8" />,
}
// SNOW SHOWER reuses SN; keep key for the classifier below
WX_ICONS.SHSN = WX_ICONS.SN

const wxMini = (children: React.ReactNode, label: string) => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" className="inline-block align-[-0.15em] mr-0.5" aria-label={label} role="img">
    {children}
  </svg>
)
const WX_MINI_WIND = wxMini(WX_ICONS.WND, 'wind')
const WX_MINI_DROP = wxMini(<path d="M8 1.8l3 4.2a3.7 3.7 0 1 1-6 0z" fill="#60a5fa" />, 'humidity')
const WX_MINI_CLOUD = wxMini(WX_CLOUD('#9ca3af'), 'cloud cover')

function weatherIcon(condition: string, hourLabel?: string): React.ReactNode {
  if (!condition) return null
  const c = condition.toLowerCase()
  // Determine if it's nighttime from hour label (e.g. "9 PM", "11 PM", "5 AM")
  const isNight = (() => {
    if (!hourLabel) return false
    const m = hourLabel.match(/^(\d{1,2})\s*(AM|PM)$/i)
    if (!m) return false
    let h = parseInt(m[1])
    const ampm = m[2].toUpperCase()
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    return h >= 19 || h < 6 // 7 PM to 6 AM = night
  })()
  const key = (() => {
    if (c.includes('thunder')) return 'TS'
    if (c.includes('freezing rain') || c.includes('sleet') || c.includes('ice')) return 'FZ'
    if (c.includes('snow shower')) return 'SHSN'
    if (c.includes('snow') || c.includes('flurr')) return 'SN'
    if (c.includes('heavy rain') || c.includes('downpour')) return 'RA'
    if (c.includes('rain') || c.includes('shower')) return 'RA'
    if (c.includes('drizzle')) return 'SHRA'
    if (c.includes('fog') || c.includes('mist') || c.includes('haze') || c.includes('hazy')) return 'FG'
    if (c.includes('overcast') || (c.includes('cloudy') && !c.includes('partly') && !c.includes('mostly clear')))
      return 'OVC'
    if (c.includes('mostly cloudy') || c.includes('broken')) return isNight ? 'OVC' : 'BKN'
    if (c.includes('partly cloudy') || c.includes('partly sunny') || c.includes('scattered'))
      return isNight ? 'OVC' : 'SCT'
    if (c.includes('mostly clear') || c.includes('mostly sunny') || c.includes('fair')) return isNight ? 'NT' : 'FEW'
    if (c.includes('clear') || c.includes('sunny')) return isNight ? 'NT' : 'CLR'
    if (c.includes('wind')) return 'WND'
    return 'DEFAULT'
  })()
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      className="inline-block align-[-0.15em]"
      aria-label={condition}
      role="img"
    >
      {WX_ICONS[key]}
    </svg>
  )
}

function degreesToCompass(deg: number | null): string {
  if (deg === null || deg === undefined) return ''
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return dirs[Math.round(deg / 22.5) % 16]
}

/* ─── Stability Assessment (plain-English weather danger signals) ───── */

type StabilityLevel = 'GREEN' | 'YELLOW' | 'RED'
interface StabilityAssessment {
  level: StabilityLevel
  label: string
  summary: string
  factors: string[]
}

function getStabilityAssessment(c: {
  decodedMetar?: {
    windSpeed: number | null
    windGust: number | null
    windDirection: number | null
    visibility: number | null
    clouds: { cover: string; base: number }[]
    conditions: string | null
    rawMetar: string | null
    temp: number | null
    dewpoint: number | null
    pressure: number | null
  } | null
  pressureTrend?: string | null
  station?: string
}): StabilityAssessment | null {
  const m = c.decodedMetar
  if (!m) return null

  const factors: string[] = []
  let score = 0 // 0 = green, higher = worse

  const raw = (m.rawMetar || '').toUpperCase()

  // 1. Thunderstorm detection (RED immediately)
  const tsPatterns = ['TSRA', '+TSRA', 'TS ', 'VCTS', '+TS']
  const hasThunderstorm = tsPatterns.some((p) => raw.includes(p))
  if (hasThunderstorm) {
    return {
      level: 'RED',
      label: 'THUNDERSTORM',
      summary: 'Active thunderstorm detected. Temp can drop 10-15°F in minutes.',
      factors: [
        `${raw.includes('TSRA') ? 'Thunderstorm with rain' : raw.includes('VCTS') ? 'Thunderstorm in vicinity' : 'Thunderstorm active'}`,
        'DO NOT TRADE — wait 20 min after storm passes',
      ],
    }
  }

  // 2. Wind gusts (strong instability signal)
  if (m.windGust !== null && m.windGust > 0) {
    const gustSpread = m.windGust - (m.windSpeed || 0)
    if (m.windGust >= 35 || gustSpread >= 17) {
      score += 3
      factors.push(`Gusting ${m.windGust}mph (spread ${gustSpread}mph) — frontal/convective activity likely`)
    } else if (m.windGust >= 23 || gustSpread >= 12) {
      score += 2
      factors.push(`Gusting ${m.windGust}mph — moderate instability`)
    } else {
      score += 1
      factors.push(`Light gusts to ${m.windGust}mph`)
    }
  }

  // 3. High sustained winds
  if (m.windSpeed !== null) {
    if (m.windSpeed >= 29) {
      score += 2
      factors.push(
        `Strong wind ${m.windSpeed}mph ${degreesToCompass(m.windDirection)} — temp readings may fluctuate`,
      )
    } else if (m.windSpeed >= 17) {
      score += 1
      factors.push(`Wind ${m.windSpeed}mph ${degreesToCompass(m.windDirection)}`)
    } else {
      factors.push(`Light wind ${m.windSpeed}mph ${degreesToCompass(m.windDirection)} — stable`)
    }
  }

  // 4. Precipitation
  const precipPatterns: [string, string][] = [
    ['+RA', 'Heavy rain — evaporative cooling, temp dropping'],
    ['RA ', 'Rain — mild cooling effect (1-3°F)'],
    ['-RA', 'Light rain — slight cooling'],
    ['+SN', 'Heavy snow — temp locked low'],
    ['SN ', 'Snow — temp steady or dropping'],
    ['-SN', 'Light snow'],
    ['SHRA', 'Rain showers — intermittent, temp unstable'],
    ['DZ', 'Drizzle — low clouds, temp suppressed'],
    ['FG', 'Fog — temp stable but low visibility'],
    ['BR', 'Mist — high humidity, slow temp changes'],
    ['FZRA', 'Freezing rain — dangerous conditions'],
  ]
  for (const [code, msg] of precipPatterns) {
    if (raw.includes(code)) {
      score += code.startsWith('+') ? 2 : 1
      factors.push(msg)
      break
    }
  }

  // 5. Low clouds (traps heat or blocks sun)
  const lowClouds = m.clouds.filter((cl) => (cl.cover === 'BKN' || cl.cover === 'OVC') && cl.base < 5000)
  if (lowClouds.length > 0) {
    const lowest = lowClouds[0]
    score += 1
    factors.push(
      `${lowest.cover === 'OVC' ? 'Overcast' : 'Broken'} clouds at ${lowest.base.toLocaleString()}ft — ${lowest.base < 2000 ? 'very low, fog/precip risk' : 'suppressing solar heating'}`,
    )
  } else if (
    m.clouds.length === 0 ||
    m.clouds.every((cl) => cl.cover === 'SKC' || cl.cover === 'CLR' || cl.cover === 'FEW')
  ) {
    factors.push('Clear/few clouds — good solar heating, stable')
  }

  // 6. Visibility
  if (m.visibility !== null && m.visibility < 3) {
    score += 2
    factors.push(`Low visibility ${m.visibility} mi — fog/precip, temp readings may be suppressed`)
  } else if (m.visibility !== null && m.visibility < 6) {
    score += 1
    factors.push(`Reduced visibility ${m.visibility} mi`)
  }

  // 7. Pressure falling = incoming weather change
  if (c.pressureTrend === 'Falling') {
    score += 1
    factors.push('↘ Pressure falling — weather change approaching')
  } else if (c.pressureTrend === 'Rising') {
    factors.push('↗ Pressure rising — clearing/stabilizing')
  }

  // 8. FROPA in remarks
  if (raw.includes('FROPA')) {
    score += 3
    factors.push('FRONTAL PASSAGE — temp trend will reverse. High risk.')
  }

  // 9. Temp-dewpoint spread (instability proxy)
  if (m.temp !== null && m.dewpoint !== null) {
    const spread = Math.abs(m.temp - m.dewpoint)
    if (spread < 3) {
      score += 1
      factors.push(`Temp/dewpoint spread ${spread.toFixed(0)}°C — very moist, fog/precip likely`)
    }
  }

  // Determine level
  let level: StabilityLevel = 'GREEN'
  let label = 'STABLE'
  let summary = 'Conditions are stable. Safe to snipe.'

  if (score >= 4) {
    level = 'RED'
    label = 'UNSTABLE'
    summary = 'Significant weather activity. Temp may change rapidly. Trade with extreme caution or skip.'
  } else if (score >= 2) {
    level = 'YELLOW'
    label = 'CAUTION'
    summary = 'Some weather factors present. Use wider margin or wait for METAR confirmation.'
  }

  return { level, label, summary, factors }
}

/* ─── Hover Info Popup (replaces native title tooltips) ───── */

function HoverInfo({
  children,
  content,
  className = '',
}: {
  children: React.ReactNode
  content: React.ReactNode
  className?: string
}) {
  const [show, setShow] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; openDown: boolean }>({ top: 0, left: 0, openDown: false })

  const updatePos = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      // Always open downward — page scrolls so there's always room below.
      // Opening upward caused the popup to get blocked by the thead header bar.
      setPos({
        top: rect.bottom + 8,
        left: Math.min(Math.max(rect.left + rect.width / 2, 200), window.innerWidth - 200),
        openDown: true,
      })
    }
  }

  const handleEnter = () => {
    updatePos()
    setShow(true)
  }

  return (
    <div
      ref={ref}
      className={`relative inline-block ${className}`}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
      onClick={() => {
        updatePos()
        setShow((s) => !s)
      }}
    >
      {children}
      {show &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed z-[99999] w-auto max-w-[400px] p-3 rounded-xl bg-[#0a0f1e] border border-white/10 text-xs text-gray-300 font-mono shadow-2xl whitespace-pre-line pointer-events-none"
            style={{
              top: pos.top,
              left: pos.left,
              transform: 'translateX(-50%)',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ─── V1 Countdown Timer ─────────────────────────────────── */

function _getETTimeParts(): { hour: number; minute: number; second: number } {
  // Bulletproof ET time extraction using formatToParts (no string parsing)
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(now)
  let h = 0,
    m = 0,
    s = 0
  for (const p of parts) {
    if (p.type === 'hour') h = parseInt(p.value)
    if (p.type === 'minute') m = parseInt(p.value)
    if (p.type === 'second') s = parseInt(p.value)
  }
  return { hour: h, minute: m, second: s }
}

// Timezone abbreviation map — matches API route's TZ_ABBR
const TZ_ABBR: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Los_Angeles': 'PT',
  'Europe/London': 'GMT',
  'Europe/Paris': 'CET',
  'Asia/Seoul': 'KST',
  'Asia/Tokyo': 'JST',
  'Europe/Istanbul': 'TRT',
  'America/Argentina/Buenos_Aires': 'ART',
  'America/Sao_Paulo': 'BRT',
  'America/Toronto': 'ET',
  'Pacific/Auckland': 'NZDT',
}

function formatLocalTimeWithTZ(date: Date, tz: string): string {
  const timeStr = date.toLocaleString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const abbr = TZ_ABBR[tz] || 'UTC'
  return `${timeStr} ${abbr}`
}

function V1Countdown({
  obsIntervalMin,
  lastObsTimestamp,
  nextExpectedTimestamp,
  lastObsLocalTime,
  typicalMinutes,
  cityName,
  runningHigh,
  unit,
}: {
  obsIntervalMin: number | null | undefined
  lastObsTimestamp: number | null | undefined
  nextExpectedTimestamp: number | null | undefined
  lastObsLocalTime: string | null | undefined
  typicalMinutes?: number[]
  cityName?: string
  runningHigh?: number | null
  unit?: string
}) {
  const [countdown, setCountdown] = useState('')
  const [status, setStatus] = useState<'normal' | 'due' | 'overdue' | 'stale'>('normal')
  const [flash, setFlash] = useState(false)
  const prevTimestampRef = useRef<number | null | undefined>(null)

  // Detect new V1 observation → flash + browser notification
  useEffect(() => {
    if (prevTimestampRef.current !== null && lastObsTimestamp && prevTimestampRef.current !== lastObsTimestamp) {
      // NEW V1 OBS JUST DROPPED
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 5000)

      // Browser notification
      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          const city = (cityName || 'City').toUpperCase()
          const temp = runningHigh !== null && runningHigh !== undefined ? `${runningHigh}°${unit || 'F'}` : '?'
          new Notification(`V1 UPDATE: ${city}`, {
            body: `New reading: ${temp} at ${lastObsLocalTime}`,
            tag: `v1-${cityName}`,
          })
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission()
        }
      }

      return () => clearTimeout(timer)
    }
    prevTimestampRef.current = lastObsTimestamp
  }, [lastObsTimestamp, cityName, runningHigh, unit, lastObsLocalTime])

  // Request notification permission on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    if (!nextExpectedTimestamp || !lastObsTimestamp) {
      setCountdown('Monitoring...')
      setStatus('normal')
      return
    }

    const update = () => {
      const now = Date.now()
      const secsUntil = Math.floor((nextExpectedTimestamp - now) / 1000)
      const interval = obsIntervalMin ? obsIntervalMin * 60 : 3600 // fallback 60min

      if (secsUntil > 0) {
        const dm = Math.floor(secsUntil / 60)
        const ds = secsUntil % 60
        setCountdown(`${dm}m ${String(ds).padStart(2, '0')}s`)
        setStatus('normal')
      } else if (secsUntil > -120) {
        // Within 2 min of expected — "DUE NOW"
        setCountdown('DUE NOW')
        setStatus('due')
      } else if (secsUntil > -(interval * 2)) {
        // Overdue but less than 2x interval
        const overdueMins = Math.floor(Math.abs(secsUntil) / 60)
        setCountdown(`OVERDUE ${overdueMins}m`)
        setStatus('overdue')
      } else {
        // Very stale — more than 2x interval late
        const staleMins = Math.floor((now - lastObsTimestamp) / 60000)
        setCountdown(`STALE (${staleMins}m old)`)
        setStatus('stale')
      }
    }

    update()
    const iv = setInterval(update, 1000)
    return () => clearInterval(iv)
  }, [nextExpectedTimestamp, lastObsTimestamp, obsIntervalMin])

  const intervalLabel = obsIntervalMin ? `~${obsIntervalMin}m` : '?'
  const typicalLabel =
    typicalMinutes && typicalMinutes.length > 0
      ? ` at :${typicalMinutes.map((m) => String(m).padStart(2, '0')).join(' :')}`
      : ''

  const statusColors = {
    normal: 'text-cyan-400',
    due: 'text-green-400 animate-pulse',
    overdue: 'text-red-400 animate-pulse',
    stale: 'text-red-500',
  }

  const borderColors = {
    normal: 'border-cyan-500/20 bg-cyan-500/5',
    due: 'border-green-500/20 bg-green-500/5',
    overdue: 'border-red-500/50 bg-red-500/20',
    stale: 'border-red-600/60 bg-red-600/25',
  }

  const flashStyle = flash
    ? 'border-amber-400 bg-amber-400/20 shadow-[0_0_20px_rgba(251,191,36,0.4)] transition-all duration-300'
    : `${borderColors[status]} transition-all duration-700`

  return (
    <div className={`mb-3 p-2.5 ${flashStyle} border rounded-lg flex items-center justify-between`}>
      <div className="flex items-center gap-2">
        {flash ? (
          <span className="text-amber-400 text-sm animate-bounce"></span>
        ) : status === 'overdue' || status === 'stale' ? (
          <span className="text-red-400 text-sm animate-pulse">⚠</span>
        ) : (
          <span className="text-cyan-400 text-sm">⏱</span>
        )}
        <span
          className={`text-[11px] font-semibold ${flash ? 'text-amber-400' : status === 'overdue' || status === 'stale' ? 'text-red-400' : 'text-cyan-400'}`}
        >
          {flash
            ? 'V1 JUST UPDATED'
            : status === 'overdue'
              ? 'V1 OVERDUE — data may be lagging'
              : status === 'stale'
                ? 'V1 STALE — data is lagging!'
                : 'V1 (Polymarket source)'}
        </span>
        {!flash && status !== 'overdue' && status !== 'stale' && (
          <span className="text-[10px] text-gray-500">
            updates every {intervalLabel}
            {typicalLabel}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <span className={flash ? 'text-amber-300' : 'text-gray-400'}>
          V1 Last:{' '}
          <span className={`font-bold ${flash ? 'text-amber-200 text-sm' : 'text-white'}`}>
            {lastObsLocalTime || '—'}
          </span>
        </span>
        <span className="text-gray-500">→</span>
        <span className={`font-bold text-sm ${flash ? 'text-amber-400' : statusColors[status]}`}>{countdown}</span>
      </div>
    </div>
  )
}

/* ─── METAR Countdown — pixel-identical to V1Countdown, emerald/blue colors ─── */

function MetarCountdown({
  metarLastObsTime,
  metarTimeline,
  timezone,
  isUS,
  cityName,
  metarHigh,
  unit,
  edgeObsTimestamp,
  metarObsIntervalMin: apiObsInterval,
  metarLastObsTimestamp: apiLastObsTs,
  metarTypicalMinutes: apiTypicalMin,
  metarNextExpectedTimestamp: apiNextExpected,
}: {
  metarLastObsTime: string | null | undefined
  metarTimeline?: { hour: number; minute: number; temp: number; label: string; timestamp?: number }[]
  timezone: string
  isUS: boolean
  cityName?: string
  metarHigh?: number | null
  unit?: string
  edgeObsTimestamp?: number | null
  metarObsIntervalMin?: number | null
  metarLastObsTimestamp?: number | null
  metarTypicalMinutes?: number[]
  metarNextExpectedTimestamp?: number | null
}) {
  const [countdown, setCountdown] = useState('')
  const [status, setStatus] = useState<'normal' | 'due' | 'overdue' | 'stale'>('normal')
  const [flash, setFlash] = useState(false)
  const prevObsTimeRef = useRef<string | null | undefined>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Detect new METAR observation → flash + browser notification
  useEffect(() => {
    if (prevObsTimeRef.current !== null && metarLastObsTime && prevObsTimeRef.current !== metarLastObsTime) {
      // Clear any existing flash timer to prevent overlap
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      setFlash(true)
      flashTimerRef.current = setTimeout(() => setFlash(false), 5000)

      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          const city = (cityName || 'City').toUpperCase()
          const temp = metarHigh !== null && metarHigh !== undefined ? `${metarHigh}°${unit || 'F'}` : '?'
          new Notification(`METAR UPDATE: ${city}`, {
            body: `New reading: ${temp} at ${metarLastObsTime}`,
            tag: `metar-${cityName}`,
          })
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission()
        }
      }
    }
    // Always update ref — ensures first render sets the baseline
    prevObsTimeRef.current = metarLastObsTime
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [metarLastObsTime, cityName, metarHigh, unit])

  // Use server-computed values with fallback defaults
  const obsIntervalMin = apiObsInterval ?? (isUS ? 60 : 30)
  const typicalMinutes = apiTypicalMin && apiTypicalMin.length > 0 ? apiTypicalMin : isUS ? [51] : [20, 50]
  const lastObsTimestamp = apiLastObsTs ?? edgeObsTimestamp ?? null
  const nextExpectedTimestamp = apiNextExpected ?? null

  useEffect(() => {
    const update = () => {
      const now = Date.now()

      // Age of last obs — use server-provided timestamp, fallback to edge
      const metarAgeMin = lastObsTimestamp ? Math.round((now - lastObsTimestamp) / 60000) : 0
      const isOverdueAge = metarAgeMin > (isUS ? 75 : 45)
      const isStaleAge = metarAgeMin > (isUS ? 120 : 60)

      if (isStaleAge && lastObsTimestamp) {
        setCountdown(`STALE (${metarAgeMin}m old)`)
        setStatus('stale')
      } else if (isOverdueAge && lastObsTimestamp) {
        const overdueMins = metarAgeMin - (isUS ? 60 : 30)
        setCountdown(`OVERDUE ${overdueMins}m`)
        setStatus('overdue')
      } else if (nextExpectedTimestamp) {
        // V1-style: simple subtraction from server-computed next-expected
        const secsUntil = Math.round((nextExpectedTimestamp - now) / 1000)
        if (secsUntil < 120) {
          setCountdown('DUE NOW')
          setStatus('due')
        } else {
          const dm = Math.floor(secsUntil / 60)
          const ds = secsUntil % 60
          setCountdown(`${dm}m ${String(ds).padStart(2, '0')}s`)
          setStatus('normal')
        }
      } else {
        setCountdown('Monitoring...')
        setStatus('normal')
      }
    }

    update()
    const iv = setInterval(update, 1000)
    return () => clearInterval(iv)
  }, [isUS, lastObsTimestamp, nextExpectedTimestamp])

  const intervalLabel = `~${obsIntervalMin}m`
  const typicalLabel = ` at :${typicalMinutes.map((m) => String(m).padStart(2, '0')).join(' :')}`

  const statusColors = {
    normal: 'text-blue-400',
    due: 'text-green-400 animate-pulse',
    overdue: 'text-red-400 animate-pulse',
    stale: 'text-red-500',
  }

  const borderColors = {
    normal: 'border-blue-500/20 bg-blue-500/5',
    due: 'border-green-500/20 bg-green-500/5',
    overdue: 'border-red-500/50 bg-red-500/20',
    stale: 'border-red-600/60 bg-red-600/25',
  }

  const flashStyle = flash
    ? 'border-amber-400 bg-amber-400/20 shadow-[0_0_20px_rgba(251,191,36,0.4)] transition-all duration-300'
    : `${borderColors[status]} transition-all duration-700`

  // Build display time: use metarLastObsTime from API, or fallback to last metarTimeline entry
  // IMPORTANT: Never blank out — retain last known time if API returns empty on a refresh cycle
  const tzAbbr = TZ_ABBR[timezone] || 'UTC'
  const prevDisplayTimeRef = useRef<string>('—')
  const displayTime = React.useMemo(() => {
    let result = '—'
    if (metarLastObsTime) {
      // If it already contains a TZ abbr (from edge fallback), don't double-add
      const hasTz = /[A-Z]{2,5}$/.test(metarLastObsTime.trim())
      result = hasTz ? metarLastObsTime : `${metarLastObsTime} ${tzAbbr}`
    } else if (metarTimeline && metarTimeline.length > 0) {
      // Fallback: compute from metarTimeline last entry
      const last = metarTimeline[metarTimeline.length - 1]
      const h = last.hour % 12 || 12
      const ampm = last.hour >= 12 ? 'PM' : 'AM'
      const m = String(last.minute).padStart(2, '0')
      result = `${h}:${m} ${ampm} ${tzAbbr}`
    }
    // If new data is empty but we had a previous value, keep it (prevents blanking on API hiccup)
    if (result === '—' && prevDisplayTimeRef.current !== '—') {
      return prevDisplayTimeRef.current
    }
    prevDisplayTimeRef.current = result
    return result
  }, [metarLastObsTime, metarTimeline, tzAbbr])

  const isHK = cityName === 'hong-kong'

  return (
    <div className={`mb-1 p-2.5 ${flashStyle} border rounded-lg flex items-center justify-between gap-3`}>
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        {flash ? (
          <span className="text-amber-400 text-sm animate-bounce flex-shrink-0"></span>
        ) : status === 'overdue' || status === 'stale' ? (
          <span className="text-red-400 text-sm animate-pulse flex-shrink-0">⚠</span>
        ) : (
          <span className={`text-sm flex-shrink-0 ${isHK ? 'text-emerald-400' : 'text-blue-400'}`}>
            {isHK ? 'OBS' : '✈'}
          </span>
        )}
        <span
          className={`text-[11px] font-semibold whitespace-nowrap ${flash ? 'text-amber-400' : status === 'overdue' || status === 'stale' ? 'text-red-400' : isHK ? 'text-emerald-400' : 'text-blue-400'}`}
        >
          {flash
            ? isHK
              ? 'HKO JUST UPDATED'
              : 'METAR JUST UPDATED'
            : status === 'overdue'
              ? isHK
                ? 'HKO OVERDUE — data may be lagging'
                : 'METAR OVERDUE — data may be lagging'
              : status === 'stale'
                ? 'METAR STALE — data is lagging!'
                : 'METAR (aviation source)'}
        </span>
        {!flash && status !== 'overdue' && status !== 'stale' && (
          <span className="text-[10px] text-gray-500 whitespace-nowrap truncate">
            {`updates every ${intervalLabel}${typicalLabel}`}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] flex-shrink-0 whitespace-nowrap">
        {displayTime !== '—' && (
          <>
            <span className="text-[10px] font-bold text-gray-400">LAST METAR</span>
            <span className={`text-[11px] font-bold ${flash ? 'text-amber-200' : 'text-cyan-400'}`}>{displayTime}</span>
            <span className="text-gray-600">→</span>
          </>
        )}
        <span className={`font-bold text-sm ${flash ? 'text-amber-400' : statusColors[status]}`}>{countdown}</span>
      </div>
    </div>
  )
}

/* ─── V2 Sniper removed — no longer used ─── */

function _V2Sniper_REMOVED({
  asosTimeline,
  nextExpectedTimestamp,
  activeBuckets,
  runningHigh: _runningHigh,
  unit,
  timezone,
  cityName,
  botCityData,
}: {
  asosTimeline?: {
    hour: number
    minute: number
    temp: number
    label: string
    timestamp?: number
    source?: 'nws' | 'metar' | 'v3' | 'edge' | 'phone'
    precision?: string
  }[]
  nextExpectedTimestamp?: number | null
  activeBuckets: BucketIntel[]
  runningHigh?: number | null
  unit: string
  timezone: string
  cityName: string
  botCityData?: {
    v1_high: number | null
    v3_current: number | null
    metar?: number | null
    dead_buckets: string[]
    rising?: boolean
    gap?: number
  }
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 5000) // refresh every 5s
    return () => clearInterval(iv)
  }, [])

  if (!asosTimeline || asosTimeline.length === 0) return null

  const now = Date.now()
  const minsToV1 = nextExpectedTimestamp ? Math.round((nextExpectedTimestamp - now) / 60000) : null

  // Get current local time in city's timezone
  const nowDate = new Date()
  const localHour = parseInt(nowDate.toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }))
  const localMinute = parseInt(nowDate.toLocaleString('en-US', { timeZone: timezone, minute: 'numeric' }))

  // Find ASOS readings for the CURRENT hour, sorted by minute
  const currentHourReadings = asosTimeline.filter((p) => p.hour === localHour).sort((a, b) => a.minute - b.minute)

  // Find the reading closest to :50 (the best V1 predictor — 3 min before :53)
  const previewReading = currentHourReadings.reduce<(typeof asosTimeline)[0] | null>((best, p) => {
    if (p.minute > 55) return best // :56+ is AFTER V1 reads, not useful as preview
    if (!best) return p
    return Math.abs(p.minute - 50) < Math.abs(best.minute - 50) ? p : best
  }, null)

  // Get last 3 readings for trend analysis (across all hours)
  const last3 = asosTimeline.slice(-3)
  const trend = last3.length >= 2 ? last3[last3.length - 1].temp - last3[0].temp : 0
  const trendLabel = trend > 0.5 ? 'RISING' : trend < -0.5 ? 'FALLING' : 'STABLE'
  const trendIcon = trend > 0.5 ? '↗' : trend < -0.5 ? '↘' : '→'

  // Latest ASOS reading (for "most recent" display)
  const latest = asosTimeline[asosTimeline.length - 1]
  const latestAgeMin = latest.timestamp ? Math.round((now - latest.timestamp) / 60000) : null

  // Calculate preview confidence
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
  const minutesFromPreviewTo53 = previewReading ? Math.abs(53 - previewReading.minute) : 99

  if (previewReading) {
    if (minutesFromPreviewTo53 <= 3 && trendLabel === 'STABLE') confidence = 'HIGH'
    else if (minutesFromPreviewTo53 <= 5) confidence = trendLabel === 'FALLING' ? 'MEDIUM' : 'HIGH'
    else if (minutesFromPreviewTo53 <= 10) confidence = 'MEDIUM'
    else confidence = 'LOW'
  }

  // Compare preview temp against bucket ceilings
  const previewTemp = previewReading?.temp ?? null
  const activeBucketsOpen = activeBuckets.filter((b) => b.status !== 'DEAD')
  const confirmedBucket =
    previewTemp !== null
      ? [...activeBucketsOpen].sort((a, b) => b.upper - a.upper).find((b) => previewTemp > b.upper)
      : null
  const nearBucket =
    previewTemp !== null
      ? activeBucketsOpen
          .filter((b) => previewTemp <= b.upper && previewTemp >= b.lower)
          .sort((a, b) => a.upper - b.upper)[0]
      : null
  const gapToNext = nearBucket && previewTemp !== null ? nearBucket.upper - previewTemp : null

  // Determine sniper state
  const isInWindow = minsToV1 !== null && minsToV1 <= 15 && minsToV1 >= -5
  const v1JustFired = minsToV1 !== null && minsToV1 >= -5 && minsToV1 <= 0

  // Colors
  const confColors = { HIGH: 'text-green-400', MEDIUM: 'text-yellow-400', LOW: 'text-gray-500' }
  const confBg = {
    HIGH: 'bg-green-500/10 border-green-500/30',
    MEDIUM: 'bg-yellow-500/10 border-yellow-500/30',
    LOW: 'bg-gray-500/10 border-gray-500/20',
  }

  // Only show when we have data worth showing
  if (!previewReading && !latest) return null

  return (
    <div
      className={`mb-3 p-2.5 border rounded-lg ${isInWindow ? confBg[confidence] : 'border-purple-500/20 bg-purple-500/5'}`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm"></span>
          <span className={`text-[11px] font-bold ${isInWindow ? confColors[confidence] : 'text-purple-400'}`}>
            V2 SNIPER
          </span>
          {isInWindow && (
            <span
              className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                confidence === 'HIGH'
                  ? 'bg-green-500/20 text-green-400'
                  : confidence === 'MEDIUM'
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-gray-500/20 text-gray-400'
              }`}
            >
              {confidence}
            </span>
          )}
        </div>
        <div className="text-[10px] text-gray-500">
          {cityName.toUpperCase()} · {localHour === 0 ? 12 : localHour > 12 ? localHour - 12 : localHour}:
          {String(localMinute).padStart(2, '0')} {localHour >= 12 ? 'PM' : 'AM'} local
        </div>
      </div>

      {botCityData && (
        <div className="flex items-center gap-3 text-[10px] text-gray-400 mb-1.5 pb-1.5 border-b border-white/5">
          <span></span>
          <span>
            V1=<b className="text-white">{botCityData.v1_high ?? '—'}</b>
          </span>
          <span>
            V3=<b className={botCityData.rising ? 'text-cyan-400' : 'text-white'}>{botCityData.v3_current ?? '—'}</b>
          </span>
          {botCityData.metar !== null && botCityData.metar !== undefined && (
            <span>
              METAR=<b className="text-cyan-400">{botCityData.metar}</b>
            </span>
          )}
          {botCityData.dead_buckets.length > 0 && (
            <span className="text-red-400">{botCityData.dead_buckets.length}</span>
          )}
        </div>
      )}

      {isInWindow && previewReading ? (
        /* ─── Active sniper window — within 15 min of V1 reading ─── */
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-gray-400">ASOS@:{String(previewReading.minute).padStart(2, '0')}</span>
            <span className="text-white font-bold text-sm">
              {previewTemp?.toFixed(2)}°{unit}
            </span>
            {/* Precision indicator for this reading */}
            {previewReading.source && (
              <span
                className={`text-[8px] px-1 py-0.5 rounded ${
                  previewReading.precision === 'tgroup'
                    ? 'bg-cyan-500/20 text-cyan-400'
                    : previewReading.source === 'nws'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-yellow-500/20 text-yellow-400'
                }`}
                title={
                  previewReading.precision === 'tgroup'
                    ? 'METAR T-group: 0.1°C precision extracted from remarks section.'
                    : previewReading.source === 'nws'
                      ? 'NWS data: 0.1°C precision. This decimal is accurate.'
                      : 'METAR data: rounded to 1°C. Actual temp could be ±0.9°F different.'
                }
              >
                {previewReading.precision === 'tgroup'
                  ? 'T-GRP 0.1°C'
                  : previewReading.source === 'nws'
                    ? 'PRECISE'
                    : '±1°'}
              </span>
            )}
            <span className="text-gray-500">→</span>
            <span className={`font-bold ${v1JustFired ? 'text-amber-400 animate-pulse' : confColors[confidence]}`}>
              {v1JustFired ? 'V1 READING NOW' : `V1 in ${minsToV1}m`}
            </span>
          </div>

          {/* Bucket prediction */}
          <div className="text-[11px]">
            {confirmedBucket ? (
              <span className="text-green-400 font-bold">
                ✓ LOCK LIKELY — ASOS past {confirmedBucket.upper}° ceiling → V1 will confirm
              </span>
            ) : gapToNext !== null && gapToNext <= 2 ? (
              <span className="text-yellow-400 font-bold">
                ⚠ {gapToNext.toFixed(2)}° from {nearBucket?.lower}-{nearBucket?.upper}° ceiling — could swing either
                way
              </span>
            ) : (
              <span className="text-red-400/70">
                ✕ Below ceiling{nearBucket ? ` — need ${nearBucket.upper}° (${gapToNext?.toFixed(2)}° away)` : ''}
              </span>
            )}
          </div>

          {/* Trend */}
          <div className="flex items-center gap-2 text-[10px] text-gray-500">
            <span>
              {trendIcon} Trend: {last3.map((r) => r.temp.toFixed(2)).join('→')} ({trendLabel})
            </span>
            <span>·</span>
            <span>{minutesFromPreviewTo53}m gap to :53</span>
          </div>
        </div>
      ) : (
        /* ─── Outside sniper window — show latest ASOS and next window ─── */
        <div className="text-[11px] space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Latest ASOS:</span>
            <span className="text-white font-bold">
              {latest.temp.toFixed(2)}°{unit}
            </span>
            <span className="text-gray-500">at :{String(latest.minute).padStart(2, '0')}</span>
            {latestAgeMin !== null && <span className="text-gray-600">({latestAgeMin}m ago)</span>}
          </div>
          <div className="text-gray-500">
            {minsToV1 !== null && minsToV1 > 0
              ? `Next sniper window: ~${minsToV1 > 15 ? minsToV1 - 15 : 0}m (V1 reads in ${minsToV1}m)`
              : 'Waiting for next V1 cycle...'}
          </div>
          {/* Still show trend */}
          <div className="text-[10px] text-gray-600">
            {trendIcon} {last3.map((r) => r.temp.toFixed(2)).join('→')} ({trendLabel})
            {latest.source && (
              <span
                className={`ml-1 text-[8px] px-1 py-0.5 rounded ${latest.source === 'nws' ? 'bg-green-500/15 text-green-400' : 'bg-yellow-500/15 text-yellow-400'}`}
              >
                {latest.source === 'nws' ? 'PRECISE' : '±1°'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Tooltip Header Component ────────────────────────────── */

function Tip({
  label,
  tip,
  className = '',
  onSort,
  sortActive = false,
  sortDir = 'desc',
}: {
  label: string
  tip: React.ReactNode
  className?: string
  onSort?: () => void
  sortActive?: boolean
  sortDir?: 'desc' | 'asc'
}) {
  const [show, setShow] = useState(false)
  return (
    <th
      className={`${className} ${onSort ? 'cursor-pointer select-none' : 'cursor-help'} relative`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={() => (onSort ? onSort() : setShow((s) => !s))}
    >
      <span
        className={`border-b border-dotted ${sortActive ? 'text-cyan-300 border-cyan-500/50' : 'border-gray-600'} ${onSort ? 'hover:text-gray-200' : ''}`}
      >
        {label}
      </span>
      {onSort && <span className="ml-1 text-[9px] text-cyan-400">{sortActive ? (sortDir === 'desc' ? '▼' : '▲') : ''}</span>}
      {show && (
        <div className="absolute z-50 top-full left-1/2 -translate-x-1/2 mt-1 w-56 p-2 rounded-lg bg-gray-900 border border-white/10 text-xs text-gray-300 font-normal normal-case tracking-normal shadow-xl">
          {tip}
        </div>
      )}
    </th>
  )
}

/* ─── Helpers ─────────────────────────────────────────────── */

function fmt(n: number, sign = false): string {
  const abs = Math.abs(n)
  const s =
    abs < 0.01 ? abs.toFixed(4) : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (sign) return n >= 0 ? `+$${s}` : `-$${s}`
  return `$${s}`
}

function isWxMarket(m: string): boolean {
  return /temperature|°[FC]|highest temp/i.test(m)
}

function isNbaMarket(m: string): boolean {
  return /vs\.|lakers|celtics|warriors|nuggets|cavaliers|bucks|thunder|rockets|spurs|pistons|knicks|heat|nets|76ers|clippers|suns|kings|grizzlies|timberwolves|pelicans|hawks|bulls|raptors|pacers|magic|hornets|blazers|wizards|jazz|mavericks/i.test(
    m,
  )
}

function isSoccerMarket(m: string): boolean {
  return /draw|premier league|la liga|champions league|epl|wolves|arsenal|chelsea|liverpool|man city|manchester|tottenham|aston villa|newcastle|brighton|bournemouth|brentford|everton|crystal palace|fulham|ipswich|leicester|nottingham|southampton|west ham|barcelona|real madrid|atletico|sevilla|betis|villarreal|sociedad|athletic|celta|osasuna|getafe|alaves|rayo|mallorca|girona|valladolid|leganes|espanyol|las palmas|bayern|dortmund|leverkusen|psg|juventus|inter|milan|napoli/i.test(
    m,
  )
}

/* ─── Bot Config ──────────────────────────────────────────── */

/* ─── Page ────────────────────────────────────────────────── */

export default function TradingPage() {
  // When rendered at /brain/trading-preview, surface the AI Engine
  // (unifiedPrediction) prediction inside the Signal popup + next to the
  // Sniper Intel strip so the operator can cross-check before betting. Live
  // /brain/trading path renders identically to today (badge hidden).
  const pathname = usePathname()
  // v3.100.12 — the operator's approval 2026-04-23 02:52 PM: promote preview to live.
  // Previously `pathname?.endsWith('/trading-preview')` gated the new AI Engine UI
  // to the /brain/trading-preview URL only. Now always-on so both /brain/trading and
  // /brain/trading-preview render identically. Flip back to pathname check to revert.
  const isUnifiedPreview = true
  // v3.100.22: gate NEW preview-only enhancements (CLOB depth column, etc.)
  // behind /brain/trading-preview pathname. Live /brain/trading must never
  // see the new column. Promote each enhancement to live only after the operator
  // signs off on the preview render.
  const isPreviewRoute = pathname?.endsWith('/trading-preview') ?? false
  void pathname // kept for potential future per-route behavior
  const [balance, setBalance] = useState<number | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [_trades, setTrades] = useState<Trade[]>([])
  const [pnlData, setPnlData] = useState<PnlData | null>(null)
  const [loading, setLoading] = useState(true)
  const [botConfig, setBotConfig] = useState<BotConfig | null>(null)
  const [filter, _setFilter] = useState<PositionFilter>('all')
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [_weatherReport, setWeatherReport] = useState<WeatherReport | null>(null)
  const [_modelStatus, setModelStatus] = useState<ModelStatusData | null>(null)
  const [_scorecard, setScorecard] = useState<DailyScorecard | null>(null)
  const [weatherIntel, setWeatherIntelRaw] = useState<WeatherIntelResponse | null>(null)
  // v3.77.0: freshness state — server payload, last successful fetch timestamp.
  const [freshness, setFreshness] = useState<FreshnessPayload | null>(null)
  const [lastFetchOkAt, setLastFetchOkAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // v3.99.49: 1-second ticker that the Signal Schedule reads so its countdown
  // text ("1h 37m 42s") ticks live instead of only updating on data polls.
  // `signalNow` is Date.now() at the most recent tick — the schedule's drop
  // helpers branch off it directly rather than the stale value bound into a
  // prior render closure.
  const [signalNow, setSignalNow] = useState<number>(Date.now())
  useEffect(() => {
    const id = setInterval(() => setSignalNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  // Bucket Sniper date toggle
  const _astHourNow = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Puerto_Rico', hour: 'numeric', hour12: false }),
  )
  // project law 2026-04-06: TODAY is hidden after 6 PM AST. The default flips to
  // Old Bucket Sniper state/refs removed in Phase 02.17.18 — replaced by BucketSniperV2 component.
  // AST_HIDE_TODAY removed (was only used by old sniper day toggle).
  // High-water mark: prevent METAR/ASOS values from regressing due to CDN stale data.
  // Once we see a higher metarHigh or asosHigh, never show a lower value.
  const metarHighWaterRef = useRef<
    Record<
      string,
      {
        metarHigh: number
        metarCurrent: number
        metarObsTime: string
        asosHigh: number
        asosCurrent: number
        asosObsTime: string
      }
    >
  >({})
  // Phase 02.6.3 (project law 2026-04-07): per-city last-good model forecast
  // values. The Open-Meteo upstream is intermittently failing and the API
  // sometimes returns null for every model on a city for one polling cycle
  // before recovering. Without this merge the trading grid blanks the row to
  // dashes and users see a flicker. Rule: if the new poll value for a model
  // is null AND the previous (last-good) value is non-null, KEEP the previous
  // value. Only show dashes when both new AND old are null.
  const modelLastGoodRef = useRef<Record<string, Partial<WUCityIntel>>>({})
  // Phase 02.17.7 (2026-04-10): Request sequencing — reject any weather-intel
  // response whose server `timestamp` is older than the last accepted payload.
  // This kills the second [high] Codex finding: fetchWeatherFast (15s) and
  // fetchSlowData (60s) both call the weather-intel route with no shared
  // AbortController and no ordering guard. At 15s/60s cadences with network
  // jitter, an older response can land after a newer one and roll the UI
  // backward. Guard lives inside setWeatherIntel so neither callsite can
  // forget it. Unit is ms since epoch (0 means accept any, which is the
  // correct behavior for the first response of a session).
  const lastAcceptedWeatherTsRef = useRef<number>(0)
  // Phase 02.17.26 (2026-04-11): signal drift indicator. `prevSignalsRef`
  // stores the most recent canonicalized snapshot of each city's
  // dynamicSignal so the next poll can diff against it. `driftBanners` is
  // React state keyed by city slug — render-time data, pruned by a 10s
  // expiry ticker. First-poll entries populate the ref without producing a
  // banner. See lib/drift-detection.ts for the pure logic + unit tests.
  const prevSignalsRef = useRef<Map<string, SignalSnapshot>>(new Map())
  const [driftBanners, setDriftBanners] = useState<Record<string, DriftEvent>>({})
  const setWeatherIntel = useCallback((data: WeatherIntelResponse | null) => {
    if (!data?.cities) {
      setWeatherIntelRaw(data)
      return
    }
    // Phase 02.17.7: reject stale out-of-order responses. `data.timestamp` is
    // ISO-8601 UTC set by route.ts when the weather-intel payload is built.
    // If the new payload is older than what we already rendered, drop it —
    // it is provably a superseded response from a racing fetch.
    const incomingTs = data.timestamp ? Date.parse(data.timestamp) : 0
    if (incomingTs > 0 && incomingTs < lastAcceptedWeatherTsRef.current) {
      return
    }
    if (incomingTs > 0) {
      lastAcceptedWeatherTsRef.current = incomingTs
    }
    const hwm = metarHighWaterRef.current
    const modelLG = modelLastGoodRef.current
    // Phase 02.6.3 last-good model merge — keys we never let regress to null.
    // Each entry is a single forecast value that the row renders directly.
    const MODEL_KEYS = [
      'gfs',
      'ecmwf',
      'icon',
      'gem',
      'jma',
      'ukmo',
      'meteofrance',
      'knmi',
      'kma',
      'cma',
      'bom',
      'graphcast',
      'ensemble',
      'spread',
      'bestModelTemp',
      'bestModel',
      'bestModelWR',
    ] as const
    for (const c of data.cities) {
      const key = c.city
      // Last-good model merge: read prior non-null value, write back if new is null.
      const prevModels = modelLG[key] ?? {}
      const updated: Partial<WUCityIntel> = { ...prevModels }
      for (const mk of MODEL_KEYS) {
        const newVal = (c as unknown as Record<string, unknown>)[mk]
        if (newVal !== null && newVal !== undefined) {
          // Fresh value present — accept and update last-good.
          ;(updated as Record<string, unknown>)[mk] = newVal
        } else if ((updated as Record<string, unknown>)[mk] !== undefined) {
          // Fresh value missing but we have a last-good — restore it on the
          // outgoing city object so the row never blanks.
          ;(c as unknown as Record<string, unknown>)[mk] = (updated as Record<string, unknown>)[mk]
        }
      }
      modelLG[key] = updated

      // Phase 02.17.6 (2026-04-10): REMOVED forecast A→B→A pinning block.
      // See declaration removal comment above. Client no longer synthesizes
      // forecast values — raw server values flow through. Monotonic ordering
      // enforced server-side (Phase 02.17.8) and via request-sequencing
      // timestamp guard (Phase 02.17.7).

      const prev = hwm[key]
      if (!prev) {
        hwm[key] = {
          metarHigh: c.metarHigh ?? -999,
          metarCurrent: c.metarCurrent ?? -999,
          metarObsTime: c.metarLastObsTime ?? '',
          asosHigh: c.asosHigh ?? -999,
          asosCurrent: c.asosCurrent ?? -999,
          asosObsTime: c.asosLastObsTime ?? '',
        }
      } else {
        // METAR: monotonic for small CDN jitter (<1°), but accept large drops (data correction)
        if (c.metarHigh !== null && c.metarHigh !== undefined) {
          const metarDrop = prev.metarHigh - c.metarHigh
          if (c.metarHigh >= prev.metarHigh || metarDrop > 1) {
            // New high OR large drop = data correction
            prev.metarHigh = c.metarHigh
            prev.metarCurrent = c.metarCurrent ?? prev.metarCurrent
            prev.metarObsTime = c.metarLastObsTime ?? prev.metarObsTime
          } else {
            // Small drop = CDN stale data — keep previous high-water values
            c.metarHigh = prev.metarHigh
            c.metarCurrent = prev.metarCurrent
            c.metarLastObsTime = prev.metarObsTime
          }
        }
        // ASOS: monotonic for small CDN jitter (<1°), but accept large drops (data correction)
        if (c.asosHigh !== null && c.asosHigh !== undefined) {
          const asosDrop = prev.asosHigh - c.asosHigh
          if (c.asosHigh >= prev.asosHigh || asosDrop > 1) {
            // New high OR large drop = data correction (e.g. garbled reading cleaned)
            prev.asosHigh = c.asosHigh
            prev.asosCurrent = c.asosCurrent ?? prev.asosCurrent
            prev.asosObsTime = c.asosLastObsTime ?? prev.asosObsTime
          } else {
            // Small drop = CDN stale data — keep previous high-water values
            c.asosHigh = prev.asosHigh
            c.asosCurrent = prev.asosCurrent
            c.asosLastObsTime = prev.asosObsTime
          }
        }
      }
    }
    // Phase 02.17.6 (2026-04-10): REMOVED pennyBidBoard pinScalar block.
    // The Phase 02.17.4 pinScalar rewrote hitRate/forecastHigh/expectedROI/
    // primary bucket bounds back to hist[1] when it detected A→B→A, but did
    // not advance history, so once a pin fired it never released. Codex
    // [high] finding. Raw pennyBidBoard values flow through unchanged; any
    // residual oscillation is handled server-side by Phase 02.17.8 shared
    // cache + upsert throttle on forecast_current.
    //
    // Phase 02.17.26 (2026-04-11): Signal drift detection. For every city in
    // this accepted payload, compute a canonical snapshot of its dynamicSignal
    // and diff against the previous snapshot. Any triggers fired → stash a
    // DriftEvent in React state so the expanded panel can render a banner.
    // First-poll entries populate the ref WITHOUT producing a banner (we need
    // two samples to detect drift). Expiry is handled by a separate 10s
    // ticker below this callback.
    //
    // GPT-5.4 superior review hardening (2026-04-11):
    // 1. Prune `prevSignalsRef` for cities that disappeared from the payload
    //    so the map doesn't leak memory / resurrect stale comparisons when a
    //    city returns much later.
    // 2. Call `pruneExpired` on EVERY accepted payload (not just when new
    //    drifts exist) so a banner whose TTL expired between the last drift
    //    and the next poll doesn't linger for up to 10s until the ticker
    //    catches it.
    const driftNow = Date.now()
    const prevMap = prevSignalsRef.current
    const seenCities = new Set<string>()
    const newDrifts: Record<string, DriftEvent> = {}
    for (const c of data.cities) {
      seenCities.add(c.city)
      const curr = makeSnapshot(c.dynamicSignal, driftNow)
      if (!curr) continue
      const prev = prevMap.get(c.city)
      if (prev) {
        const triggers = diffSnapshots(prev, curr)
        if (triggers.length > 0) {
          newDrifts[c.city] = { prev, curr, triggeredAt: driftNow, triggers }
        }
      }
      prevMap.set(c.city, curr)
    }
    // Prune cities that disappeared from this payload — map size stays
    // bounded and a returning city starts fresh (no two-month-old snapshot
    // causing a spurious drift on its return).
    for (const key of Array.from(prevMap.keys())) {
      if (!seenCities.has(key)) prevMap.delete(key)
    }
    // Always touch banner state so expiry happens on the poll cadence too,
    // not only on the 10s ticker. Functional update with merge when there
    // are new drifts, then prune. If nothing changed, pruneExpired returns
    // the same reference and React skips the re-render.
    setDriftBanners((old) => {
      const hasNew = Object.keys(newDrifts).length > 0
      const base: Record<string, DriftEvent> = hasNew ? { ...old, ...newDrifts } : old
      return pruneExpired(base, driftNow)
    })

    // v3.77.14: Merge-by-id state update — if the incoming payload is missing
    // a city that was in a previous response (e.g. partial batch or mid-flight
    // cron gap), keep the prior city entry in state. This prevents the entire
    // Amsterdam row (or any other city) from disappearing on a single bad poll.
    // The city slug is the canonical id. The merge uses a Map for O(1) lookup.
    setWeatherIntelRaw((prev) => {
      if (!prev?.cities || prev.cities.length === 0) return data
      const byCity = new Map<string, WUCityIntel>(prev.cities.map((c) => [c.city, c]))
      for (const c of data.cities) byCity.set(c.city, c)
      return { ...data, cities: Array.from(byCity.values()) }
    })
  }, [])
  // Phase 02.17.26: 10-second expiry ticker. Purely time-based so banners
  // disappear on schedule even when the underlying city stops polling new
  // drift events. The ticker is a no-op when driftBanners is empty — no
  // unnecessary re-renders once everything has aged out.
  useEffect(() => {
    const t = setInterval(() => {
      setDriftBanners((old) => {
        if (Object.keys(old).length === 0) return old
        return pruneExpired(old, Date.now())
      })
    }, 10_000)
    return () => clearInterval(t)
  }, [])
  const [expandedCity, setExpandedCity] = useState<string | null>(null)
  // City-table sort mode: live status (default) or best-model win rate desc
  const [citySort, setCitySort] = useState<'status' | 'forecast'>('status')
  // Clicking an active sortable column header flips direction (highest first by default)
  const [citySortDir, setCitySortDir] = useState<'desc' | 'asc'>('desc')
  const pickSort = (mode: 'status' | 'forecast') => {
    if (citySort === mode && mode !== 'status') {
      setCitySortDir(citySortDir === 'desc' ? 'asc' : 'desc')
    } else {
      setCitySort(mode)
      setCitySortDir('desc')
    }
  }

  // v3.100.23 (preview only): per-city Polymarket resolution source.
  // Surfaces the actual settlement station + rounding rule per event.
  // Catches the "Warsaw 17°C is negative-EV per WU truncate rule" class of
  // bug. Only fired when isPreviewRoute is true.
  const [previewResolution, setPreviewResolution] = useState<
    Record<
      string,
      {
        station: string | null
        sourceUrl: string | null
        precision: 'integer' | 'tenth' | 'unknown'
        precisionUnit: 'C' | 'F' | null
        rule: string
        settlementText: string
        verified: boolean
      } | null
    >
  >({})

  // v3.100.22 (preview only): CLOB orderbook depth per expanded city, keyed
  // by city slug. Each value is a bucket-label-keyed map of depth info.
  // null = fetch failed/skipped, undefined = not yet fetched.
  // Fed by /api/brain/trading/clob-depth, only fired when isPreviewRoute is true.
  const [previewClobDepth, setPreviewClobDepth] = useState<
    Record<
      string,
      Record<
        string,
        {
          bestYesAsk: number | null
          vwapBuyYes100: number | null
          askSize5pp: number
          depthOk: boolean
          reason: string
        }
      > | null
    >
  >({})

  // v3.100.22 (preview only): when isPreviewRoute && a city is expanded, fetch
  // /api/brain/trading/clob-depth for that city. Memoised per-city — same expand
  // doesn't re-fetch. dateSlug is extracted from c.polymarketUrl to match the
  // exact gamma-api event the dashboard is already reading from.
  useEffect(() => {
    if (!isPreviewRoute) return
    if (!expandedCity) return
    if (previewClobDepth[expandedCity] !== undefined) return // already fetched (or attempted)
    const wi = weatherIntel?.cities?.find((c) => c.city === expandedCity)
    if (!wi || !wi.polymarketUrl) return
    const dateMatch = wi.polymarketUrl.match(/on-([a-z]+-\d+-\d+)(?:\?|$|\/)/)
    if (!dateMatch) return
    const dateSlug = dateMatch[1]
    let cancelled = false
    authedFetch(`/api/brain/trading/clob-depth?city=${expandedCity}&date=${dateSlug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) {
          if (!cancelled) setPreviewClobDepth((prev) => ({ ...prev, [expandedCity]: null }))
          return
        }
        // Server returns `byBound: { "12": DepthInfo, "13": ... }` keyed by the
        // integer bound parsed from gamma's groupItemTitle. activeBuckets'
        // lower/upper integers match these bounds (except wide_below uses upper).
        const byBound = (data.byBound ?? {}) as Record<
          string,
          {
            bestYesAsk: number | null
            vwapBuyYes100: number | null
            askSize5pp: number
            depthOk: boolean
            reason: string
          }
        >
        setPreviewClobDepth((prev) => ({ ...prev, [expandedCity]: byBound }))
      })
      .catch(() => {
        if (!cancelled) setPreviewClobDepth((prev) => ({ ...prev, [expandedCity]: null }))
      })
    return () => {
      cancelled = true
    }
  }, [isPreviewRoute, expandedCity, weatherIntel, previewClobDepth])

  // v3.100.23 (preview only): mirror the CLOB fetch pattern for resolution-source.
  // Same expand trigger, same per-city memoization. Heavier server cache (15 min)
  // since rounding rule + station rarely change mid-day.
  useEffect(() => {
    if (!isPreviewRoute) return
    if (!expandedCity) return
    if (previewResolution[expandedCity] !== undefined) return
    const wi = weatherIntel?.cities?.find((c) => c.city === expandedCity)
    if (!wi || !wi.polymarketUrl) return
    const dateMatch = wi.polymarketUrl.match(/on-([a-z]+-\d+-\d+)(?:\?|$|\/)/)
    if (!dateMatch) return
    const dateSlug = dateMatch[1]
    let cancelled = false
    authedFetch(`/api/brain/trading/resolution-source?city=${expandedCity}&date=${dateSlug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (!data || (data as { error?: string }).error) {
          setPreviewResolution((prev) => ({ ...prev, [expandedCity]: null }))
          return
        }
        const typed = data as {
          station: string | null
          sourceUrl: string | null
          precision: 'integer' | 'tenth' | 'unknown'
          precisionUnit: 'C' | 'F' | null
          rule: string
          settlementText: string
          verified: boolean
        }
        setPreviewResolution((prev) => ({ ...prev, [expandedCity]: typed }))
      })
      .catch(() => {
        if (!cancelled) setPreviewResolution((prev) => ({ ...prev, [expandedCity]: null }))
      })
    return () => {
      cancelled = true
    }
  }, [isPreviewRoute, expandedCity, weatherIntel, previewResolution])

  // v3.76.5: Scroll anchor REMOVED. The v3.76.2 JS-based scroll anchor ran on every
  // render (no dependency array), calling getBoundingClientRect + window.scrollBy
  // dozens of times per second across 41 rows × data polls × freshness ticks =
  // browser freeze. Replaced with native CSS `overflow-anchor` (see the expanded
  // card's className — `[overflow-anchor:auto]`). Browser handles it for free.
  const expandedCardRef = useRef<HTMLTableRowElement | null>(null)
  const [cityTab, setCityTab] = useState<Record<string, string>>({})
  const [profileStats, setProfileStats] = useState<ProfileStats | null>(null)
  // Data freshness — green flash when new observation arrives
  const [, setPrevTimestamps] = useState<Record<string, number>>({})
  const [flashCities, setFlashCities] = useState<Set<string>>(new Set())
  const [pnlPeriod, setPnlPeriod] = useState<string>('ALL')
  const [_botStrategy, setBotStrategy] = useState<BotStrategyResponse | null>(null)
  const [_sniperBot, setSniperBot] = useState<SniperBotStatus | null>(null)
  const [_sniperSaving, _setSniperSaving] = useState(false)
  const [_configSaveInfo, _setConfigSaveInfo] = useState<string | null>(null)
  const [_configSaveError, _setConfigSaveError] = useState<string | null>(null)
  const [recTrades, setRecTrades] = useState<{
    timestamp: string
    snipes: Array<{
      city: string
      bucket: string
      side: string
      price: number
      multiplier: number
      v1: number
      unit: string
      reason: string
      url?: string
    }>
    guaranteed: Array<{
      city: string
      bucket: string
      side: string
      price: number
      roi: number
      v1: number
      unit: string
      reason: string
      url?: string
    }>
    favorites: Array<{
      city: string
      bucket: string
      yesPrice: number
      noPrice: number
      v1: number | null
      ensemble: number | null
      unit: string
      reason: string
      url: string
    }>
    watching: Array<{ city: string; v1: number; v3: number | null; unit: string; note: string }>
    summary: string
  } | null>(null)
  const [recLoading, setRecLoading] = useState(false)
  // GFS Sniper signal data
  const [_gfsSignals, setGfsSignals] = useState<Array<{
    city: string
    citySlug: string
    date: string
    gfs: number | null
    ecmwf: number | null
    icon: number | null
    gem: number | null
    predictedBucket: string
    modelsAgreeing: number
    consensusModels: string[]
    signalStrength: 'STRONG' | 'MODERATE' | 'WEAK'
    modelConsensusTemp: number | null
    distanceFromConsensus: number
    marketExists: boolean
    polymarketUrl: string
    bestAsk: number | null
    askDepthUsd: number | null
    allBuckets: Array<{ label: string; yesPrice: number; isTarget: boolean }>
    winRate: number
    evAtFiveCents: number
    roiPct: number
    recommendedSizeUsd: number
    unit: 'C' | 'F'
    snipeable: boolean
    verdict: 'SNIPE' | 'LOW_LIQ' | 'OVERPRICED' | 'NO_BOOK' | 'NO_MARKET'
    verdictLabel: string
    sharesAtFiveCents: number
    sharesAtTenCents: number
    costAtFiveCents: number
    maxSnipeSizeUsd: number
    bidStrategy: 'SINGLE' | 'TWO_TIER'
    tier1: { label: string; price: number; shares: number; cost: number; payout: number } | null
    tier2: { label: string; price: number; shares: number; cost: number; payout: number } | null
    totalCost: number
    totalPayout: number
  }> | null>(null)
  const [_gfsLoading, setGfsLoading] = useState(false)
  const [_gfsDate, setGfsDate] = useState<string>('')
  const [_gfsSummary, setGfsSummary] = useState<{
    snipeable: number
    overpriced: number
    noMarket: number
    strong: number
    moderate: number
    weak: number
    totalCities: number
    totalCapital: number
    expectedEV: number
    totalSharesAvailable: number
    totalPotentialPayout: number
    twoTierCount: number
    singleTierCount: number
  } | null>(null)

  // Paper Trades (resting NO bid strategy)
  const [_paperTrades, setPaperTrades] = useState<{
    timestamp: string
    strategy: string
    config: { bid_price: number; min_distance_f: number; min_distance_c: number; trade_size: number }
    today: {
      date: string
      candidates: number
      bids_placed: number
      filled: number
      resolved_win: number
      resolved_loss: number
      pnl: number | null
    }
    cumulative: {
      total_bids?: number
      total_filled?: number
      total_wins?: number
      total_losses?: number
      total_pnl?: number
      days_active?: number
    }
    positions_today: Array<{
      city: string
      bucket: string
      distance: number
      bid_price: number
      yes_price: number
      winner: string
      shares: number
      cost: number
      status: string
      pnl: number | null
      bid_time: string | null
    }>
    positions_yesterday: Array<{ city: string; bucket: string; status: string; pnl: number | null; distance: number }>
    city_summary: Array<{
      city: string
      bids: number
      filled: number
      total_cost: number
      total_pnl: number
      avg_distance: number
    }>
  } | null>(null)

  // T-Group Edge Panel state
  const [edgePanel, setEdgePanel] = useState<EdgePanelData | null>(null)
  const edgePrevTimestampRef = useRef<string | null>(null)

  const fetchEdgeData = useCallback(async () => {
    try {
      const r = await authedFetch(`/api/brain/trading?type=edge-readings&_t=${Date.now()}`)
      const d = await r.json()
      // v3.77.1: any successful server response proves transport reachability
      setLastFetchOkAt(Date.now())
      if (d?.timestamp) {
        // Detect new T-group arrival near :51 → browser notification
        if (edgePrevTimestampRef.current && d.timestamp !== edgePrevTimestampRef.current) {
          const stationEntries = Object.values(d.stations || {}) as EdgeStationReading[]
          if (stationEntries.length > 0 && typeof window !== 'undefined' && 'Notification' in window) {
            if (Notification.permission === 'granted') {
              const killCount = (d.kills_today || []).filter((k: EdgeKill) => k.minutes_since_kill < 5).length
              const firstStation = stationEntries[0]
              new Notification('T-GROUP UPDATE', {
                body: `${firstStation.city} ${firstStation.day_high_f}°F — ${killCount} bucket${killCount !== 1 ? 's' : ''} killed`,
                tag: 'tgroup-update',
              })
            }
          }
        }
        edgePrevTimestampRef.current = d.timestamp
        setEdgePanel(d)
      }
    } catch {
      // silent
    }
  }, [])

  const fetchRecommended = useCallback(async () => {
    setRecLoading(true)
    try {
      const r = await authedFetch('/api/brain/trading?type=recommended-trades')
      const d = await r.json()
      if (d?.timestamp) setRecTrades(d)
    } catch {
      /* silent */
    }
    setRecLoading(false)
  }, [])

  const fetchGFSSignals = useCallback(async (date?: string) => {
    setGfsLoading(true)
    try {
      const params = date ? `&date=${date}` : ''
      const res = await authedFetch(`/api/brain/trading?type=gfs-signals${params}`)
      const data = await res.json()
      if (data?.signals) {
        setGfsSignals(data.signals)
        setGfsDate(data.date)
        setGfsSummary(data.summary)
      }
    } catch {
      /* silent */
    }
    setGfsLoading(false)
  }, [])

  const [_botToggling, _setBotToggling] = useState(false)

  // Dry-run state
  const [_dryRunning, _setDryRunning] = useState(false)
  const [_dryRunResults, _setDryRunResults] = useState<{
    deadBuckets: { city: string; bucket: string; qualifyingHigh: string; ceiling: string; source: string }[]
    metarLeads: string[]
    output: string
    timestamp: string
  } | null>(null)
  const [_dryRunError, _setDryRunError] = useState<string | null>(null)

  const [_tradeScorecard, setTradeScorecard] = useState<TradeScorecard | null>(null)
  // predictions state removed — v2 engine data comes inline via c.jarvisPrediction

  // Fast weather-only refresh (every 15s) — the data the operator trades on.
  // Phase 02.17.7 + v3.77.14: aborts the previous weather-intel fetch before
  // starting a new one. Request versioning adds a second guard: even if the
  // abort races the completion, the response is dropped if a newer request
  // has already been started.
  const fetchWeatherFast = useCallback(async () => {
    weatherIntelAbortRef.current?.abort()
    const ac = new AbortController()
    weatherIntelAbortRef.current = ac
    const signal = ac.signal
    const myId = ++fastReqIdRef.current
    try {
      // Batch both weather requests into a single HTTP call — eliminates N+1 pattern
      const batchRes = await authedFetch(`/api/brain/trading?types=weather-report,weather-intel&_t=${Date.now()}`, {
        signal,
      })
      if (signal.aborted) return
      if (myId !== fastReqIdRef.current) return // stale response — a newer fetch already ran
      const batchData = await batchRes.json()
      if (signal.aborted) return
      if (myId !== fastReqIdRef.current) return // stale response — a newer fetch already ran
      const wxData = batchData['weather-report']
      if (wxData?.cities) setWeatherReport(wxData)
      const wiData = batchData['weather-intel']
      if (wiData?.cities) setWeatherIntel(wiData)
      // v3.77.0: capture structured freshness payload for the FreshnessBar.
      // Also stamp lastFetchOkAt for DISCONNECTED detection.
      if (wiData?.freshness) setFreshness(wiData.freshness as FreshnessPayload)
      setLastFetchOkAt(Date.now())
      setLastRefresh(new Date())
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      // silent on other errors — full refresh will catch them
    }
  }, [])

  // Abort controller ref — cancels stale fetch responses on unmount or re-fetch
  const abortControllerRef = useRef<AbortController | null>(null)
  // Phase 02.17.7 (2026-04-10): Dedicated abort controller for ANY request that
  // includes weather-intel. Separate from abortControllerRef (which is for
  // fetchFastData's balance/positions batch) so an unrelated fast-data abort
  // doesn't also kill an in-flight weather-intel fetch. A new weather-intel
  // request aborts the previous one, so only the latest is allowed to resolve.
  const weatherIntelAbortRef = useRef<AbortController | null>(null)
  // v3.77.14: Request versioning — monotonically-increasing counters for each
  // fetch path. If a fetch completes but its version ID is older than the
  // current counter, the response is discarded. This is a belt-and-suspenders
  // guard on top of the existing AbortController: even if the abort races, an
  // old response can never overwrite newer state.
  const fastReqIdRef = useRef(0)
  const slowReqIdRef = useRef(0)
  // In-flight guard for slow data — prevents overlapping slow fetches
  const slowInFlightRef = useRef(false)

  // FAST TIER: balance, positions, trades, pnl, config, profile-stats, bot-strategy
  // These load immediately and render the page skeleton
  const fetchFastData = useCallback(async () => {
    try {
      abortControllerRef.current?.abort()
      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal
      const _t = Date.now()
      const batchRes = await authedFetch(
        `/api/brain/trading?types=balance,positions,trades,pnl,config,profile-stats,bot-strategy&_t=${_t}`,
        { signal },
      )
      if (signal.aborted) return
      const batchData = await batchRes.json()
      // v3.77.1: any successful server response proves transport reachability
      setLastFetchOkAt(Date.now())

      const balData = batchData['balance']
      const posData = batchData['positions']
      const trdData = batchData['trades']
      const pnlJson = batchData['pnl']
      const cfgData = batchData['config']
      const psData = batchData['profile-stats']
      const bsData = batchData['bot-strategy']

      if (cfgData && !cfgData.error) setBotConfig(cfgData)
      if (psData?.portfolioValue !== undefined) setProfileStats(psData)
      if (bsData?.recommendations) setBotStrategy(bsData)

      // Batch the 3 non-blocking secondary requests into a single HTTP call
      authedFetch('/api/brain/trading?types=trade-scorecard,bot-status,paper-trades')
        .then((r) => r.json())
        .then((d) => {
          const scorecardData = d?.['trade-scorecard']
          if (scorecardData && !scorecardData.error) setTradeScorecard(scorecardData)
          const botStatusData = d?.['bot-status']
          if (botStatusData?.status) setSniperBot(botStatusData)
          const paperTradesData = d?.['paper-trades']
          if (paperTradesData && !paperTradesData.error && paperTradesData.strategy) setPaperTrades(paperTradesData)
        })
        .catch(() => {})

      // Fetch recommended trades (non-blocking)
      fetchRecommended()

      // Fetch GFS Sniper signals (non-blocking)
      fetchGFSSignals()

      if (pnlJson.totalBuyUsdc !== undefined) setPnlData(pnlJson)

      if (typeof balData.balance === 'number') setBalance(balData.balance)

      // Polymarket positions API returns: title, size, avgPrice, curPrice,
      // initialValue, currentValue, cashPnl, realizedPnl, outcome, outcomeIndex
      if (Array.isArray(posData)) {
        const normalized: Position[] = posData.map((p: Record<string, unknown>) => {
          const initialValue = Number(p.initialValue || 0)
          const currentValue = Number(p.currentValue || 0)
          const cashPnl = Number(p.cashPnl || 0)
          const realizedPnl = Number(p.realizedPnl || 0)
          // Polymarket: position is closed when currentValue is near zero
          const closed = currentValue <= 0.01
          return {
            asset: String(p.asset || ''),
            conditionId: String(p.conditionId || ''),
            market: String(p.title || ''),
            outcome: String(p.outcome || ''),
            outcomeIndex: Number(p.outcomeIndex ?? 0),
            size: Number(p.size || 0),
            avgPrice: Number(p.avgPrice || 0),
            curPrice: Number(p.curPrice || 0),
            initialValue,
            currentValue,
            cashPnl,
            realizedPnl,
            percentPnl: Number(p.percentPnl || 0),
            closed,
          }
        })
        setPositions(normalized)
      }

      // Polymarket trades API returns: title, side, price, size, timestamp (unix),
      // outcome, outcomeIndex, transactionHash
      if (Array.isArray(trdData)) {
        const normalized: Trade[] = trdData.map((t: Record<string, unknown>) => ({
          id: String(t.transactionHash || t.id || ''),
          timestamp: Number(t.timestamp || 0),
          market: String(t.title || ''),
          outcome: String(t.outcome || ''),
          side: String(t.side || ''),
          price: Number(t.price || 0),
          size: Number(t.size || 0),
        }))
        setTrades(normalized)
      }

      setLastRefresh(new Date())
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('Trading fast data fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // SLOW TIER: weather-report, weather-intel, model-status, daily-scorecard
  // These fire ~98+ concurrent external API calls and load in background after fast tier.
  // Phase 02.17.7: uses the dedicated weatherIntelAbortRef instead of the
  // shared abortControllerRef (which belongs to fetchFastData's unrelated
  // balance/positions batch). A new weather-intel fetch aborts the previous,
  // so an older slow-tier response cannot overwrite a newer fast-tier one.
  // v3.77.14: request versioning added as belt-and-suspenders on top of abort.
  const fetchSlowData = useCallback(async () => {
    if (slowInFlightRef.current) return // prevent overlapping slow fetches
    slowInFlightRef.current = true
    weatherIntelAbortRef.current?.abort()
    const ac = new AbortController()
    weatherIntelAbortRef.current = ac
    const signal = ac.signal
    const myId = ++slowReqIdRef.current
    try {
      const _t = Date.now()
      const batchRes = await authedFetch(
        `/api/brain/trading?types=weather-report,weather-intel,model-status,daily-scorecard&_t=${_t}`,
        { signal },
      )
      if (signal.aborted) return
      if (myId !== slowReqIdRef.current) return // stale response — a newer fetch already ran
      const batchData = await batchRes.json()
      if (signal.aborted) return
      if (myId !== slowReqIdRef.current) return // stale response — a newer fetch already ran
      // v3.77.1: any successful server response proves transport reachability
      setLastFetchOkAt(Date.now())

      const wxData = batchData['weather-report']
      const wiData = batchData['weather-intel']
      const msData = batchData['model-status']
      const scData = batchData['daily-scorecard']

      if (wxData?.cities) setWeatherReport(wxData)
      if (wiData?.cities) setWeatherIntel(wiData)
      // v3.77.3: fetchSlowData also receives weather-intel with freshness —
      // must setFreshness here too. Previously only fetchWeatherFast (15s)
      // stamped freshness state; if its abort race kept it from ever
      // resolving, freshness stayed null → DISCONNECTED with "Server v?".
      if (wiData?.freshness) setFreshness(wiData.freshness as FreshnessPayload)
      if (msData?.positions) setModelStatus(msData)
      if (scData?.cityAccuracy) setScorecard(scData)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('Trading slow data fetch error:', err)
    } finally {
      slowInFlightRef.current = false
    }
  }, [])

  // Combined fetch: fast first, then slow in background
  const fetchData = useCallback(async () => {
    await fetchFastData()
    fetchSlowData()
  }, [fetchFastData, fetchSlowData])

  // Fast bot-status refresh — trades, fills, dead buckets update every 15s
  const fetchBotStatus = useCallback(async () => {
    try {
      const r = await authedFetch(`/api/brain/trading?type=bot-status&_t=${Date.now()}`)
      const d = await r.json()
      // v3.77.1: any successful server response proves transport reachability
      setLastFetchOkAt(Date.now())
      if (d?.status) setSniperBot(d)
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchEdgeData()
    // Weather data refreshes every 15s (was 5s — too aggressive, causes 98+ API calls per tick)
    const weatherInterval = setInterval(fetchWeatherFast, 15_000)
    // Bot status (fills, trades, dead buckets) refreshes every 15s
    const botInterval = setInterval(fetchBotStatus, 15_000)
    // Edge panel refreshes every 10s (was 5s — T-group data from aviationweather.gov)
    const edgeInterval = setInterval(fetchEdgeData, 10_000)
    // Full data (positions, trades, PnL, etc.) refreshes every 60s
    const fullInterval = setInterval(fetchData, 60_000)
    return () => {
      abortControllerRef.current?.abort()
      clearInterval(weatherInterval)
      clearInterval(botInterval)
      clearInterval(edgeInterval)
      clearInterval(fullInterval)
    }
  }, [fetchData, fetchWeatherFast, fetchBotStatus, fetchEdgeData])

  // Detect new observations — flash green on city card when data updates
  const FLASH_DURATION_MS = 2000
  const flashTimeoutRef = useRef<number | null>(null)
  useEffect(() => {
    if (!weatherIntel?.cities) return
    setPrevTimestamps((prev) => {
      const newFlash = new Set<string>()
      const newTs: Record<string, number> = {}
      for (const c of weatherIntel.cities) {
        if (c.lastObsTimestamp) {
          newTs[c.city] = c.lastObsTimestamp
          if (prev[c.city] && c.lastObsTimestamp > prev[c.city]) {
            newFlash.add(c.city)
          }
        }
      }
      if (newFlash.size > 0) {
        setFlashCities(newFlash)
        flashTimeoutRef.current = window.setTimeout(() => setFlashCities(new Set()), FLASH_DURATION_MS)
      }
      return newTs
    })
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    }
  }, [weatherIntel])

  if (loading) return <LoadingState text="Loading trading data..." />

  // ─── KPIs ───
  // Correct PnL formula uses ALL-TIME trade activity (not just current positions).
  // The positions API only shows 13 current positions — resolved losers disappear.
  // Real PnL = position_value + sells + redeems - buys (from activity API).

  const openPositions = positions.filter((p) => !p.closed)
  const closedPositions = positions.filter((p) => p.closed)

  // Current position market value from Polymarket API currentValue (handles YES/NO pricing correctly)
  const positionValue = positions.reduce((s, p) => s + p.currentValue, 0)
  const totalInvested = pnlData?.totalBuyUsdc ?? positions.reduce((s, p) => s + p.initialValue, 0)
  const totalReturned = pnlData
    ? (pnlData.totalReturnedUsdc ??
      (pnlData.totalSellUsdc ?? 0) + (pnlData.totalRedeemUsdc ?? 0) + (pnlData.totalRewardUsdc ?? 0))
    : 0

  // Per-position PnL (for table display only)
  const positionPnl = (p: Position) => p.currentValue - p.initialValue

  // All-time Net PnL = position_value + cash_returned - total_spent
  // Without activity data (pnlData), we can only show unrealized PnL on open positions.
  // Showing positionValue - initialValue when all positions are resolved produces a
  // wildly wrong number because it ignores sells/redeems/rewards.
  const netPnl = pnlData
    ? positionValue + totalReturned - totalInvested
    : openPositions.reduce((s, p) => s + (p.currentValue - p.initialValue), 0)

  // Unrealized: current open positions only (for display breakdown)
  const _unrealizedPnl = openPositions.reduce((s, p) => s + positionPnl(p), 0)

  // Realized: total returned - cost of resolved markets (total bought - current positions cost)
  const currentPositionsCost = positions.reduce((s, p) => s + p.initialValue, 0)
  const resolvedCost = totalInvested - currentPositionsCost
  const _realizedPnl = totalReturned - resolvedCost

  // Win/loss on closed positions
  const wins = closedPositions.filter((p) => positionPnl(p) > 0.005).length
  const losses = closedPositions.filter((p) => positionPnl(p) < -0.005).length
  const _winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0

  // ─── Filtered Positions ───
  const filteredPositions = positions.filter((p) => {
    if (filter === 'open') return !p.closed
    if (filter === 'closed') return p.closed
    if (filter === 'weather') return isWxMarket(p.market)
    if (filter === 'nba') return isNbaMarket(p.market)
    if (filter === 'soccer') return isSoccerMarket(p.market)
    return true
  })

  // Open first (sorted by value desc), then closed (sorted by PnL desc)
  const _sortedPositions = [...filteredPositions].sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1
    if (!a.closed) return b.currentValue - a.currentValue
    return positionPnl(b) - positionPnl(a)
  })

  // Phase 02.20 (v3.78.0) — feed for the LiveObservationsPanel.
  // Maps each city in current weatherIntel to the active (un-killed) buckets
  // we want the panel to monitor for sub-METAR temperature crossings.
  const liveObsCityCards: CityCardLite[] = []
  for (const c of weatherIntel?.cities ?? []) {
    const reg = (STATION_REGISTRY as Record<string, { displayName?: string } | undefined>)[c.city]
    const buckets = (c.activeBuckets || [])
      .filter((b) => b.status !== 'DEAD')
      .map((b) => ({ label: b.label, upper: b.upper, noPrice: b.noPrice }))
    if (buckets.length === 0) continue
    liveObsCityCards.push({
      slug: c.city,
      displayName: reg?.displayName ?? c.city,
      unit: c.unit,
      activeBuckets: buckets,
    })
  }

  return (
    <div className="space-y-6 p-4 md:p-6 pb-24 md:pb-6">
      {/* v3.77.0: Enterprise-grade freshness bar — pinned to top, never lies.
          Derives state from server's snapshot timestamp, source ages, and
          server-vs-client build comparison. Disables trade actions when STALE. */}
      <FreshnessBar
        payload={freshness}
        clientBuild={(freshness as { server_build?: string } | null)?.server_build ?? (pkgJson.version as string)}
        lastFetchOkAt={lastFetchOkAt}
        onRefresh={() => {
          setRefreshing(true)
          fetchSlowData().finally(() => setRefreshing(false))
        }}
        refreshing={refreshing}
      />
      {/* Header */}
      <header className="sticky top-0 z-40 -mx-4 md:-mx-6 -mt-4 md:-mt-6 px-4 md:px-6 py-3 bg-[#070b10]/85 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 md:gap-4 min-w-0">
            <a
              href="https://tested.media"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center shrink-0 hover:opacity-80 transition-opacity"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/testedmedia.svg" alt="tested.media" className="h-5 md:h-6 w-auto" />
            </a>
            <span className="h-7 w-px bg-white/[0.12] shrink-0" />
            <PolymarketLogo className="h-5 md:h-6 w-auto text-white shrink-0" />
            <span className="h-7 w-px bg-white/[0.12] shrink-0" />
            <h1 className="text-lg md:text-xl font-bold text-white tracking-tight leading-tight truncate">
              Weather Command Center
            </h1>
          </div>
          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-500/25 bg-emerald-500/[0.07] text-[11px] font-semibold text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
            <span className="hidden md:inline text-[11px] text-gray-500 tabular-nums">
              v{pkgJson.version} &middot;{' '}
              {lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
            </span>
            <a
              href="#methodology"
              className="hidden md:inline-block px-3 py-1.5 rounded-lg border border-white/[0.08] hover:border-white/20 text-gray-300 hover:text-white text-xs font-medium transition-colors"
            >
              Methodology
            </a>
            <a
              href="#costs"
              className="hidden sm:inline-block px-3 py-1.5 rounded-lg border border-white/[0.08] hover:border-white/20 text-gray-300 hover:text-white text-xs font-medium transition-colors"
            >
              Feeds &amp; Costs
            </a>
            <button
              onClick={() => {
                fetchData()
                fetchWeatherFast()
              }}
              className="px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/25 text-cyan-400 text-xs font-semibold transition-colors"
              aria-label="Refresh now"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* v3.83.0: DST WU-resolution risk banner (March only).
          Phase 02.15 audit found 6 single-day ASOS-WU mismatches >=10°F over 730 days;
          3 cluster on actual DST transition dates (Mar 9 US, Mar 30 EU). 2 Toronto + 1
          Paris outliers fall in spring weeks but not on DST days — unexplained edge case.
          The banner surfaces this risk to traders during the March risk window. */}
      {(() => {
        const nowAst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' }))
        const isMarch = nowAst.getMonth() === 2 // 0-indexed: 2 = March
        if (!isMarch) return null
        return (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 flex items-start gap-3">
            <span className="text-amber-400 text-base leading-none mt-0.5">⚠</span>
            <div className="flex-1 text-xs">
              <div className="font-bold text-amber-300 mb-1">DST WU-Resolution Risk Window</div>
              <p className="text-amber-200/80 leading-relaxed">
                March DST transitions historically produce WU↔ASOS mismatches up to 18°F on transition days for
                international PM cities (Toronto Mar 9, Paris/London Mar 30). Polymarket resolves on WU V1 daily-max —
                so a Mar 30 settlement on Paris/London could land in a different bucket than ASOS forecasts suggest.
                Avoid resolving high-stakes trades on Mar 9 (US DST) and Mar 30 (EU DST).
              </p>
              <p className="text-[10px] text-gray-500 mt-1">
                Source: <code className="text-gray-400">data/weather/asos_wu_all_cities_verify.json</code> Phase 02.15
                outlier audit
              </p>
            </div>
          </div>
        )
      })()}

      {/* ─── Section: Weather Intelligence ─── */}
      {weatherIntel && (
        <GlassCard className="p-4 md:p-6" delay={0.5}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <SvgIcon name="satellite" size={18} className="text-cyan-400" /> Weather Intelligence
              </h2>
              <p className="text-sm text-gray-400 mt-0.5">
                WU actuals + model forecasts + market data + edge + recommendations &middot; Click city to expand
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* Optional add-ons — quiet status cluster. Both ship disabled; dots go
                  emerald only when the operator has wired them up. Click-through to spec. */}
              {(() => {
                const edgeMins = weatherIntel.edgeLastUpdate
                  ? Math.round((Date.now() - new Date(weatherIntel.edgeLastUpdate).getTime()) / 60_000)
                  : null
                const edgeConnected = edgeMins !== null && edgeMins < 30
                return (
                  <a
                    href="#costs"
                    className="hidden lg:flex items-center gap-3 px-3 py-1.5 rounded-lg border border-white/[0.06] hover:border-white/[0.16] transition-colors"
                    title="Optional self-hosted add-ons, both disabled by default. Edge daemon: 30-second METAR polling on your own box. Calling agent: dials US airport ASOS phone lines over your own VoIP line, per-city opt-in. Click for specs and running costs."
                  >
                    <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-gray-600">
                      Add-ons
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${edgeConnected ? 'bg-emerald-400' : 'bg-gray-600'}`}
                      />
                      Edge daemon
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                      Call agent
                    </span>
                  </a>
                )
              })()}
              <span className="text-xs text-gray-500">
                {new Date(weatherIntel.timestamp).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}{' '}
                &middot; Auto-refresh 10s
              </span>
            </div>
          </div>

          {/* ─── FADE LOCK Banner (only when active) ─── */}
          {weatherIntel.cities.filter((c) => c.isFadeLock).length > 0 && (
            <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              <div className="text-xs font-bold text-amber-400 mb-1">FADE LOCK ACTIVE</div>
              <div className="flex flex-wrap gap-1.5">
                {weatherIntel.cities
                  .filter((c) => c.isFadeLock)
                  .map((c) => (
                    <span key={c.city} className="text-xs font-mono text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded">
                      {cityDisplay(c.city).toUpperCase()} — {c.runningHigh?.toFixed(2)}
                      {c.unit === 'F' ? '°F' : '°C'} (↓{c.hoursSincePeak.toFixed(1)}h)
                    </span>
                  ))}
              </div>
              <div className="text-[10px] text-amber-500/80 mt-1">
                High historically holds 86-100% of the time once declining after 1PM
              </div>
            </div>
          )}

          <div className="md:hidden text-[10px] text-gray-600 uppercase tracking-wider mb-1">Swipe sideways for all columns</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]">
              <thead>
                <tr className="text-gray-400 text-xs uppercase tracking-wider border-b border-white/10">
                  <Tip
                    label="City"
                    tip="City being tracked for temperature markets. S/A = top edge, D = avoid. Click to restore live-status order."
                    className="text-left pb-3 pr-2"
                    onSort={() => pickSort('status')}
                    sortActive={citySort === 'status'}
                  />
                  <Tip
                    label="Time"
                    tip="Current local time in the CITY's timezone (not yours) — critical for knowing if the daily high is set"
                    className="text-left pb-3 pr-2"
                  />
                  <Tip
                    label="V1 High"
                    tip="The official daily high from Weather Underground V1 — this is what Polymarket uses to resolve the market"
                    className="text-right pb-3 pr-2"
                  />
                  <Tip
                    label="METAR"
                    tip="Latest METAR observation from aviation weather. Shows high temp. Uses c.metarHigh from trading API — available for ALL cities. Updates at :51 (US) or :20/:50 (intl)."
                    className="text-right pb-3 pr-2 text-blue-400"
                  />
                  <Tip
                    label="ASOS"
                    tip="Current ASOS reading (primary) with today's ASOS high as sub-text. Fastest source available to this deployment (1-minute feed, phone add-on where enabled, or METAR). US stations lead WU by 3-5 min; international METAR by ~10 min."
                    className="text-right pb-3 pr-2 text-pink-400"
                  />
                  <Tip
                    label="Now"
                    tip="Current live temperature from the fastest available source"
                    className="text-right pb-3 pr-2"
                  />
                  <Tip
                    label="↗"
                    tip="Trend: ↑ = still rising, → = at peak, ↓ = declining (high locked in), = fade lock (confirmed decline)"
                    className="text-center pb-3 pr-2"
                  />
                  <Tip
                    label="Forecast"
                    tip="AI forecast from best-performing model for this city (2-year backtest). Click to sort highest win rate first; click again for lowest first."
                    className="text-left pb-3 pr-2"
                    onSort={() => pickSort('forecast')}
                    sortActive={citySort === 'forecast'}
                    sortDir={citySortDir}
                  />
                  <Tip
                    label="Peak"
                    tip="Most common hour of day when the daily high is recorded (based on 731 days of history)"
                    className="text-center pb-3 pr-2"
                  />
                  <Tip
                    label="@3PM"
                    tip="3 PM lock rate — once the daily high is set, how likely is it to still hold at 3 PM? (WU backtest, 728 days). Hover row for 1h/2h/3h hold rates."
                    className="text-center pb-3 pr-2"
                  />
                  <Tip
                    label="Ensemble"
                    tip="Per-city weighted ensemble forecast. Hover for individual model breakdown (GFS, ICON, ECMWF, UKMO, MF, GEM, JMA, KNMI, KMA) + spread."
                    className="text-right pb-3 pr-2"
                  />
                  <Tip
                    label="AI"
                    tip="7-stage prediction engine: bias-corrected ensemble + live conditions (wind, clouds, humidity, pressure) + trajectory + market signal. Methods: CONFIRMED (V1 locked), TRAJECTORY (obs-driven), BLEND (mix), ENSEMBLE (models only)."
                    className="text-right pb-3 pr-2"
                  />
                  <Tip
                    label="Markets"
                    tip="Live/Total buckets with active order books. Live = price between 1¢-99¢. Total = all buckets including settled."
                    className="text-center pb-3 pr-3"
                  />
                  <Tip
                    label="Action"
                    tip="Algorithm recommendation: BUY = confirmed lock or strong edge, FADE = temp declining + locked in, WATCH = edge exists but uncertain, SKIP = no edge, CLOSED = past trading window"
                    className="text-left pb-3 pr-2"
                  />
                </tr>
              </thead>
              <tbody>
                {/* v3.77.20: shared LIVE > SLEEP > LOCKED comparator from `@/lib/city-status-sort`.
                    Behaviour identical to the v3.77.15 inline sort — every city list on the
                    dashboard now calls this same function so ordering never drifts between pages. */}
                {[...weatherIntel.cities]
                  .sort((a, b) => {
                    const dir = citySortDir === 'desc' ? 1 : -1
                    const bestWr = (x: typeof a) =>
                      x.bestModelWR ?? Math.max(0, ...Object.values(x.perModelWinRates ?? { _: 0 }))
                    // FORECAST column value: dynamic signal WR, else strategy/best-model WR
                    const fc = (x: typeof a) => x.dynamicSignal?.currentWR ?? x.strategyWR ?? x.bestModelWR ?? 0
                    if (citySort === 'forecast') return dir * (fc(b) - fc(a) || bestWr(b) - bestWr(a))
                    return compareCitiesByStatus(a, b)
                  })
                  .map((c) => {
                  const unitLabel = c.unit === 'F' ? '°F' : '°C'
                  const isExpanded = expandedCity === c.city

                  // Trend icon and color
                  const trendIcon = c.highIsDeclining
                    ? '↓'
                    : c.trendLabel === 'AT PEAK'
                      ? '→'
                      : c.trendLabel === 'Rising'
                        ? '↑'
                        : ''
                  const trendColor = c.highIsDeclining
                    ? 'text-amber-400'
                    : c.trendLabel === 'AT PEAK'
                      ? 'text-yellow-400'
                      : 'text-gray-400'

                  // Recommendation color
                  const recColor =
                    c.recommendation === 'BUY'
                      ? 'text-green-400 bg-green-500/10'
                      : c.recommendation === 'FADE_BUY'
                        ? 'text-amber-400 bg-amber-500/10'
                        : c.recommendation === 'WATCH'
                          ? 'text-yellow-400 bg-yellow-500/10'
                          : c.recommendation === 'CLOSED'
                            ? 'text-gray-500 bg-gray-500/10'
                            : 'text-gray-500 bg-gray-500/10'

                  // Tier badge colors
                  const tierBadge: Record<string, string> = {
                    S: 'text-yellow-300 bg-yellow-500/20 border border-yellow-500/30',
                    A: 'text-green-400 bg-green-500/15 border border-green-500/20',
                    B: 'text-blue-400 bg-blue-500/10',
                    C: 'text-gray-500 bg-gray-500/10',
                    D: 'text-gray-600 bg-gray-600/10',
                  }

                  // Row glow for FADE LOCK and top-tier cities
                  const isLocked = c.recommendation === 'CLOSED'
                  const isNighttime = c.localHour >= 20 || c.localHour < 6
                  const isPrimeHours = c.localHour >= 10 && c.localHour < 16

                  // Left border glow for prime trading hours
                  const leftBorder =
                    (c.recommendation === 'BUY' || c.recommendation === 'FADE_BUY') && isPrimeHours
                      ? 'border-l-2 border-l-green-500'
                      : c.recommendation === 'WATCH' && isPrimeHours
                        ? 'border-l-2 border-l-amber-500/60'
                        : ''

                  // Phase 02.17.20: Bumped opacity floors — old 30/40% made rows invisible
                  // on dark backgrounds, the operator couldn't read the data at all.
                  const rowBg =
                    isNighttime && isLocked
                      ? 'border-b border-white/[0.02] bg-white/[0.01] opacity-60'
                      : isNighttime && !isLocked
                        ? `border-b border-white/[0.03] bg-white/[0.01] opacity-70 ${leftBorder}`
                        : isLocked && !isPrimeHours
                          ? 'border-b border-white/[0.03] bg-white/[0.01] opacity-75'
                          : isLocked && isPrimeHours
                            ? 'border-b border-white/[0.04] bg-white/[0.02] opacity-85'
                            : c.isFadeLock
                              ? `border-b border-amber-500/20 bg-amber-500/[0.06] hover:bg-amber-500/[0.10] ${leftBorder}`
                              : c.tier === 'S'
                                ? `border-b border-yellow-500/10 bg-yellow-500/[0.03] hover:bg-yellow-500/[0.06] ${leftBorder}`
                                : c.tier === 'A'
                                  ? `border-b border-green-500/10 bg-green-500/[0.02] hover:bg-green-500/[0.05] ${leftBorder}`
                                  : `border-b border-white/[0.03] hover:bg-white/[0.04] ${leftBorder}`

                  return (
                    <React.Fragment key={c.city}>
                      <tr
                        className={`${rowBg} cursor-pointer transition-all duration-300 h-[52px] ${flashCities.has(c.city) ? 'ring-2 ring-green-400/50 ring-inset' : ''}`}
                        onClick={() => setExpandedCity(isExpanded ? null : c.city)}
                      >
                        <td className="py-3 pr-3 text-sm text-gray-200 font-semibold uppercase">
                          <span className="flex items-center gap-1.5">
                            <span className={`text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                            {isLocked && isNighttime && <span title="Nighttime + market closed"></span>}
                            {isLocked && !isNighttime && <span title="Market resolved — all buckets settled"></span>}
                            {!isLocked && isNighttime && <span title="Nighttime — not actively trading"></span>}
                            {!isLocked && !isNighttime && c.isFadeLock && (
                              <span title="FADE LOCK — high confirmed, declining">↘</span>
                            )}
                            {cityDisplay(c.city)}
                            {c.tier && (
                              <span
                                className={`text-[9px] font-black px-1 py-0.5 rounded ${tierBadge[c.tier] || tierBadge.C}`}
                                title={`${c.tier}-tier city${c.centerRate ? ` (${c.centerRate}% center hit)` : ''}`}
                              >
                                {c.tier}
                              </span>
                            )}
                            {/* v3.83.0: WU resolution audit-status badge for Polymarket cities.
                                Authority: data/weather/asos_wu_all_cities_verify.json (Phase 02.15 V1 API).
                                CONTAMINATED hard-overrides any tier badge — London is never tradable
                                until WU per-day truth lands (Issue #493). */}
                            {c.wuAuditStatus === 'clean' && (
                              <span
                                className="text-[9px] font-black px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                title="WU VERIFIED: Phase 02.15 confirmed ASOS-WU exact match >=95% over 730 days. ASOS win rates are a trustworthy proxy for Polymarket WU resolution."
                              >
                                WU ✓
                              </span>
                            )}
                            {c.wuAuditStatus === 'proxy_verified' && (
                              <span
                                className="text-[9px] font-black px-1 py-0.5 rounded bg-lime-500/20 text-lime-300 border border-lime-500/30"
                                title="PROXY VERIFIED: Phase 02.16 buynosafe audit shows WU never resolves LOWER than ASOS over 730 days. Safe for NO-side trades. Full V1 daily-max audit pending Issue #493."
                              >
                                WU ~✓
                              </span>
                            )}
                            {c.wuAuditStatus === 'contaminated' && (
                              <span
                                className="text-[9px] font-black px-1 py-0.5 rounded bg-red-500/30 text-red-200 border border-red-500/50 animate-pulse"
                                title="CONTAMINATED — DO NOT TRADE. Phase 02.15 verified WU station drift makes ASOS WR unreliable as a WU proxy (47.7% match, max 10.8°F gap). HARD-BLOCKED from all trade endpoints."
                              >
                                ⚠ CONTAMINATED
                              </span>
                            )}
                            {c.wuAuditStatus === 'proxy_contaminated' && (
                              <span
                                className="text-[9px] font-black px-1 py-0.5 rounded bg-orange-500/30 text-orange-200 border border-orange-500/50 animate-pulse"
                                title="PROXY CONTAMINATED — DO NOT TRADE. WU resolves LOWER than ASOS on 60%+ of days (urban heat island). ASOS-based WR overstates Polymarket success. HARD-BLOCKED from trade endpoints."
                              >
                                ⚠ WU DRIFT
                              </span>
                            )}
                            {c.wuAuditStatus === 'unverified' && (
                              <span
                                className="text-[9px] font-black px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
                                title="UNVERIFIED — TRADE WITH CAUTION. No ASOS-WU cross-check exists for this city. ASOS WR may not match the WU value Polymarket actually pays out on. Issue #493."
                              >
                                ⚠ UNVERIFIED
                              </span>
                            )}
                            {c.wuAuditStatus === 'unavailable' && (
                              <span
                                className="text-[9px] font-black px-1 py-0.5 rounded bg-gray-500/20 text-gray-400 border border-gray-500/30"
                                title="No WU station data available for this Polymarket city. ASOS WR cannot be cross-verified against the WU resolution source."
                              >
                                WU N/A
                              </span>
                            )}
                            {/* Fast source LEADING — ASOS/METAR high > V1 high — HIDDEN for HK (VHHH irrelevant) */}
                            {c.city !== 'hong-kong' &&
                              c.asosHigh !== null &&
                              c.asosHigh !== undefined &&
                              c.runningHigh !== null &&
                              c.runningHigh !== undefined &&
                              c.asosHigh > c.runningHigh && (
                                <span
                                  className="text-[8px] px-1 py-0.5 rounded bg-pink-500/20 text-pink-400 font-bold animate-pulse"
                                  title={`${c.unit === 'C' ? 'METAR' : c.dataFreshness?.asosCurrentSource === 'phone' ? 'ASOS phone' : 'ASOS'}: ${c.asosHigh.toFixed(2)}° vs V1: ${c.runningHigh}° — V1 will catch up at next hourly`}
                                >
                                  {c.unit === 'C' ? 'METAR' : 'ASOS'} {c.asosHigh.toFixed(2)}°
                                </span>
                              )}
                            {/* Fast source current (not leading) — HIDDEN for HK */}
                            {c.city !== 'hong-kong' &&
                              c.asosCurrent !== null &&
                              c.asosCurrent !== undefined &&
                              (c.asosHigh === null ||
                                c.asosHigh === undefined ||
                                c.runningHigh === null ||
                                c.runningHigh === undefined ||
                                c.asosHigh <= c.runningHigh) && (
                                <span
                                  className="text-[8px] px-1 py-0.5 rounded bg-pink-500/10 text-pink-400/70"
                                  title={`${c.unit === 'C' ? 'METAR' : 'ASOS'} current: ${c.asosCurrent.toFixed(2)}°`}
                                >
                                  {c.asosCurrent.toFixed(2)}°
                                </span>
                              )}
                            {/* METAR LEADING — HIDDEN for HK (VHHH airport is irrelevant) */}
                            {c.city !== 'hong-kong' &&
                              c.metarHigh !== null &&
                              c.metarHigh !== undefined &&
                              c.runningHigh !== null &&
                              c.runningHigh !== undefined &&
                              c.metarHigh > c.runningHigh &&
                              (c.asosHigh === null || c.asosHigh === undefined) && (
                                <span
                                  className="text-[8px] px-1 py-0.5 rounded bg-pink-500/20 text-pink-400 font-bold animate-pulse"
                                  title={`METAR shows ${c.metarHigh}° vs V1 ${c.runningHigh}° — V1 will catch up at next hourly`}
                                >
                                  METAR {c.metarHigh.toFixed(2)}°
                                </span>
                              )}
                            {/* RISING — recent observations trending up */}
                            {c.trendLabel === 'Rising' && !c.isFadeLock && (
                              <span className="text-[8px] px-1 py-0.5 rounded bg-red-500/20 text-red-400 font-bold animate-pulse">
                                RISING
                              </span>
                            )}
                            {/* Market Speed badge */}
                            {c.marketSpeed && (
                              <span
                                className={`text-[8px] px-1 py-0.5 rounded font-bold ${
                                  c.marketSpeed === 'SLOW'
                                    ? 'bg-green-500/20 text-green-400'
                                    : c.marketSpeed === 'MEDIUM'
                                      ? 'bg-yellow-500/20 text-yellow-400'
                                      : 'bg-red-500/20 text-red-400'
                                }`}
                                title={`Market speed: ${c.marketSpeed} — ${
                                  c.marketSpeed === 'SLOW'
                                    ? 'Deadlocked, few price moves'
                                    : c.marketSpeed === 'MEDIUM'
                                      ? 'Moderate activity'
                                      : 'Fast-moving market, active trading'
                                }`}
                              >
                                {c.marketSpeed === 'SLOW' ? '' : c.marketSpeed === 'MEDIUM' ? '' : ''}
                              </span>
                            )}
                          </span>
                        </td>
                        <td
                          className="py-3 pr-3 text-sm text-gray-300 font-mono whitespace-nowrap"
                          title="Local time in the city (not your timezone)"
                        >
                          {c.localTime || '—'}
                        </td>
                        {/* V1 High */}
                        <td
                          className="py-3 pr-2 text-right text-sm font-mono text-orange-400 font-bold cursor-help"
                          title={`V1 Last Update: ${c.lastObsLocalTime || 'unknown'}${c.runningHigh !== null ? `\nV1 Running High: ${c.runningHigh.toFixed(2)}${unitLabel}` : ''}${c.wuWebsiteHigh !== null && c.wuWebsiteHigh !== undefined ? `\nWU Website "High": ${c.wuWebsiteHigh}${unitLabel} (V3 max24h — can differ from V1!)` : ''}${c.currentTemp !== null ? `\nV3 Live: ${c.currentTemp.toFixed(2)}${unitLabel}` : ''}${c.nextExpectedTimestamp ? `\nNext V1: ~${new Date(c.nextExpectedTimestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}\n\nV1 = Polymarket resolution source.\nWU Website "High" uses V3 max24h — can round differently than V1.`}
                        >
                          <div className="flex flex-col items-end leading-tight">
                            {c.v1ArchiveHigh !== null ? (
                              <span>{c.v1ArchiveHigh.toFixed(2) + unitLabel}</span>
                            ) : c.wuFcstHigh !== null && c.wuFcstHigh !== undefined ? (
                              // Phase 02.17.23: fallback to WU forecast high when V1 missing
                              <span className="text-orange-300/60" title="V1 unavailable — showing WU forecast high">
                                {c.wuFcstHigh}
                                {unitLabel}
                              </span>
                            ) : c.ensemble !== null && c.ensemble !== undefined ? (
                              // Secondary fallback: ensemble forecast
                              <span className="text-orange-300/40" title="V1 unavailable — showing ensemble forecast">
                                ~{c.ensemble.toFixed(1)}
                                {unitLabel}
                              </span>
                            ) : (
                              <span>—</span>
                            )}
                            {c.wuWebsiteHigh !== null &&
                              c.wuWebsiteHigh !== undefined &&
                              c.v1ArchiveHigh !== null &&
                              c.wuWebsiteHigh !== Math.round(c.v1ArchiveHigh) && (
                                <span
                                  className="text-[8px] text-amber-400"
                                  title="WU website shows a different high than V1 archive — V1 archive is the resolution source"
                                >
                                  WU:{c.wuWebsiteHigh}°
                                </span>
                              )}
                            {c.v3LiveCurrent !== null && c.v3LiveCurrent !== undefined && (
                              <span
                                className="text-[8px] text-cyan-400/70"
                                title="WU V3 live reading — may interpolate between METAR reports. NOT the PM resolution source."
                              >
                                V3:{c.v3LiveCurrent.toFixed(1)}°
                              </span>
                            )}
                            {c.metarPeak !== null && c.metarPeak !== undefined && c.metarPeak !== c.v1ArchiveHigh && (
                              <span
                                className="text-[8px] text-blue-400/70"
                                title="METAR station peak today — independent cross-ref. Near-real-time but integer-only."
                              >
                                M:{c.metarPeak.toFixed(1)}°
                              </span>
                            )}
                          </div>
                        </td>
                        {/* METAR — from API. Phase 02.17.2: Hong Kong shows
                              HKO Observatory live readings here because Polymarket
                              resolves HK from HKO, not VHHH airport. Every other
                              city shows its METAR station observations. */}
                        <td
                          className="py-3 pr-2 text-right text-sm font-mono cursor-help"
                          title={`METAR High: ${c.metarHigh?.toFixed(2) ?? '—'}${unitLabel}\nMETAR Now: ${c.metarCurrent?.toFixed(2) ?? '—'}${unitLabel}\nLast obs: ${c.metarLastObsTime ?? 'unknown'}\nStation: ${c.station}${c.metarGrade === 'C' ? `\n\nWARNING: METAR unreliable for this city (${c.metarMatchPct ?? '?'}% match rate). Do not trust for trading decisions.` : ''}`}
                        >
                          {(() => {
                            const mHigh = c.metarHigh ?? null
                            if (mHigh === null) return <span className="text-gray-600 text-xs">—</span>
                            const v1 = c.runningHigh ?? 0
                            const ahead = mHigh > v1
                            const gap = mHigh - v1
                            const isUnreliable = c.metarGrade === 'C'
                            return (
                              <div className="flex flex-col items-end leading-tight">
                                <span
                                  className={`${isUnreliable ? 'text-red-400/60' : ahead ? 'text-blue-300 font-bold' : 'text-blue-400'} flex items-center gap-0.5`}
                                >
                                  {isUnreliable && (
                                    <span
                                      className="text-red-500 text-[10px]"
                                      title={`METAR unreliable for this city (${c.metarMatchPct ?? '?'}% match rate). Do not trust for trading decisions.`}
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                        className="w-3 h-3 inline-block"
                                      >
                                        <path
                                          fillRule="evenodd"
                                          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                                          clipRule="evenodd"
                                        />
                                      </svg>
                                    </span>
                                  )}
                                  {mHigh.toFixed(2)}
                                  {unitLabel}
                                  {ahead && gap >= 0.5 && !isUnreliable && (
                                    <span className="text-[8px] ml-0.5 text-blue-300 animate-pulse">
                                      +{gap.toFixed(1)}
                                    </span>
                                  )}
                                </span>
                                {isUnreliable && (
                                  <span
                                    className="text-[8px] text-red-500 font-bold cursor-help"
                                    title="This city's Weather Underground history diverges from the raw ASOS feed (382 mismatched days out of 730 for London). The engine flags it so you never size up on numbers the resolution source may not honor."
                                  >
                                    UNRELIABLE
                                  </span>
                                )}
                                {c.metarCurrent !== null &&
                                  c.metarCurrent !== undefined &&
                                  c.metarCurrent !== mHigh && (
                                    <span className="text-[9px] text-gray-500">now {c.metarCurrent.toFixed(2)}°</span>
                                  )}
                                {c.metarLastObsTime && (
                                  <span className="text-[8px] text-gray-500">@{c.metarLastObsTime}</span>
                                )}
                              </div>
                            )
                          })()}
                        </td>
                        {/* ASOS — Phase 02.17.2: Hong Kong shows HKO multi-station
                              live feed (27 stations across HK) since Polymarket
                              resolves from HKO Observatory, not VHHH airport. */}
                        <td
                          className="py-3 pr-2 text-right text-sm font-mono cursor-help"
                          title={
                            c.city === 'hong-kong'
                              ? `HKO Multi-Station Live (${weatherIntel?.hongKongMultiStation?.stations?.length ?? 0} stations across HK).\nObservatory: ${weatherIntel?.hongKongMultiStation?.observatoryTemp?.toFixed(1) ?? '—'}°C (Polymarket resolution source)\nHottest: ${weatherIntel?.hongKongMultiStation?.maxTemp?.toFixed(1) ?? '—'}°C at ${weatherIntel?.hongKongMultiStation?.maxPlace ?? '—'}\nColdest: ${weatherIntel?.hongKongMultiStation?.minTemp?.toFixed(1) ?? '—'}°C at ${weatherIntel?.hongKongMultiStation?.minPlace ?? '—'}\nSpread: ${weatherIntel?.hongKongMultiStation?.spread?.toFixed(1) ?? '—'}°C${weatherIntel?.hongKongMultiStation?.divergenceFlag ? ' (microclimate divergence)' : ''}`
                              : `ASOS Now: ${c.asosCurrent?.toFixed(2) ?? '—'}${unitLabel}\nASOS High: ${c.asosHigh?.toFixed(2) ?? '—'}${unitLabel}\nLast update: ${c.asosLastObsTime ?? 'unknown'}\n\nFastest source — 5min updates from NWS/ASOS. Primary value is the current reading; today's high is shown below.`
                          }
                        >
                          {c.city === 'hong-kong'
                            ? (() => {
                                const ms = weatherIntel?.hongKongMultiStation
                                if (!ms || ms.observatoryTemp === null) {
                                  return <span className="text-gray-600 text-xs">—</span>
                                }
                                const isDiverging = ms.divergenceFlag
                                return (
                                  <div className="flex flex-col items-end leading-tight">
                                    <span className={`font-bold ${isDiverging ? 'text-pink-300' : 'text-pink-400'}`}>
                                      {ms.observatoryTemp.toFixed(1)}°C
                                    </span>
                                    {ms.maxTemp !== null && ms.minTemp !== null && (
                                      <span className="text-[9px] text-pink-500/70">
                                        {ms.minTemp.toFixed(1)}-{ms.maxTemp.toFixed(1)}°
                                      </span>
                                    )}
                                    <span className="text-[8px] text-pink-500/60">
                                      HKO {ms.stations?.length ?? 0}-st
                                    </span>
                                  </div>
                                )
                              })()
                            : (() => {
                                // v3.99.58 (project law 2026-04-19, 12:10 PM AST): ASOS column
                                // shows CURRENT temperature as the primary value, with today's
                                // high as sub-text. Previously the column rendered asosHigh as the
                                // big number and asosCurrent as a small "now X°" hint — the operator
                                // wants it reversed because the ASOS column is primarily a
                                // live-read cross-check against the V1 High column (which already
                                // exposes the daily peak).
                                //
                                // Phase 02.17.3 label-truth rule still applies: no silent fallback
                                // to METAR when ASOS is missing — show "—" instead.
                                const fastCurrent = c.asosCurrent ?? null
                                if (fastCurrent === null) return <span className="text-gray-600">—</span>
                                const v1 = c.runningHigh ?? 0
                                const ahead = fastCurrent > v1
                                const gap = fastCurrent - v1
                                return (
                                  <div className="flex flex-col items-end leading-tight">
                                    <span className={ahead ? 'text-pink-300 font-bold' : 'text-pink-400'}>
                                      {fastCurrent.toFixed(2)}
                                      {unitLabel}
                                      {ahead && gap >= 0.5 && (
                                        <span className="text-[8px] ml-0.5 text-pink-300 animate-pulse">
                                          +{gap.toFixed(1)}
                                        </span>
                                      )}
                                    </span>
                                    {c.asosHigh !== null && c.asosHigh !== undefined && c.asosHigh !== fastCurrent && (
                                      <span className="text-[9px] text-gray-500">high {c.asosHigh.toFixed(2)}°</span>
                                    )}
                                    {/* Data source + freshness badge */}
                                    {c.dataFreshness && (
                                      <span
                                        className={`text-[8px] font-mono ${
                                          c.dataFreshness.asosCurrentSource === 'phone'
                                            ? 'text-green-400'
                                            : c.dataFreshness.asosCurrentSource === 'metar'
                                              ? 'text-cyan-400'
                                              : c.dataFreshness.asosCurrentSource === 'edge'
                                                ? 'text-yellow-400'
                                                : 'text-gray-500'
                                        }`}
                                        title={`Source: ${c.dataFreshness.asosCurrentSource}\nASOS: ${c.dataFreshness.asosStaleMins !== null ? c.dataFreshness.asosStaleMins + 'm ago' : '—'}${c.dataFreshness.phoneStaleMins !== null ? `\nPhone: ${c.dataFreshness.phoneStaleMins}m ago` : ''}\nEdge: ${c.dataFreshness.edgeStaleMins !== null ? c.dataFreshness.edgeStaleMins + 'm ago' : '—'}\nT-group: ${c.dataFreshness.tgroupAvailable ? 'YES' : 'NO'}`}
                                      >
                                        {c.dataFreshness.asosCurrentSource === 'phone'
                                          ? ''
                                          : c.dataFreshness.asosCurrentSource === 'metar'
                                            ? '✈'
                                            : c.dataFreshness.asosCurrentSource === 'edge'
                                              ? ''
                                              : c.dataFreshness.asosCurrentSource === 'v3'
                                                ? ''
                                                : ''}
                                        {(c.dataFreshness.asosCurrentSource ?? 'none').toUpperCase()}
                                        {(c.dataFreshness.displayedSourceStaleMins ?? c.dataFreshness.asosStaleMins) !==
                                          null &&
                                          (c.dataFreshness.displayedSourceStaleMins ?? c.dataFreshness.asosStaleMins)! >
                                            10 && (
                                            <span className="text-red-400 ml-0.5">
                                              {c.dataFreshness.displayedSourceStaleMins ??
                                                c.dataFreshness.asosStaleMins}
                                              m
                                            </span>
                                          )}
                                      </span>
                                    )}
                                    {/* T-group precision warning — if T-group fetch failed, data is whole-°C only */}
                                    {c.dataFreshness && !c.dataFreshness.tgroupAvailable && (
                                      <span
                                        className="text-[8px] text-orange-400"
                                        title="T-group precision data unavailable — temperatures rounded to whole °C (±1.8°F). METAR body only."
                                      >
                                        ⚠ no T-grp
                                      </span>
                                    )}
                                    {/* WU-adjusted temp — applies -0.56°F bias for resolution prediction.
                                        Always anchored to ASOS HIGH (not current) — WU resolves on
                                        daily max, not the live reading. */}
                                    {c.unit === 'F' && c.asosHigh !== null && c.asosHigh !== undefined && (
                                      <span
                                        className="text-[10px] text-blue-400 font-medium"
                                        title="WU hourly max averages -0.56°F lower than true daily max. This is the predicted WU resolution value (anchored to ASOS high)."
                                      >
                                        WU~{(c.asosHigh - 0.56).toFixed(1)}°
                                      </span>
                                    )}
                                    {c.asosLastObsTime && (
                                      <span className="text-[8px] text-gray-600">
                                        @{c.asosLastObsTime.replace(/ [A-Z]{2,4}$/, '')}
                                      </span>
                                    )}
                                  </div>
                                )
                              })()}
                        </td>
                        {/* Now (current live temp) — StatusCell shows STATION_DELAYED with
                              last-known fallback instead of silent blank. v3.76.4 cache pass:
                              when currentTemp is null but runningHigh exists, show the running
                              high + STATION_DELAYED so operator still sees a real number. */}
                        <td className="py-3 pr-2 text-right text-sm font-mono text-yellow-400">
                          <StatusCell
                            cellType="metar_observation"
                            input={{
                              value: c.currentTemp,
                              unit: c.unit === 'F' ? 'F' : 'C',
                              lastObsTime: c.metarLastObsTime ?? c.asosLastObsTime ?? null,
                              stationIntervalMin:
                                typeof c.obsIntervalMin === 'number' && c.obsIntervalMin > 0
                                  ? c.obsIntervalMin
                                  : c.unit === 'F'
                                    ? 60 // US ASOS typical cadence
                                    : 30, // international METAR default
                              fallbackValue: c.runningHigh ?? c.metarCurrent ?? c.metarHigh ?? null,
                            }}
                            format={(v) => `${v.toFixed(2)}${unitLabel}`}
                          />
                        </td>
                        {/* Trend — icon only, tooltip for details */}
                        <td
                          className={`py-3 pr-2 text-center text-sm cursor-help ${c.isFadeLock ? 'text-amber-400' : trendColor}`}
                          title={
                            c.isFadeLock
                              ? `FADE LOCK — peak set ${c.hoursSincePeak.toFixed(1)}h ago, declining`
                              : c.trendLabel || ''
                          }
                        >
                          {c.isFadeLock ? '' : trendIcon}
                        </td>
                        <td className="py-3 pr-3">
                          {(() => {
                            const ds = c.dynamicSignal
                            const wr = ds ? ds.currentWR : (c.strategyWR ?? c.bestModelWR ?? 0)
                            // LOW confidence = calm blue (neutral), not red (alarming)
                            const confColor = ds
                              ? ds.confidence === 'HIGH'
                                ? { text: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30' }
                                : ds.confidence === 'MEDIUM'
                                  ? {
                                      text: 'text-yellow-400',
                                      bg: 'bg-yellow-500/10',
                                      border: 'border-yellow-500/30',
                                    }
                                  : { text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' }
                              : { text: 'text-cyan-400', bg: 'bg-cyan-500/10', border: '' }
                            // Softer WR thresholds — most WRs are 25-55%, avoid everything being red
                            const wrColor = wr >= 45 ? 'text-green-400' : wr >= 33 ? 'text-yellow-400' : 'text-red-400'
                            // Phase 02.17.19c: badge shows the SIGNAL'S actual WR (currentWR),
                            // which is the combo WR when models agree (higher) or solo best
                            // model WR when the best model overrides consensus. The label text
                            // indicates which case: "KNMI+GFS 56.8%" for 2-of-3 agreement,
                            // "MF 29%" for solo best model override.
                            // Phase 02.17.19e: badge must match the actual BET, not the consensus.
                            // - If best model IS in the agreeing set: consensus applies → "3-of-3 76.2%"
                            // - If best model is NOT in the agreeing set: override case → "ICON 24.2%"
                            //   (we're betting the solo model's bucket, not the consensus bucket)
                            // - Solo/tight cases: "GFS 33.0%"
                            const badgeLabel = ds
                              ? (() => {
                                  const agreeCount = ds.modelsAgreeing?.length ?? 0
                                  const bestInConsensus =
                                    agreeCount >= 2 &&
                                    ds.bestSingleModel &&
                                    ds.modelsAgreeing.includes(ds.bestSingleModel)
                                  if (ds.method === 'CONSENSUS' && bestInConsensus) {
                                    // True consensus — best model agrees with group. Show combo WR.
                                    const wrText = ds.currentWR ? `${ds.currentWR.toFixed(1)}%` : ''
                                    return `${agreeCount}-of-${agreeCount} ${wrText}`.trim()
                                  }
                                  // Best model override OR solo model OR tight spread — show solo WR
                                  const soloWR = ds.bestSingleWR ?? ds.currentWR ?? wr
                                  const wrText = soloWR ? `${soloWR.toFixed(1)}%` : ''
                                  return `${ds.bestSingleModel || c.bestModel || '—'} ${wrText}`.trim()
                                })()
                              : c.bestModel || '—'

                            // Build model forecast temperatures + run timing for tooltip
                            const modelTemps: Array<{
                              name: string
                              temp: number | null
                              isAgreeing: boolean
                              runInfo: ModelRunInfo
                              wrKey: string
                            }> = [
                              {
                                name: 'GFS',
                                temp: c.gfs,
                                isAgreeing: ds?.modelsAgreeing?.includes('GFS') ?? false,
                                runInfo: getModelRunInfo(
                                  'GFS',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'gfs',
                              },
                              {
                                name: 'ICON',
                                temp: c.icon,
                                isAgreeing: ds?.modelsAgreeing?.includes('ICON') ?? false,
                                runInfo: getModelRunInfo(
                                  'ICON',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'icon',
                              },
                              {
                                name: 'ECMWF',
                                temp: c.ecmwf,
                                isAgreeing: ds?.modelsAgreeing?.includes('ECMWF') ?? false,
                                runInfo: getModelRunInfo(
                                  'ECMWF',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'ecmwf',
                              },
                              {
                                name: 'GEM',
                                temp: c.gem,
                                isAgreeing: ds?.modelsAgreeing?.includes('GEM') ?? false,
                                runInfo: getModelRunInfo(
                                  'GEM',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'gem',
                              },
                              {
                                name: 'UKMO',
                                temp: c.ukmo ?? null,
                                isAgreeing: ds?.modelsAgreeing?.includes('UKMO') ?? false,
                                runInfo: getModelRunInfo(
                                  'UKMO',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'ukmo',
                              },
                              {
                                name: 'MF',
                                temp: c.meteofrance ?? null,
                                isAgreeing: ds?.modelsAgreeing?.includes('MF') ?? false,
                                runInfo: getModelRunInfo(
                                  'MF',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'meteofrance',
                              },
                              {
                                name: 'KNMI',
                                temp: c.knmi ?? null,
                                isAgreeing: ds?.modelsAgreeing?.includes('KNMI') ?? false,
                                runInfo: getModelRunInfo(
                                  'KNMI',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'knmi',
                              },
                              {
                                name: 'JMA',
                                temp: c.jma,
                                isAgreeing: ds?.modelsAgreeing?.includes('JMA') ?? false,
                                runInfo: getModelRunInfo(
                                  'JMA',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'jma',
                              },
                              {
                                name: 'CMA',
                                temp: c.cma ?? null,
                                isAgreeing: ds?.modelsAgreeing?.includes('CMA') ?? false,
                                runInfo: getModelRunInfo(
                                  'CMA',
                                  (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                    .perModelUpdatedAt,
                                ),
                                wrKey: 'cma',
                              },
                              // v3.83.1: new models from c.allModels
                              ...(() => {
                                const allM = (c as unknown as { allModels?: Record<string, number | null> }).allModels
                                if (!allM) return []
                                const newModels: Array<{ key: string; name: string }> = [
                                  { key: 'ecmwf_aifs', name: 'AIFS' },
                                  { key: 'gfs_hrrr', name: 'HRRR' },
                                  { key: 'gem_hrdps', name: 'HRDPS' },
                                  { key: 'metno', name: 'METNO' },
                                  { key: 'dmi', name: 'DMI' },
                                  { key: 'arpege_world', name: 'ARPW' },
                                  { key: 'jma_gsm', name: 'JGSM' },
                                  // v3.92.1: BOM + GraphCast (were pulled by cron but invisible in signal panel)
                                  { key: 'bom', name: 'BOM' },
                                  { key: 'graphcast', name: 'GCAST' },
                                  { key: 'arome_fr', name: 'AROME' },
                                  { key: 'arome_hd', name: 'AMHD' },
                                  { key: 'arpege_eu', name: 'ARPE' },
                                  { key: 'ukmo_2km', name: 'UK2k' },
                                  { key: 'icon_d2', name: 'ICD2' },
                                  { key: 'icon_eu', name: 'ICEU' },
                                  { key: 'harmonie_nl', name: 'HRNL' },
                                  { key: 'harmonie_eu', name: 'HREU' },
                                  { key: 'metno_nordic', name: 'NORD' },
                                ]
                                return newModels
                                  .filter((m) => typeof allM[m.key] === 'number')
                                  .map((m) => ({
                                    name: m.name,
                                    temp: allM[m.key]!,
                                    isAgreeing: ds?.modelsAgreeing?.includes(m.name) ?? false,
                                    runInfo: getModelRunInfo(
                                      m.name,
                                      (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                        .perModelUpdatedAt,
                                    ),
                                    wrKey: m.key,
                                  }))
                              })(),
                            ].filter((m) => m.temp !== null && m.temp !== undefined)

                            return (
                              <div className="flex flex-col items-start gap-0.5">
                                <HoverInfo
                                  content={
                                    ds ? (
                                      <div className="space-y-1.5 min-w-[320px] max-w-[360px]">
                                        <div className={`${confColor.text} font-bold border-b border-white/10 pb-1`}>
                                          {'●'}{' '}
                                          Signal: {ds.confidence}
                                        </div>
                                        <div className="text-white text-[11px]">{ds.label}</div>
                                        <div className="flex justify-between">
                                          <span className="text-gray-500">Win Rate:</span>
                                          <span className={`font-bold ${wrColor}`}>{ds.currentWR}%</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-gray-500">Bets/year:</span>
                                          <span className="text-white">{ds.betsPerYear}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-gray-500">Backtest:</span>
                                          <span
                                            className={`font-bold ${ds.nBets >= 50 ? 'text-emerald-400' : ds.nBets >= 25 ? 'text-yellow-400' : 'text-red-400'}`}
                                          >
                                            {ds.nBets} bets{' '}
                                            {ds.nBets >= 50 ? '(HIGH conf)' : ds.nBets >= 25 ? '(OK)' : '(LOW SAMPLE)'}
                                          </span>
                                        </div>
                                        {ds.agreedBucket && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Bet on:</span>
                                            <span className="text-white font-bold">
                                              {ds.agreedBucket.split('-')[0]}
                                            </span>
                                          </div>
                                        )}
                                        {isUnifiedPreview && (
                                          <UnifiedEngineBadge
                                            jp={c.jarvisPrediction}
                                            unitLabel={unitLabel}
                                            variant="popup"
                                          />
                                        )}
                                        {/* v3.76.1: Actionable 3-state decision. Tells trader SIZE / HALF / SKIP
                                              instead of ambiguous "coin flip" / "safe bucket" labels. Rules:
                                              - FULL SIZE: WR >= 55% AND decimals firm AND spread <= 3°
                                              - HALF SIZE: WR 50-55% OR any borderline decimal OR spread 3-5°
                                              - SKIP:      WR < 50% OR spread > 5° OR 2+ borderline models */}
                                        {(() => {
                                          if (!ds.agreedBucket || !ds.modelsAgreeing?.length) return null
                                          const modelValsForCheck: number[] = []
                                          for (const m of ds.modelsAgreeing) {
                                            const key = m.toLowerCase()
                                            const lookup: Record<string, number | null | undefined> = {
                                              gfs: c.gfs,
                                              ecmwf: c.ecmwf,
                                              icon: c.icon,
                                              gem: c.gem,
                                              jma: c.jma,
                                              ukmo: c.ukmo,
                                              mf: c.meteofrance,
                                              meteofrance: c.meteofrance,
                                              knmi: c.knmi,
                                              cma: c.cma,
                                            }
                                            const v = lookup[key]
                                            if (v !== null && v !== undefined) modelValsForCheck.push(v)
                                          }
                                          if (modelValsForCheck.length === 0) return null
                                          const borderlineCount = modelValsForCheck.filter((v) => {
                                            const dec = Math.abs(v - Math.floor(v))
                                            return dec >= 0.3 && dec <= 0.7
                                          }).length
                                          const spread = c.spread ?? 0
                                          // v3.76.6: removed "WR < 50% = SKIP" — break-even depends on YES price,
                                          // not a fixed 50% threshold. A 30% WR bucket with YES @ $0.05 is a great
                                          // snipe; a 70% WR bucket with YES @ $0.75 is a bad trade. The real
                                          // price-vs-WR edge analysis lives in Bucket Sniper per-bucket.
                                          // Here we only flag RISK signals that apply regardless of price:
                                          // borderline decimals + wide model spread.
                                          let action: 'FULL' | 'HALF' | 'SKIP'
                                          let reason: string
                                          if (spread > 5 || borderlineCount >= 2) {
                                            action = 'SKIP'
                                            reason =
                                              spread > 5
                                                ? `model spread ${spread.toFixed(1)}° — too uncertain for any bucket`
                                                : `${borderlineCount} models near bucket edge — could flip outcome`
                                          } else if (borderlineCount >= 1 || spread > 3) {
                                            action = 'HALF'
                                            reason =
                                              borderlineCount >= 1
                                                ? `${borderlineCount} model near edge — consider next bucket over too`
                                                : `spread ${spread.toFixed(1)}° — some model disagreement`
                                          } else {
                                            action = 'FULL'
                                            reason = `models firmly in ${ds.agreedBucket} bucket, spread ${spread.toFixed(1)}° — check Bucket Sniper for price edge`
                                          }
                                          const styles = {
                                            FULL: {
                                              box: 'bg-emerald-500/15 border-emerald-500/60',
                                              label: 'text-emerald-300',
                                              body: 'text-emerald-200/90',
                                              title: 'FULL SIZE',
                                              icon: '●',
                                            },
                                            HALF: {
                                              box: 'bg-amber-500/20 border-amber-500/60',
                                              label: 'text-amber-300',
                                              body: 'text-amber-200/90',
                                              title: 'HALF SIZE',
                                              icon: '◐',
                                            },
                                            SKIP: {
                                              box: 'bg-red-500/25 border-red-500/60',
                                              label: 'text-red-300',
                                              body: 'text-red-200/90',
                                              title: 'SKIP',
                                              icon: '✕',
                                            },
                                          }[action]
                                          return (
                                            <div
                                              className={`mt-2 flex items-center gap-2 px-2 py-1.5 rounded border ${styles.box}`}
                                            >
                                              <span className={`${styles.label} text-sm font-bold`}>
                                                {styles.icon} {styles.title}
                                              </span>
                                              <span className={`${styles.body} text-[11px]`}>{reason}</span>
                                            </div>
                                          )
                                        })()}
                                        {/* V2: Show bias correction + hold rate + seasonal WR */}
                                        {ds.biasCorrection > 0 && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Bias corrected:</span>
                                            <span className="text-cyan-400">
                                              {ds.biasCorrection.toFixed(2)}° avg adjustment
                                            </span>
                                          </div>
                                        )}
                                        {/* V3: Monthly WR with MoM comparison */}
                                        {ds.monthlyWR !== null && ds.monthlyWR !== undefined && ds.monthlyWRMonth && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">{ds.monthlyWRMonth} WR:</span>
                                            <span
                                              className={`font-bold ${
                                                ds.monthlyWR >= ds.currentWR
                                                  ? 'text-emerald-400'
                                                  : ds.monthlyWR >= ds.currentWR * 0.75
                                                    ? 'text-yellow-400'
                                                    : 'text-red-400'
                                              }`}
                                            >
                                              {ds.monthlyWR.toFixed(1)}%
                                              {ds.prevMonthWR !== null && ds.prevMonthWR !== undefined
                                                ? ` ${ds.monthlyWR >= ds.prevMonthWR ? '▲' : '▼'}${Math.abs(ds.monthlyWR - ds.prevMonthWR).toFixed(0)}% vs ${ds.prevMonthName}`
                                                : ds.monthlyWR >= ds.currentWR
                                                  ? ' ▲'
                                                  : ' ▼'}
                                            </span>
                                          </div>
                                        )}
                                        {ds.seasonalWR > 0 && ds.seasonalWR !== ds.currentWR && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Overall WR (730d):</span>
                                            <span
                                              className={
                                                ds.seasonalWR > ds.currentWR ? 'text-emerald-400' : 'text-yellow-400'
                                              }
                                            >
                                              {ds.seasonalWR.toFixed(1)}%
                                            </span>
                                          </div>
                                        )}
                                        {/* Phase 02.21: REAL seasonal WR from ASOS 730d backtest sliced by season */}
                                        {ds.seasonalWRAsos !== null && ds.seasonalWRAsos !== undefined && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Season WR ({ds.holdRateSeason}):</span>
                                            <span
                                              className={`font-semibold ${
                                                ds.seasonalWRAsosN < 90 ? 'text-gray-500' : 'text-cyan-300'
                                              }`}
                                            >
                                              {ds.seasonalWRAsos.toFixed(1)}%
                                              <span className="text-gray-500 font-normal ml-1">
                                                n={ds.seasonalWRAsosN}
                                                {ds.seasonalWRAsosN < 90 && ' LOW'}
                                              </span>
                                            </span>
                                          </div>
                                        )}
                                        {/* Phase 02.21: REAL monthly WR (may duplicate monthlyWR above, but sourced
                                            from the new monthly_wr_asos field — which is trustworthy). Only render
                                            if the legacy monthlyWR is absent to avoid two conflicting rows. */}
                                        {(ds.monthlyWR === null || ds.monthlyWR === undefined) &&
                                          ds.monthlyWRAsos !== null &&
                                          ds.monthlyWRAsos !== undefined && (
                                            <div className="flex justify-between">
                                              <span className="text-gray-500">{ds.monthlyWRMonth || 'Month'} WR:</span>
                                              <span
                                                className={`font-semibold ${
                                                  ds.monthlyWRAsosN < 30 ? 'text-gray-500' : 'text-emerald-300'
                                                }`}
                                              >
                                                {ds.monthlyWRAsos.toFixed(1)}%
                                                <span className="text-gray-500 font-normal ml-1">
                                                  n={ds.monthlyWRAsosN}
                                                  {ds.monthlyWRAsosN < 30 && ' LOW'}
                                                </span>
                                              </span>
                                            </div>
                                          )}
                                        {ds.holdRate > 0 && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Hold rate now:</span>
                                            <span
                                              className={
                                                ds.holdRate >= 80
                                                  ? 'text-emerald-400'
                                                  : ds.holdRate >= 50
                                                    ? 'text-yellow-400'
                                                    : 'text-red-400'
                                              }
                                            >
                                              {ds.holdRate.toFixed(0)}%
                                              {ds.holdRateHour !== null && (
                                                <span className="text-gray-500 font-normal ml-1">
                                                  @ {String(ds.holdRateHour).padStart(2, '0')}:00 local
                                                </span>
                                              )}
                                            </span>
                                          </div>
                                        )}
                                        {ds.compositeConfidence > 0 && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Composite:</span>
                                            <span
                                              className={`font-bold ${ds.compositeConfidence >= 60 ? 'text-emerald-400' : ds.compositeConfidence >= 40 ? 'text-yellow-400' : 'text-gray-400'}`}
                                            >
                                              {ds.compositeConfidence}/100
                                            </span>
                                          </div>
                                        )}
                                        {/* Model forecast temperatures + run times — the key actionable data */}
                                        <div className="border-t border-white/10 pt-1.5">
                                          <div className="text-cyan-400 text-[10px] font-bold mb-1">
                                            Model Forecasts &amp; Run Times
                                            {c.city === 'hong-kong' && (
                                              <span className="text-amber-400 font-normal ml-1">
                                                (HKO-adjusted -0.46°)
                                              </span>
                                            )}
                                          </div>
                                          <div className="space-y-0.5">
                                            {modelTemps.map((m) => {
                                              const freshColor =
                                                m.runInfo.freshness === 'fresh'
                                                  ? 'text-green-500'
                                                  : m.runInfo.freshness === 'aging'
                                                    ? 'text-yellow-600'
                                                    : 'text-red-500'
                                              const mWr = c.perModelWinRates?.[m.wrKey]
                                              const mWrColor =
                                                mWr !== undefined
                                                  ? mWr >= 35
                                                    ? 'text-green-400'
                                                    : mWr >= 25
                                                      ? 'text-yellow-500'
                                                      : 'text-gray-500'
                                                  : 'text-gray-600'
                                              return (
                                                <div key={m.name} className="flex items-center text-[11px] gap-1.5">
                                                  <span
                                                    className={`w-[42px] flex-shrink-0 ${m.isAgreeing ? 'text-green-400 font-bold' : 'text-gray-400'}`}
                                                  >
                                                    {m.name}
                                                    {m.isAgreeing ? '✓' : ''}
                                                  </span>
                                                  <span
                                                    className={`w-[50px] flex-shrink-0 text-right ${m.isAgreeing ? 'text-white font-bold' : 'text-gray-300'}`}
                                                  >
                                                    {m.temp}
                                                    {unitLabel}
                                                  </span>
                                                  <span
                                                    className={`w-[36px] flex-shrink-0 text-right text-[10px] font-bold ${mWrColor}`}
                                                  >
                                                    {mWr !== undefined ? `${mWr.toFixed(0)}%` : '--'}
                                                  </span>
                                                  <span className={`text-[9px] ${freshColor}`}>
                                                    {m.runInfo.lastRunZ}
                                                  </span>
                                                  <span className="text-[9px] text-gray-600">
                                                    next in {m.runInfo.nextAvailIn}
                                                  </span>
                                                </div>
                                              )
                                            })}
                                          </div>
                                          {c.ensemble && (
                                            <div className="flex justify-between text-[11px] mt-1 pt-1 border-t border-white/5">
                                              <span className="text-cyan-400 font-bold">Ensemble</span>
                                              <span className="text-white font-bold">
                                                {c.ensemble}
                                                {unitLabel}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                        {ds.consensusWR !== null && ds.consensusWR !== ds.currentWR && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Consensus WR:</span>
                                            <span className="text-green-400">{ds.consensusWR}%</span>
                                          </div>
                                        )}
                                        <div className="border-t border-white/10 pt-1">
                                          <span className="text-gray-500">Best single:</span>{' '}
                                          <span className="text-white">
                                            {ds.bestSingleModel} ({ds.bestSingleWR}%)
                                          </span>
                                        </div>
                                        <div className="text-[10px] text-gray-600 pt-1">
                                          Data fetched {isoTimeAgo(ds.signalAge)}
                                        </div>
                                        {/* Model change alerts inside tooltip */}
                                        {c.modelChanges && c.modelChanges.length > 0 && (
                                          <div className="border-t border-white/10 pt-1 mt-1 space-y-0.5">
                                            <div className="text-orange-400 text-[10px] font-bold">Recent changes:</div>
                                            {c.modelChanges.slice(0, 3).map((mc, i) => (
                                              <div
                                                key={i}
                                                className={`text-[10px] ${mc.bucketChanged ? 'text-red-400' : 'text-yellow-500/70'}`}
                                              >
                                                {mc.model}: {mc.oldValue}&rarr;{mc.newValue}
                                                {unitLabel}
                                                {mc.bucketChanged ? ' (bucket!)' : ''} — {isoTimeAgo(mc.detectedAt)}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <div className="space-y-1.5 min-w-[320px] max-w-[360px]">
                                        <div className="text-cyan-400 font-bold border-b border-white/10 pb-1">
                                          {c.strategyName
                                            ? 'Best Strategy (2yr backtest)'
                                            : c.bestModel || 'Model Info'}
                                        </div>
                                        {c.strategyName && (
                                          <>
                                            <div>
                                              <span className="text-gray-500">Strategy:</span>{' '}
                                              <span className="text-white">{c.strategyName}</span>
                                            </div>
                                            <div>
                                              <span className="text-gray-500">Win Rate:</span>{' '}
                                              <span className={`font-bold ${wrColor}`}>{c.strategyWR}%</span>{' '}
                                              <span className="text-gray-600">(730 days)</span>
                                            </div>
                                            {c.betsPerYear && (
                                              <div>
                                                <span className="text-gray-500">Bets/year:</span>{' '}
                                                <span className="text-white">{c.betsPerYear}</span>
                                              </div>
                                            )}
                                          </>
                                        )}
                                        {/* Model forecasts + run times for static fallback too */}
                                        <div className="border-t border-white/10 pt-1.5">
                                          <div className="text-cyan-400 text-[10px] font-bold mb-1">
                                            Model Forecasts &amp; Run Times
                                          </div>
                                          <div className="space-y-0.5">
                                            {modelTemps.map((m) => {
                                              const lc = c.modelLastChanged?.[m.name]
                                              const detectedAgo = lc
                                                ? Math.round((Date.now() - new Date(lc.at).getTime()) / 60000)
                                                : null
                                              const detectedColor =
                                                detectedAgo !== null
                                                  ? detectedAgo < 30
                                                    ? 'text-green-400'
                                                    : detectedAgo < 120
                                                      ? 'text-yellow-500'
                                                      : 'text-gray-500'
                                                  : ''
                                              const freshColor =
                                                m.runInfo.freshness === 'fresh'
                                                  ? 'text-green-500'
                                                  : m.runInfo.freshness === 'aging'
                                                    ? 'text-yellow-600'
                                                    : 'text-red-500'
                                              const fbWr = c.perModelWinRates?.[m.wrKey]
                                              const fbWrColor =
                                                fbWr !== undefined
                                                  ? fbWr >= 35
                                                    ? 'text-green-400'
                                                    : fbWr >= 25
                                                      ? 'text-yellow-500'
                                                      : 'text-gray-500'
                                                  : 'text-gray-600'
                                              return (
                                                <div key={m.name} className="flex items-center text-[11px] gap-1.5">
                                                  <span className="w-[42px] flex-shrink-0 text-gray-400">{m.name}</span>
                                                  <span className="w-[50px] flex-shrink-0 text-right text-gray-300">
                                                    {m.temp}
                                                    {unitLabel}
                                                  </span>
                                                  <span
                                                    className={`w-[36px] flex-shrink-0 text-right text-[10px] font-bold ${fbWrColor}`}
                                                  >
                                                    {fbWr !== undefined ? `${fbWr.toFixed(0)}%` : '--'}
                                                  </span>
                                                  {lc ? (
                                                    <>
                                                      <span className={`text-[9px] ${detectedColor}`}>
                                                        tracked{' '}
                                                        {detectedAgo! < 60
                                                          ? `${detectedAgo}m`
                                                          : `${Math.round(detectedAgo! / 60)}h`}{' '}
                                                        ago
                                                      </span>
                                                      {lc.oldValue !== lc.newValue && (
                                                        <span className="text-[9px] text-orange-400/70">
                                                          was {lc.oldValue.toFixed(1)}
                                                        </span>
                                                      )}
                                                      <span className={`text-[9px] ${freshColor}`}>
                                                        {m.runInfo.lastRunZ}
                                                      </span>
                                                    </>
                                                  ) : (
                                                    <>
                                                      <span className={`text-[9px] ${freshColor}`}>
                                                        {m.runInfo.lastRunZ}
                                                      </span>
                                                      <span className="text-[9px] text-gray-600">
                                                        next in {m.runInfo.nextAvailIn}
                                                      </span>
                                                    </>
                                                  )}
                                                </div>
                                              )
                                            })}
                                          </div>
                                          {c.ensemble && (
                                            <div className="flex justify-between text-[11px] mt-1 pt-1 border-t border-white/5">
                                              <span className="text-cyan-400 font-bold">Ensemble</span>
                                              <span className="text-white font-bold">
                                                {c.ensemble}
                                                {unitLabel}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                        {c.bestModel && (
                                          <div className="border-t border-white/10 pt-1 space-y-0.5">
                                            {/* v3.99.80 — surface todayApplicable when combo isn't firing */}
                                            {c.todayApplicableModel &&
                                            c.todayApplicableWR !== null &&
                                            c.todayApplicableWR !== undefined ? (
                                              <>
                                                <div>
                                                  <span className="text-gray-500">Today-applicable:</span>{' '}
                                                  <span className="text-white font-semibold">
                                                    {c.todayApplicableModel} ({c.todayApplicableWR}%)
                                                  </span>
                                                </div>
                                                {c.comboStatus &&
                                                  c.comboStatus !== 'FIRING' &&
                                                  c.comboStatus !== 'NO_COMBO' &&
                                                  c.comboHistoricalWR !== null &&
                                                  c.comboHistoricalWR !== undefined && (
                                                    <div className="text-[10px]">
                                                      <span className="text-gray-500">Combo historical:</span>{' '}
                                                      <span className="text-amber-300">
                                                        {c.bestModel} ({c.comboHistoricalWR}%) — {c.comboStatus}
                                                        {c.comboStatus === 'PENDING' &&
                                                        c.pendingModels &&
                                                        c.pendingModels.length > 0
                                                          ? ` (awaiting ${c.pendingModels.join(', ')})`
                                                          : ''}
                                                      </span>
                                                    </div>
                                                  )}
                                              </>
                                            ) : (
                                              <div>
                                                <span className="text-gray-500">Best single model:</span>{' '}
                                                <span className="text-white">
                                                  {c.bestModel} ({c.bestModelWR}%)
                                                </span>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )
                                  }
                                >
                                  <div
                                    className={`text-xs font-bold ${wrColor} ${confColor.bg} px-2 py-1 rounded cursor-help ${confColor.border ? `border ${confColor.border}` : ''}`}
                                  >
                                    {badgeLabel}
                                  </div>
                                </HoverInfo>
                                {/* Model change micro-alerts */}
                                {c.modelChanges && c.modelChanges.length > 0 && (
                                  <div className="flex flex-col gap-0.5 mt-0.5">
                                    {c.modelChanges.slice(0, 3).map((mc, i) => (
                                      <div
                                        key={i}
                                        className={`text-[9px] font-mono leading-tight ${mc.bucketChanged ? 'text-red-400' : 'text-yellow-500/60'}`}
                                      >
                                        {mc.model}: {mc.oldValue}&rarr;{mc.newValue}
                                        {mc.bucketChanged ? '!' : ''}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* Signal prominence — how many models changed recently */}
                                {(() => {
                                  const mlc = c.modelLastChanged
                                  if (!mlc) return null
                                  const recentCount = Object.values(mlc).filter(
                                    (v) => Date.now() - new Date(v.at).getTime() < 2 * 60 * 60 * 1000,
                                  ).length
                                  if (recentCount === 0) return null
                                  return (
                                    <div
                                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5 ${
                                        recentCount >= 3
                                          ? 'bg-green-500/20 text-green-400'
                                          : recentCount >= 2
                                            ? 'bg-yellow-500/15 text-yellow-500'
                                            : 'bg-gray-500/10 text-gray-500'
                                      }`}
                                    >
                                      {recentCount} model{recentCount > 1 ? 's' : ''} updated
                                    </div>
                                  )
                                })()}
                                {/* Signal freshness — show which run is active for top model */}
                                {ds && (
                                  <div className="text-[9px] text-gray-600 leading-tight">
                                    {(() => {
                                      const topModel = ds.bestSingleModel || 'GFS'
                                      const ri = getModelRunInfo(
                                        topModel,
                                        (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                          .perModelUpdatedAt,
                                      )
                                      const freshColor =
                                        ri.freshness === 'fresh'
                                          ? 'text-green-600'
                                          : ri.freshness === 'aging'
                                            ? 'text-yellow-600'
                                            : 'text-red-500'
                                      return (
                                        <span className={freshColor}>
                                          {topModel} {ri.lastRunZ} · next in {ri.nextAvailIn}
                                        </span>
                                      )
                                    })()}
                                  </div>
                                )}
                                {/* Combined-signal strategy: 730-day combo backtest WR. Green when the
                                    member models agree today (firing); muted while pending/disagreement. */}
                                {(() => {
                                  const cc = c as unknown as {
                                    strategyWR?: number | null
                                    bestCombo?: string | null
                                    strategyName?: string | null
                                    comboStatus?: string | null
                                    comboFiringToday?: boolean | null
                                    strategyContaminated?: boolean | null
                                    comboDays?: number | null
                                  }
                                  if (typeof cc.strategyWR !== 'number' || cc.strategyWR <= 0 || cc.strategyContaminated)
                                    return null
                                  // Significance gate: only surface a combo whose 95% Wilson CI lower
                                  // bound clears 50% given its actual fire-day sample. Combos fire on a
                                  // fraction of days, so small-n outliers never reach the table.
                                  const n = cc.comboDays ?? 0
                                  if (n < 30) return null
                                  const hits = Math.round((cc.strategyWR / 100) * n)
                                  const ci = wilsonCI(hits, n)
                                  if (ci.lo <= 50) return null
                                  const label = (cc.bestCombo ?? cc.strategyName ?? 'combo').toString()
                                  const firing = !!cc.comboFiringToday
                                  return (
                                    <div
                                      className={`text-[10px] mt-0.5 truncate max-w-[190px] ${firing ? 'text-emerald-400 font-semibold' : 'text-gray-500'}`}
                                      title={`Combined signal: when the models ${label} agree on the same bucket, the stacked call hit ${cc.strategyWR.toFixed(1)}% over ${n.toLocaleString('en-US')} fire-days in the 730-day combo backtest (95% CI [${ci.lo.toFixed(1)}%, ${ci.hi.toFixed(1)}%], ASOS-proxy, watchlist only). Combos with a CI lower bound at or below 50% are hidden. ${firing ? 'FIRING: members agree today.' : `Not firing today: ${(cc.comboStatus ?? 'pending').toLowerCase()}.`}`}
                                    >
                                      COMBO {label} {cc.strategyWR.toFixed(1)}% (n={n}, proxy) · {firing ? 'FIRING' : (cc.comboStatus ?? 'PENDING').toLowerCase()}
                                    </div>
                                  )
                                })()}
                              </div>
                            )
                          })()}
                        </td>
                        {/* FADE LOCK data columns */}
                        <td className="py-3 pr-3 text-center text-xs font-mono">
                          {c.fadeLockData ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-amber-400 font-bold">{c.fadeLockData.peakHour}</span>
                              <span className="text-[10px] text-gray-500">{c.fadeLockData.window12to5Pct}% 12-5</span>
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        {/* Lock % — merged 1h / 2h / @3PM into single column */}
                        <td
                          className="py-3 pr-3 text-center text-xs font-mono cursor-help"
                          title={
                            c.fadeLockData
                              ? `1h Hold: ${c.fadeLockData.fade1hHeldPct}%\n2h Hold: ${c.fadeLockData.fade2hHeldPct}%\n3h Hold: ${c.fadeLockData.fade3hHeldPct}%${
                                  c.hourlyHoldRates ? `\n@3PM: ${c.hourlyHoldRates['15'] ?? '—'}%` : ''
                                }`
                              : c.hourlyHoldRates
                                ? `@3PM: ${c.hourlyHoldRates['15'] ?? '—'}%`
                                : 'No hold data'
                          }
                        >
                          {(() => {
                            const pct3pm = c.hourlyHoldRates?.['15'] ?? null
                            if (pct3pm === null) return <span className="text-gray-600">—</span>
                            const num = typeof pct3pm === 'number' ? pct3pm : parseFloat(String(pct3pm))
                            return (
                              <span
                                className={`font-bold ${
                                  num >= 90 ? 'text-green-400' : num >= 80 ? 'text-yellow-400' : 'text-red-400'
                                }`}
                              >
                                {pct3pm}%
                              </span>
                            )
                          })()}
                        </td>
                        {/* @3PM data now merged into Lock % column above */}
                        <td className="py-3 pr-3 text-right">
                          <HoverInfo
                            content={
                              <div className="space-y-1">
                                <div className="text-cyan-400 font-bold border-b border-white/10 pb-1">
                                  Model Predictions (Today)
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-yellow-400">Ensemble:</span>{' '}
                                  <span className="text-white font-bold">
                                    {c.ensemble !== null ? c.ensemble.toFixed(1) + unitLabel : '—'}
                                  </span>
                                </div>
                                <div className="border-t border-white/5 my-1" />
                                {(() => {
                                  // v3.92.1: Model Predictions hover now enumerates ALL 18 globals
                                  // (was hardcoded 9). Was silently dropping ECMWF+GFS too on some
                                  // render paths because legacy fields alternated between null and
                                  // c.allModels lookup. Now uses a single source: legacy fields
                                  // preferred for the 9 ground-truth globals, then allModels spread
                                  // for the 9 newer globals + regionals.
                                  const allM = (c as unknown as { allModels?: Record<string, number | null> }).allModels
                                  const mv = (short: string, legacy: number | null | undefined): number | null =>
                                    (allM?.[short] ?? legacy ?? null) as number | null
                                  const ALL_MODELS: Array<{ name: string; val: number | null }> = [
                                    // 9 ground-truth globals (legacy-field preferred)
                                    { name: 'ECMWF', val: mv('ecmwf', c.ecmwf) },
                                    { name: 'GFS', val: mv('gfs', c.gfs) },
                                    { name: 'ICON', val: mv('icon', c.icon) },
                                    { name: 'GEM', val: mv('gem', c.gem) },
                                    { name: 'JMA', val: mv('jma', c.jma) },
                                    { name: 'UKMO', val: mv('ukmo', c.ukmo) },
                                    { name: 'MF', val: mv('meteofrance', c.meteofrance) },
                                    { name: 'KNMI', val: mv('knmi', c.knmi) },
                                    { name: 'CMA', val: mv('cma', c.cma) },
                                    // 7 new v3.79 globals
                                    { name: 'HRRR', val: mv('gfs_hrrr', null) },
                                    { name: 'AIFS', val: mv('ecmwf_aifs', null) },
                                    { name: 'HRDPS', val: mv('gem_hrdps', null) },
                                    { name: 'METNO', val: mv('metno', null) },
                                    { name: 'DMI', val: mv('dmi', null) },
                                    { name: 'ARPW', val: mv('arpege_world', null) },
                                    { name: 'JGSM', val: mv('jma_gsm', null) },
                                    // 2 new v3.92 globals (BOM + GraphCast)
                                    { name: 'BOM', val: mv('bom', null) },
                                    { name: 'GCAST', val: mv('graphcast', null) },
                                  ]
                                  return ALL_MODELS
                                })().map((m) => {
                                  const lc = c.modelLastChanged?.[m.name]
                                  const minsAgo = lc
                                    ? Math.round((Date.now() - new Date(lc.at).getTime()) / 60000)
                                    : null
                                  const changeColor =
                                    minsAgo !== null
                                      ? minsAgo < 30
                                        ? 'text-green-400'
                                        : minsAgo < 120
                                          ? 'text-yellow-500'
                                          : 'text-gray-500'
                                      : ''
                                  // v3.99.14: DB-backed fallback for change history. The in-memory
                                  // _modelLastChanged map only tracked 16 core models — regional
                                  // variants like AROME / UK2k / ICEU showed no change indicator.
                                  // Supabase forecast_current has prev+delta for every model the
                                  // cron writes, so we fall back to that when lc is absent.
                                  const cCast = c as unknown as {
                                    perModelPrev?: Record<string, number>
                                    perModelDelta?: Record<string, number>
                                    perModelUpdatedAt?: Record<string, string>
                                  }
                                  const short = DISPLAY_TO_SHORT_KEY[m.name]
                                  const dbPrev = short ? cCast.perModelPrev?.[short] : undefined
                                  const dbDelta = short ? cCast.perModelDelta?.[short] : undefined
                                  const dbUpdatedAt = short ? cCast.perModelUpdatedAt?.[short] : undefined
                                  const dbMinsAgo = dbUpdatedAt
                                    ? Math.round((Date.now() - Date.parse(dbUpdatedAt)) / 60000)
                                    : null
                                  const dbChangeColor =
                                    dbMinsAgo !== null
                                      ? dbMinsAgo < 30
                                        ? 'text-green-400'
                                        : dbMinsAgo < 120
                                          ? 'text-yellow-500'
                                          : 'text-gray-500'
                                      : ''
                                  const showDbChange =
                                    !lc && dbPrev !== undefined && dbDelta !== undefined && dbDelta !== 0
                                  return (
                                    <div key={m.name} className="flex justify-between items-center">
                                      <span className="text-gray-500">{m.name}:</span>
                                      <span className="flex items-center gap-1.5">
                                        <span
                                          className={
                                            m.val !== null && m.val !== undefined ? 'text-white' : 'text-gray-600'
                                          }
                                        >
                                          {m.val !== null && m.val !== undefined
                                            ? m.val.toFixed(1) + unitLabel
                                            : (regionGateLabel(m.name, c.city) ?? '—')}
                                        </span>
                                        {lc && lc.oldValue !== lc.newValue && (
                                          <span className={`text-[9px] ${changeColor}`}>
                                            {minsAgo! < 60 ? `${minsAgo}m` : `${Math.round(minsAgo! / 60)}h`}
                                            <span className="text-orange-400/70 ml-0.5">
                                              (was {lc.oldValue.toFixed(1)})
                                            </span>
                                          </span>
                                        )}
                                        {showDbChange && (
                                          <span className={`text-[9px] ${dbChangeColor}`}>
                                            {dbMinsAgo !== null && dbMinsAgo < 60
                                              ? `${dbMinsAgo}m`
                                              : dbMinsAgo !== null
                                                ? `${Math.round(dbMinsAgo / 60)}h`
                                                : ''}
                                            <span className="text-orange-400/70 ml-0.5">
                                              (was {dbPrev!.toFixed(1)})
                                            </span>
                                          </span>
                                        )}
                                      </span>
                                    </div>
                                  )
                                })}
                                <div className="border-t border-white/5 my-1" />
                                <div className="flex justify-between">
                                  <span className="text-gray-500">Spread:</span>
                                  <span
                                    className={
                                      c.spread !== null && c.spread > 4 ? 'text-red-400 font-bold' : 'text-gray-300'
                                    }
                                  >
                                    {c.spread !== null ? c.spread.toFixed(1) + '°' : '—'}
                                    {c.spread !== null && c.spread > 4 ? ' (wide)' : ''}
                                  </span>
                                </div>
                                {c.strategyName && (
                                  <div className="border-t border-white/5 pt-1 mt-1">
                                    <span className="text-gray-500">Strategy:</span>{' '}
                                    <span className="text-cyan-400">
                                      {c.strategyName} ({c.strategyWR}% WR)
                                    </span>
                                  </div>
                                )}
                                {/* v3.99.29 — explicit contamination banner so a blank strategy
                                    doesn't look like a data gap. Reflects the route.ts gate in
                                    v3.99.28 (strategyContaminated=true when BEST_MODELS[city]
                                    .bestCombo contains an audit-PURE_FALLBACK model). */}
                                {(c as unknown as { strategyContaminated?: boolean }).strategyContaminated && (
                                  <div className="border-t border-red-500/40 pt-1 mt-1">
                                    <span className="text-red-400 font-bold text-[10px] uppercase">
                                      Strategy suppressed
                                    </span>
                                    <div className="text-red-300/80 text-[10px] mt-0.5">
                                      v1 combo contains phantom-fallback model. WR + maxBuyPrice invalid for this city.
                                      Use methodology page.
                                    </div>
                                  </div>
                                )}
                              </div>
                            }
                          >
                            <div className="text-sm font-mono text-white font-bold cursor-help text-right">
                              {c.ensemble !== null ? `${c.ensemble.toFixed(1)}${unitLabel}` : '—'}
                              {c.spread !== null && (
                                <span className={`ml-1 text-[10px] ${c.spread > 4 ? 'text-red-400' : 'text-gray-500'}`}>
                                  ±{(c.spread / 2).toFixed(1)}
                                </span>
                              )}
                            </div>
                          </HoverInfo>
                        </td>
                        {/* AI Prediction Engine v2 */}
                        <td className="py-3 pr-3 text-right">
                          {c.jarvisPrediction ? (
                            <HoverInfo
                              content={
                                <div className="space-y-1.5 min-w-[220px]">
                                  <div className="text-purple-400 font-bold border-b border-white/10 pb-1">
                                    JARVIS Prediction v2
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-500">Method:</span>
                                    <span
                                      className={`font-bold ${
                                        c.jarvisPrediction.method === 'CONFIRMED'
                                          ? 'text-green-400'
                                          : c.jarvisPrediction.method === 'TRAJECTORY'
                                            ? 'text-blue-400'
                                            : c.jarvisPrediction.method === 'BLEND'
                                              ? 'text-purple-400'
                                              : 'text-gray-400'
                                      }`}
                                    >
                                      {c.jarvisPrediction.method}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-500">Confidence:</span>
                                    <span
                                      className={`font-bold ${
                                        c.jarvisPrediction.confidence >= 70
                                          ? 'text-green-400'
                                          : c.jarvisPrediction.confidence >= 40
                                            ? 'text-yellow-400'
                                            : 'text-red-400'
                                      }`}
                                    >
                                      {c.jarvisPrediction.confidence}%
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-gray-500">Std Dev:</span>
                                    <span className="text-gray-300">
                                      ±{c.jarvisPrediction.standardDeviation.toFixed(1)}
                                      {unitLabel}
                                    </span>
                                  </div>
                                  {c.jarvisPrediction.climatologyPeakHour !== undefined && (
                                    <div className="flex justify-between">
                                      <span className="text-gray-500">Climatology peak:</span>
                                      <span className="text-amber-300 font-bold">
                                        {(() => {
                                          const h = c.jarvisPrediction!.climatologyPeakHour!
                                          const ampm = h >= 12 ? 'PM' : 'AM'
                                          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
                                          return `${h12} ${ampm} local (h${h})`
                                        })()}
                                      </span>
                                    </div>
                                  )}
                                  <div className="border-t border-white/10 pt-1 mt-1">
                                    <div className="text-[10px] text-gray-500 mb-1">Adjustment Waterfall:</div>
                                    {[
                                      {
                                        label: 'Ensemble',
                                        val: c.jarvisPrediction.adjustments.ensembleRaw,
                                        isBase: true,
                                      },
                                      { label: 'Bias', val: c.jarvisPrediction.adjustments.biasCorrection },
                                      { label: 'Conditions', val: c.jarvisPrediction.adjustments.conditionBias },
                                      { label: 'Wind', val: c.jarvisPrediction.adjustments.windAdj },
                                      { label: 'Pressure', val: c.jarvisPrediction.adjustments.pressureAdj },
                                      { label: 'Humidity', val: c.jarvisPrediction.adjustments.humidityAdj },
                                      // Trajectory only shown when method actually uses it (TRAJECTORY or BLEND).
                                      // In CONFIRMED/ENSEMBLE modes the engine does NOT apply trajectoryAdj to the
                                      // final prediction, so showing it in the waterfall is misleading and caused
                                      // the v3.9 Phase 0 bug report (pre-dawn Lucknow showing Trajectory: -11.40°).
                                      ...(c.jarvisPrediction.method === 'TRAJECTORY' ||
                                      c.jarvisPrediction.method === 'BLEND'
                                        ? [{ label: 'Trajectory', val: c.jarvisPrediction.adjustments.trajectoryAdj }]
                                        : []),
                                      { label: 'Market', val: c.jarvisPrediction.adjustments.marketSignal },
                                      { label: 'V1 Floor', val: c.jarvisPrediction.adjustments.v1Floor },
                                    ]
                                      .filter((a) => a.isBase || Math.abs(a.val) >= 0.05)
                                      .map((a) => (
                                        <div key={a.label} className="flex justify-between text-[10px]">
                                          <span className="text-gray-500">{a.label}:</span>
                                          <span
                                            className={
                                              a.isBase
                                                ? 'text-white'
                                                : a.val > 0
                                                  ? 'text-green-400'
                                                  : a.val < 0
                                                    ? 'text-red-400'
                                                    : 'text-gray-500'
                                            }
                                          >
                                            {a.isBase
                                              ? a.val.toFixed(1) + '°'
                                              : (a.val > 0 ? '+' : '') + a.val.toFixed(2) + '°'}
                                          </span>
                                        </div>
                                      ))}
                                    <div className="flex justify-between text-[10px] border-t border-white/5 mt-0.5 pt-0.5">
                                      <span className="text-purple-400 font-bold">Final:</span>
                                      <span className="text-white font-bold">
                                        {c.jarvisPrediction.prediction.toFixed(1)}
                                        {unitLabel}
                                      </span>
                                    </div>
                                  </div>
                                  {/* Market Edge */}
                                  {c.jarvisPrediction.marketEdge.filter((e) => Math.abs(e.edge) >= 0.05).length > 0 && (
                                    <div className="border-t border-white/10 pt-1 mt-1">
                                      <div className="text-[10px] text-gray-500 mb-1">Edge Opportunities:</div>
                                      {c.jarvisPrediction.marketEdge
                                        .filter((e) => Math.abs(e.edge) >= 0.05)
                                        .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
                                        .slice(0, 3)
                                        .map((e) => (
                                          <div key={e.bucket} className="flex justify-between text-[10px]">
                                            <span className="text-gray-400">
                                              {e.bucket} {e.side}:
                                            </span>
                                            <span className={e.edge > 0 ? 'text-green-400 font-bold' : 'text-red-400'}>
                                              {(e.edge * 100).toFixed(0)}% edge
                                            </span>
                                          </div>
                                        ))}
                                    </div>
                                  )}
                                  {/* Conditions */}
                                  {(c.windSpeed ||
                                    c.humidity ||
                                    (c.openMeteoObs?.cloudCover !== null &&
                                      c.openMeteoObs?.cloudCover !== undefined)) && (
                                    <div className="border-t border-white/10 pt-1 mt-1 text-[10px] text-gray-500">
                                      {c.windSpeed !== null &&
                                        c.windSpeed !== undefined &&
                                        `${c.windSpeed}mph ${c.windDirection || ''}`}
                                      {c.humidity !== null && c.humidity !== undefined && ` · ${c.humidity}%`}
                                      {c.openMeteoObs?.cloudCover !== null &&
                                        c.openMeteoObs?.cloudCover !== undefined &&
                                        ` · ${c.openMeteoObs.cloudCover}%`}
                                      {c.pressureTrend &&
                                        ` · ${c.pressureTrend === 'Falling' ? '↓' : c.pressureTrend === 'Rising' ? '↑' : '→'} ${c.pressure?.toFixed(2) || ''}`}
                                    </div>
                                  )}
                                </div>
                              }
                            >
                              <div className="text-sm font-mono cursor-help text-right">
                                <span className="text-purple-400 font-bold">
                                  {c.jarvisPrediction.prediction.toFixed(1)}
                                  {unitLabel}
                                </span>
                                <span
                                  className={`ml-1 text-[10px] ${
                                    c.jarvisPrediction.confidence >= 70
                                      ? 'text-green-400'
                                      : c.jarvisPrediction.confidence >= 40
                                        ? 'text-yellow-400'
                                        : 'text-red-400'
                                  }`}
                                >
                                  {c.jarvisPrediction.confidence}%
                                </span>
                                <div
                                  className={`text-[8px] ${
                                    c.jarvisPrediction.method === 'CONFIRMED'
                                      ? 'text-green-500'
                                      : c.jarvisPrediction.method === 'TRAJECTORY'
                                        ? 'text-blue-500'
                                        : c.jarvisPrediction.method === 'BLEND'
                                          ? 'text-purple-500'
                                          : 'text-gray-600'
                                  }`}
                                >
                                  {c.jarvisPrediction.method}
                                </div>
                              </div>
                            </HoverInfo>
                          ) : (
                            <span className="text-gray-600 text-sm">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-center text-xs font-mono">
                          {c.liveMarkets !== undefined && c.totalMarkets !== undefined ? (
                            <span className={c.liveMarkets === 0 ? 'text-gray-600' : 'text-white'}>
                              <span className={c.liveMarkets > 0 ? 'text-green-400 font-bold' : ''}>
                                {c.liveMarkets}
                              </span>
                              <span className="text-gray-600">/{c.totalMarkets}</span>
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3 pr-2">
                          <span className={`text-xs font-bold px-2.5 py-1 rounded ${recColor}`}>
                            {c.recommendation === 'FADE_BUY' ? 'FADE' : c.recommendation}
                          </span>
                        </td>
                      </tr>

                      {/* Expanded city details. v3.76.5: overflow-anchor:auto tells the
                            browser to preserve this row's scroll position natively when rows
                            above resize due to data polls. Replaces the JS effect that was
                            running unbounded and freezing the browser. */}
                      {isExpanded && (
                        <tr ref={expandedCardRef} style={{ overflowAnchor: 'auto' as const }}>
                          <td colSpan={16} className="py-0">
                            <div
                              className={`bg-white/[0.02] border-l-2 ${c.activeBuckets.length > 0 ? 'border-cyan-500/30' : 'border-gray-500/30'} ml-4 mb-2 rounded-r-lg`}
                            >
                              <div className="px-4 py-3">
                                {/* ─── Phase 02.17.26: Signal Drift Banner ─── */}
                                {(() => {
                                  const drift = driftBanners[c.city]
                                  if (!drift) return null
                                  const color = classifyDrift(drift)
                                  const palette =
                                    color === 'amber'
                                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                                      : color === 'green'
                                        ? 'border-green-500/40 bg-green-500/10 text-green-200'
                                        : 'border-blue-500/40 bg-blue-500/10 text-blue-200'
                                  const age = Date.now() - drift.triggeredAt
                                  // Hard age guard: the 10s ticker prunes but between ticks
                                  // a banner could technically render past TTL for a few
                                  // seconds. Guard here as well so the UI never lies.
                                  if (age >= BANNER_TTL_MS) return null
                                  return (
                                    <div
                                      className={`mb-3 px-3 py-2 rounded border ${palette} flex items-center gap-2 text-xs font-mono`}
                                      role="status"
                                      aria-live="polite"
                                    >
                                      <span className="text-base leading-none">⚠</span>
                                      <span className="font-semibold">{formatBannerText(drift, Date.now())}</span>
                                    </div>
                                  )
                                })()}
                                {/* ─── v3.99.52: station-change warning banner ─── */}
                                {c.stationWarning && (
                                  <div
                                    className="mb-3 px-3 py-2 rounded-lg border border-red-500/50 bg-red-500/[0.08] flex flex-col gap-1"
                                    role="status"
                                    aria-live="polite"
                                  >
                                    <div className="flex items-center gap-2 text-sm font-bold text-red-300">
                                      <span className="text-base leading-none">⚠</span>
                                      <span>
                                        STATION CORRECTED: {c.stationWarning.oldStation} → {c.stationWarning.newStation}
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-red-200/90 leading-snug">
                                      {c.stationWarning.reason}
                                    </div>
                                    <div className="text-[10px] text-red-400/70 font-mono">
                                      Changed{' '}
                                      {new Date(c.stationWarning.changedAt).toLocaleString('en-US', {
                                        timeZone: 'America/Puerto_Rico',
                                        hour12: false,
                                      })}{' '}
                                      AST. Derived win rates / residuals / ground truth still use the old station —
                                      rebuild in flight.
                                    </div>
                                  </div>
                                )}
                                {/* ─── v3.99.47: pipeline disagreement + stale-forecast chips ─── */}
                                {(c.pipelineDisagreement?.detected || c._staleForecast) && (
                                  <div className="mb-3 flex flex-wrap gap-2">
                                    {c.pipelineDisagreement?.detected && (
                                      <span
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono font-bold border bg-amber-500/10 border-amber-500/40 text-amber-300"
                                        title={`jarvisPrediction and ensembleProb disagree by ${c.pipelineDisagreement.gap}°. Consider waiting for confirmation before sizing up.`}
                                      >
                                        ⚠ Pipeline disagreement: JP={c.pipelineDisagreement.jpBucket}
                                        {c.unit === 'F' ? '°F' : '°C'} vs ENS={c.pipelineDisagreement.ensTopBucket}
                                        {c.unit === 'F' ? '°F' : '°C'}
                                      </span>
                                    )}
                                    {c._staleForecast && c._staleFields && c._staleFields.length > 0 && (
                                      <span
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono font-bold border bg-orange-500/10 border-orange-500/40 text-orange-300"
                                        title={`These fields were carried over from a previous compute because the latest fetch returned null. Cache-restored: ${c._staleFields.join(', ')}`}
                                      >
                                        ⚠ Stale: {c._staleFields.slice(0, 3).join(', ')}
                                        {c._staleFields.length > 3 && ` +${c._staleFields.length - 3}`}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {/* v3.100.7: canonical peak bar on preview — single source of truth.
                                    Reads c.runningHigh / c.peakHourLocal / c.peakMinuteLocal / c.hoursSincePeak
                                    / c.trendLabel / c.currentTemp / c.wuFcstHigh straight from the
                                    /api/brain/trading?type=weather-intel payload (WU V1 archive). Matches
                                    exactly what LiveBucketStrip + AI Engine badges show below. */}
                                {isUnifiedPreview && (
                                  <CanonicalPeakBar
                                    runningHigh={c.runningHigh}
                                    peakHourLocal={c.peakHourLocal}
                                    peakMinuteLocal={c.peakMinuteLocal}
                                    hoursSincePeak={c.hoursSincePeak}
                                    trendLabel={c.trendLabel}
                                    currentTemp={c.currentTemp}
                                    wuFcstHigh={c.wuFcstHigh}
                                    localHour={c.localHour}
                                    unitLabel={c.unit === 'F' ? '°F' : '°C'}
                                    typicalPeakLocalHour={(() => {
                                      // Heuristic mirrors /api/brain/trading/city-intel/[city].
                                      // Tropical cities peak earlier (thunderstorm cap); mid-lat later.
                                      const tropical = new Set([
                                        'singapore',
                                        'jakarta',
                                        'kuala-lumpur',
                                        'shenzhen',
                                        'hong-kong',
                                        'taipei',
                                        'miami',
                                        'panama-city',
                                        'lucknow',
                                        'mexico-city',
                                      ])
                                      const lateAfternoon = new Set([
                                        'buenos-aires',
                                        'sao-paulo',
                                        'austin',
                                        'dallas',
                                        'houston',
                                      ])
                                      if (tropical.has(c.city)) return 13
                                      if (lateAfternoon.has(c.city)) return 16
                                      return 15 // default mid-latitude continental
                                    })()}
                                  />
                                )}
                                {/* ─── Phase 02.21 v3.93: Sniper Intel strip ─── */}
                                {/* v3.100.7: hidden on preview — its independently-polled peak drifts
                                    from the canonical value above. METAR intent badges can be added to
                                    CanonicalPeakBar in a follow-up. Live /brain/trading still renders it. */}
                                {!isUnifiedPreview && (
                                  <SniperIntelStrip city={c.city} displayUnit={c.unit === 'F' ? 'F' : 'C'} />
                                )}
                                {isUnifiedPreview && (
                                  <UnifiedEngineBadge
                                    jp={c.jarvisPrediction}
                                    unitLabel={c.unit === 'F' ? '°F' : '°C'}
                                    variant="strip"
                                  />
                                )}
                                {/* ─── Tab Bar ─── */}
                                {(() => {
                                  const activeTab = cityTab[c.city] || 'wu'
                                  const tabs = [
                                    {
                                      id: 'wu',
                                      label: c.resolutionSource ? `${c.resolutionSource}` : 'Weather Underground',
                                      color: 'cyan',
                                      href: c.resolutionLink || c.wuLink,
                                    },
                                    { id: 'polymarket', label: 'Polymarket', color: 'purple' },
                                    {
                                      id: 'weathercom',
                                      label: 'Weather.com',
                                      color: 'blue',
                                      href: c.weatherComLink,
                                    },
                                    // Phase 02.18: Show ASOS/METAR for ALL cities including Hong Kong and KL.
                                    // HK uses VHHH for METAR (airport reference), HKO Observatory is resolution source.
                                    {
                                      id: 'asos' as const,
                                      label: 'ASOS Live',
                                      color: 'green' as const,
                                      href:
                                        c.city === 'hong-kong'
                                          ? 'https://www.weather.gov.hk/en/wxinfo/ts/display/pws_hhko_e.htm'
                                          : `https://www.weather.gov/wrh/timeseries?site=${c.station}`,
                                    },
                                    {
                                      id: 'metar' as const,
                                      label: '✈ METAR Decoded',
                                      color: 'orange' as const,
                                      href: `https://aviationweather.gov/data/metar/?id=${c.station}&hours=6&decoded=yes`,
                                    },
                                    {
                                      id: 'cheatsheet',
                                      label: 'Cheatsheet',
                                      color: 'amber',
                                      href: '/trading-cheatsheet.html',
                                    },
                                  ] as const
                                  const colorMap: Record<string, { active: string; inactive: string }> = {
                                    cyan: {
                                      active: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50',
                                      inactive:
                                        'bg-cyan-500/5 text-cyan-400/60 hover:bg-cyan-500/10 border-transparent',
                                    },
                                    purple: {
                                      active: 'bg-purple-500/20 text-purple-400 border-purple-500/50',
                                      inactive:
                                        'bg-purple-500/5 text-purple-400/60 hover:bg-purple-500/10 border-transparent',
                                    },
                                    blue: {
                                      active: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
                                      inactive:
                                        'bg-blue-500/5 text-blue-400/60 hover:bg-blue-500/10 border-transparent',
                                    },
                                    green: {
                                      active: 'bg-green-500/20 text-green-400 border-green-500/50',
                                      inactive:
                                        'bg-green-500/5 text-green-400/60 hover:bg-green-500/10 border-transparent',
                                    },
                                    orange: {
                                      active: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
                                      inactive:
                                        'bg-orange-500/5 text-orange-400/60 hover:bg-orange-500/10 border-transparent',
                                    },
                                    amber: {
                                      active: 'bg-amber-500/20 text-amber-400 border-amber-500/50',
                                      inactive:
                                        'bg-amber-500/5 text-amber-400/60 hover:bg-amber-500/10 border-transparent',
                                    },
                                  }
                                  return (
                                    <div className="flex items-center gap-1.5 mb-3 pb-2 border-b border-white/[0.06] flex-wrap">
                                      {tabs.map((tab) => {
                                        const isActive = activeTab === tab.id
                                        const cm = colorMap[tab.color]
                                        if ('href' in tab && tab.href) {
                                          return (
                                            <a
                                              key={tab.id}
                                              href={tab.href}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors border ${cm.inactive}`}
                                            >
                                              {tab.label} <span className="text-[9px] opacity-60">&#8599;</span>
                                            </a>
                                          )
                                        }
                                        return (
                                          <button
                                            key={tab.id}
                                            onClick={() =>
                                              setCityTab((prev) => ({
                                                ...prev,
                                                [c.city]: prev[c.city] === tab.id ? 'wu' : tab.id,
                                              }))
                                            }
                                            className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors border ${isActive ? cm.active : cm.inactive}`}
                                          >
                                            {tab.label}
                                            {tab.id === 'polymarket' && c.activeBuckets.length > 0 && (
                                              <span className="text-[9px] opacity-70">{c.activeBuckets.length}</span>
                                            )}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  )
                                })()}

                                {/* v3.100.43 (2026-05-20): event-date warning banner.
                                    Defense in depth — even if cascade logic in
                                    /api/brain/trading silently jumps the displayed
                                    market to a future date, this banner makes the
                                    target date visually unmissable. the operator placed
                                    a bet on May 21 buckets thinking they were today's
                                    after Toronto's closed-but-not-archived May 20
                                    event triggered the cascade. Money bug. */}
                                {(() => {
                                  if (!c.eventDate) return null
                                  // v3.100.44: compute city local-today from c.timezone (IANA).
                                  // v3.100.43 erroneously used lastObsLocalTime?.slice(0,10) which
                                  // returns a TIME like "11:20 AM G", never matching a YYYY-MM-DD
                                  // eventDate → every city got a false red "NOT TODAY" banner.
                                  const tz = c.timezone
                                  let todayLocal: string | null = null
                                  if (tz) {
                                    try {
                                      const parts = new Intl.DateTimeFormat('en-CA', {
                                        timeZone: tz,
                                        year: 'numeric',
                                        month: '2-digit',
                                        day: '2-digit',
                                      }).format(new Date())
                                      // en-CA returns YYYY-MM-DD natively
                                      if (/^\d{4}-\d{2}-\d{2}$/.test(parts)) todayLocal = parts
                                    } catch {
                                      todayLocal = null
                                    }
                                  }
                                  if (!todayLocal) return null
                                  const matchesToday = c.eventDate === todayLocal
                                  const eventDateNice = (() => {
                                    try {
                                      const [y, m, d] = c.eventDate.split('-').map(Number)
                                      const dt = new Date(y, m - 1, d)
                                      return dt.toLocaleDateString('en-US', {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                      })
                                    } catch {
                                      return c.eventDate
                                    }
                                  })()
                                  if (matchesToday) {
                                    return (
                                      <div className="mb-2 px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[11px] font-mono flex items-center justify-between">
                                        <span className="font-bold">MARKET: {eventDateNice} (today's high)</span>
                                        <span className="text-emerald-500/70 text-[10px]">{c.eventDate}</span>
                                      </div>
                                    )
                                  }
                                  return (
                                    <div className="mb-2 px-3 py-2 rounded border-2 border-red-500 bg-red-500/15 text-red-200 text-[12px] font-mono flex items-center justify-between animate-pulse">
                                      <span className="font-bold uppercase tracking-wide">
                                        ⚠ MARKET IS FOR {eventDateNice.toUpperCase()} — NOT TODAY ({todayLocal})
                                      </span>
                                      <span className="text-red-300 text-[11px]">
                                        bet only if you mean a future day
                                      </span>
                                    </div>
                                  )
                                })()}

                                {/* v3.100.25: standalone Settlement panel removed.
                                    Settlement check is now folded inline into the Best Bet panel
                                    inside LiveBucketStrip (via the `resolution` prop). One panel,
                                    one recommendation, no jargon-stack. */}

                                {isUnifiedPreview && (
                                  <LiveBucketStrip
                                    activeBuckets={c.activeBuckets}
                                    jp={c.jarvisPrediction}
                                    runningHigh={c.runningHigh}
                                    unitLabel={c.unit === 'F' ? '°F' : '°C'}
                                    obsCount={c.obsCount}
                                    peakHourLocal={c.peakHourLocal}
                                    peakMinuteLocal={c.peakMinuteLocal}
                                    hoursSincePeak={c.hoursSincePeak}
                                    bestModel={c.bestModel}
                                    bestModelWR={c.bestModelWR}
                                    todayApplicableModel={c.todayApplicableModel}
                                    todayApplicableWR={c.todayApplicableWR}
                                    comboStatus={c.comboStatus}
                                    pendingModels={c.pendingModels}
                                    modelForecasts={{
                                      ecmwf: c.ecmwf,
                                      gfs: c.gfs,
                                      icon: c.icon,
                                      gem: c.gem,
                                      jma: c.jma,
                                    }}
                                    // v3.100.10: WR-weighted ensemble inputs — demotes low-WR models.
                                    // Uses c.allModels (the wide API-provided map) as primary source;
                                    // falls back to the typed legacy fields so main ensemble keys are covered.
                                    allModelForecasts={(() => {
                                      const allM =
                                        (c as unknown as { allModels?: Record<string, number | null> }).allModels ??
                                        null
                                      const merged: Record<string, number | null> = {
                                        ecmwf: c.ecmwf ?? null,
                                        gfs: c.gfs ?? null,
                                        icon: c.icon ?? null,
                                        gem: c.gem ?? null,
                                        jma: c.jma ?? null,
                                        ukmo: c.ukmo ?? null,
                                        cma: c.cma ?? null,
                                        meteofrance: c.meteofrance ?? null,
                                        knmi: c.knmi ?? null,
                                        ...(allM ?? {}),
                                      }
                                      return merged
                                    })()}
                                    perModelWinRates={c.perModelWinRates}
                                    // v3.100.22 (preview only): real-fill VWAP column from CLOB
                                    clobDepth={isPreviewRoute ? (previewClobDepth[c.city] ?? null) : null}
                                    // v3.100.24 (preview only): AIFS up-weight + hot-day cold-bias correction
                                    v2EngineEnabled={isPreviewRoute}
                                    unit={c.unit === 'F' || c.unit === 'C' ? c.unit : undefined}
                                    // v3.100.25 (preview only): inputs for the consolidated Best Bet panel
                                    citySlug={c.city}
                                    cityName={c.city
                                      .split('-')
                                      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                                      .join(' ')}
                                    resolution={
                                      isPreviewRoute && previewResolution[c.city]
                                        ? {
                                            station: previewResolution[c.city]?.station ?? null,
                                            verified: previewResolution[c.city]?.verified ?? false,
                                            rule: previewResolution[c.city]?.rule ?? 'unknown',
                                          }
                                        : null
                                    }
                                    // v3.100.27 (preview only): METAR wind direction → cold-advection chip
                                    windDirection={isPreviewRoute ? c.windDirection : null}
                                  />
                                )}

                                {/* ─── Polymarket Quick Trade (toggleable, shows above weather data) ─── */}
                                {(cityTab[c.city] || 'wu') === 'polymarket' && (
                                  <div>
                                    <div className="flex items-center justify-between mb-3">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold text-white">Quick Trade</span>
                                        <span className="text-[10px] text-gray-500">
                                          {c.activeBuckets.length} buckets
                                        </span>
                                      </div>
                                      {c.polymarketUrl && (
                                        <a
                                          href={c.polymarketUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[10px] text-purple-400 hover:text-purple-300 font-medium transition-colors"
                                        >
                                          Full Polymarket &#8599;
                                        </a>
                                      )}
                                    </div>
                                    {c.activeBuckets.length > 0 ? (
                                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                                        {c.activeBuckets.map((b, bi) => {
                                          const isConfirmed = b.status === 'CONFIRMED_YES'
                                          const isDead = b.status === 'DEAD'
                                          const isFade = b.status === 'FADE_LOCK'
                                          const isOpen = b.status === 'UNCERTAIN'
                                          const hasEdge = b.edge !== null && b.edge > 0.005
                                          const yesPercent = Math.round(b.yesPrice * 100)
                                          const noPercent = Math.round(b.noPrice * 100)
                                          const cardBg = isConfirmed
                                            ? 'bg-green-500/[0.08]'
                                            : isFade
                                              ? 'bg-purple-500/[0.08]'
                                              : isDead
                                                ? 'bg-gray-900/30'
                                                : 'bg-white/[0.03]'
                                          const borderColor = isConfirmed
                                            ? 'border-green-500/50'
                                            : isFade
                                              ? 'border-purple-500/50'
                                              : isDead
                                                ? 'border-gray-800/50'
                                                : hasEdge
                                                  ? 'border-cyan-500/30'
                                                  : 'border-white/[0.06]'
                                          const statusBadge = isConfirmed
                                            ? { text: 'CONFIRMED', color: 'bg-green-500/20 text-green-400' }
                                            : isFade
                                              ? { text: 'FADE LOCK', color: 'bg-purple-500/20 text-purple-400' }
                                              : isDead
                                                ? { text: 'DEAD', color: 'bg-red-500/15 text-red-500/60' }
                                                : isOpen && yesPercent > 0
                                                  ? { text: 'OPEN', color: 'bg-cyan-500/15 text-cyan-400/70' }
                                                  : null
                                          return (
                                            <div
                                              key={bi}
                                              className={`rounded-xl ${cardBg} border ${borderColor} p-2.5 flex flex-col gap-1 ${isDead ? 'opacity-35' : ''} transition-all hover:scale-[1.02] hover:border-white/20 group`}
                                            >
                                              <div className="flex items-center justify-between">
                                                <span
                                                  className={`text-base font-black font-mono ${isDead ? 'text-gray-500' : 'text-white'}`}
                                                >
                                                  {b.label}
                                                </span>
                                                {statusBadge && (
                                                  <span
                                                    className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider ${statusBadge.color}`}
                                                  >
                                                    {statusBadge.text}
                                                  </span>
                                                )}
                                              </div>
                                              <div className="flex items-center justify-center gap-3 text-xs font-mono mt-0.5">
                                                <div className="flex items-center gap-1">
                                                  <span className="text-[9px] text-gray-500">YES</span>
                                                  <span
                                                    className={`font-bold ${yesPercent > 20 ? 'text-green-400' : yesPercent > 0 ? 'text-green-400/70' : 'text-gray-600'}`}
                                                  >
                                                    {yesPercent}c
                                                  </span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                  <span className="text-[9px] text-gray-500">NO</span>
                                                  <span
                                                    className={`font-bold ${noPercent > 80 ? 'text-red-400/60' : 'text-red-400'}`}
                                                  >
                                                    {noPercent}c
                                                  </span>
                                                </div>
                                              </div>
                                              {hasEdge && (
                                                <div className="flex items-center gap-1 mt-0.5">
                                                  <div className="flex-1 h-1 rounded-full bg-gray-800 overflow-hidden">
                                                    <div
                                                      className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400"
                                                      style={{ width: `${Math.min(b.edge! * 100, 100)}%` }}
                                                    />
                                                  </div>
                                                  <span className="text-[10px] text-green-400 font-bold whitespace-nowrap">
                                                    {(b.edge! * 100).toFixed(0)}%
                                                  </span>
                                                </div>
                                              )}
                                              {!isDead && c.polymarketUrl ? (
                                                <a
                                                  href={c.polymarketUrl}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="mt-1 flex items-center justify-center gap-1 w-full py-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-400 text-[10px] font-bold transition-colors group-hover:border-purple-500/40"
                                                >
                                                  TRADE &#8599;
                                                </a>
                                              ) : isDead ? (
                                                <div className="mt-1 text-center py-1.5 text-[10px] text-gray-600 font-medium">
                                                  Resolved
                                                </div>
                                              ) : (
                                                <div className="mt-1 text-center py-1.5 text-[10px] text-gray-600">
                                                  No market
                                                </div>
                                              )}
                                            </div>
                                          )
                                        })}
                                      </div>
                                    ) : (
                                      <div className="text-center py-6 text-gray-500 text-sm">
                                        No active buckets for this city
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* ─── Weather Underground (always visible) ─── */}
                                <>
                                  {/* ─── Weather Panel (split: WU forecast left, METAR station right) ─── */}
                                  {(c.wuConditions ||
                                    c.wuFcstHigh !== null ||
                                    (c.wuHourlyForecast && c.wuHourlyForecast.length > 0) ||
                                    c.decodedMetar) && (
                                    <div
                                      className={`mb-3 rounded-md ${c.city === 'hong-kong' ? 'bg-emerald-500/[0.04] border border-emerald-500/20' : 'bg-blue-500/[0.04] border border-blue-500/20'} overflow-hidden`}
                                    >
                                      <div
                                        className={`grid grid-cols-1 ${c.city === 'hong-kong' ? '' : 'md:grid-cols-2'} divide-y md:divide-y-0 md:divide-x divide-blue-500/10`}
                                      >
                                        {/* ── LEFT: HKO Observatory for HK, Weather Underground for others ── */}
                                        <div className="px-3 py-2.5">
                                          <div className="flex items-center gap-2 mb-2">
                                            <span
                                              className={`text-[10px] font-bold uppercase tracking-wider ${c.city === 'hong-kong' ? 'text-emerald-400' : 'text-blue-400'}`}
                                            >
                                              {c.city === 'hong-kong' ? 'HKO Observatory' : 'Weather Underground'}
                                            </span>
                                            {c.city === 'hong-kong' ? (
                                              <span className="text-[9px] font-mono text-emerald-400/60">
                                                (Resolution Source)
                                              </span>
                                            ) : (
                                              <span className="text-[9px] font-mono text-blue-400/60">
                                                ({c.station})
                                              </span>
                                            )}
                                            {c.wuWebsiteTime && (
                                              <span className="text-[9px] text-gray-500 font-mono">
                                                {c.wuWebsiteTime}
                                              </span>
                                            )}
                                          </div>
                                          {/* HK: show HKO running high as Today's High + WU forecast as secondary */}
                                          {c.city === 'hong-kong' && c.hkoDecimal ? (
                                            <>
                                              {c.hkoDecimal.runningHigh !== null &&
                                                c.hkoDecimal.runningHigh !== undefined && (
                                                  <div className="mb-1.5">
                                                    <div className="text-[9px] text-gray-500 mb-0.5">
                                                      Today&apos;s High (HKO)
                                                    </div>
                                                    <div className="flex items-baseline gap-2">
                                                      <span className="text-xl font-mono font-black text-emerald-400">
                                                        {Number(c.hkoDecimal.runningHigh).toFixed(1)}°C
                                                      </span>
                                                      {c.hkoDecimal.isDecimal && (
                                                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                                          0.1°C precision
                                                        </span>
                                                      )}
                                                      {c.hkoDecimal.bucket !== null &&
                                                        c.hkoDecimal.bucket !== undefined && (
                                                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                                                            Bucket: {c.hkoDecimal.bucket}°C
                                                          </span>
                                                        )}
                                                    </div>
                                                  </div>
                                                )}
                                              {c.hkoDecimal.current !== null && c.hkoDecimal.current !== undefined && (
                                                <div className="mb-1.5">
                                                  <div className="text-[9px] text-gray-500 mb-0.5">Current (HKO)</div>
                                                  <span className="text-lg font-mono font-bold text-white">
                                                    {Number(c.hkoDecimal.current).toFixed(1)}°C
                                                  </span>
                                                </div>
                                              )}
                                              {c.wuFcstHigh !== null && c.wuFcstHigh !== undefined && (
                                                <div className="text-[10px] text-gray-500 mb-1">
                                                  WU forecast: {c.wuFcstHigh}°C
                                                  {c.wuFcstLow !== null && c.wuFcstLow !== undefined && (
                                                    <span> / Low: {c.wuFcstLow}°</span>
                                                  )}
                                                </div>
                                              )}
                                            </>
                                          ) : (
                                            <>
                                              {c.wuFcstHigh !== null && c.wuFcstHigh !== undefined && (
                                                <div className="mb-1.5">
                                                  <div className="text-[9px] text-gray-500 mb-0.5">Predicted High</div>
                                                  <div className="flex items-baseline gap-2">
                                                    <span
                                                      className={`text-xl font-mono font-black ${c.runningHigh && c.wuFcstHigh <= c.runningHigh ? 'text-green-400' : 'text-yellow-400'}`}
                                                    >
                                                      {c.wuFcstHigh}°{c.unit === 'F' ? 'F' : 'C'}
                                                    </span>
                                                    {/*
                                                        v3.9 Phase 2.5 follow-up (v3.53.1): the WU WR badge
                                                        is REMOVED here because we do not have any historical
                                                        WU forecast data to backtest against. The value that
                                                        used to render was the city ensemble WR mislabeled as
                                                        "WU" and then honestly relabeled as "Ensemble proxy" —
                                                        both were confusing next to the WU Predicted High
                                                        field. Rendering nothing is the only honest option
                                                        until we start archiving WU forecasts forward and
                                                        accumulate ≥25 samples per city to compute a real WR.
                                                        The backend WU_FORECAST_WR table still exists (commented
                                                        as ensemble proxy) because other code paths reference
                                                        it, but the UI no longer displays a WR number tied to
                                                        the WU Predicted High.
                                                      */}
                                                    {c.wuFcstLow !== null && c.wuFcstLow !== undefined && (
                                                      <span className="text-gray-500 text-xs font-mono">
                                                        Low: {c.wuFcstLow}°
                                                      </span>
                                                    )}
                                                  </div>
                                                  <div className="text-[9px] text-gray-600 mt-0.5 italic">
                                                    WU archive: collecting forecasts every refresh — real WR available
                                                    after ~25-50 days of accumulation
                                                  </div>
                                                  {/* Phase 02.6 Task 2 (project law 2026-04-07): WU-proxy WR.
                                                        Best single NWP model's 730-day bucket-match accuracy as the
                                                        closest honest stand-in until the WU forward archive matures. */}
                                                  {c.bestNwpModel &&
                                                    c.bestNwpSingleWR !== null &&
                                                    c.bestNwpSingleWR !== undefined && (
                                                      <div
                                                        className="text-[9px] text-gray-500 mt-0.5"
                                                        title={
                                                          c.city === 'hong-kong'
                                                            ? "HKO does not publish historical forecasts, so this is the best single NWP model's 730-day bucket-match WR — the closest honest proxy. Real HKO forecast WR is not available."
                                                            : "WU does not publish historical forecasts, so this is the best single NWP model's 730-day bucket-match WR — the closest honest proxy. Real WU forecast WR lights up 2026-05-02 once the forward archive matures."
                                                        }
                                                      >
                                                        {c.city === 'hong-kong' ? 'HKO-proxy WR' : 'WU-proxy WR'} (best
                                                        NWP, 730d): {c.bestNwpModel} {c.bestNwpSingleWR}% ⓘ
                                                      </div>
                                                    )}
                                                </div>
                                              )}
                                              {c.currentTemp !== null && c.currentTemp !== undefined && (
                                                <div className="mb-1.5">
                                                  <div className="text-[9px] text-gray-500 mb-0.5">Current</div>
                                                  <span className="text-lg font-mono font-bold text-white">
                                                    {c.currentTemp}°{c.unit === 'F' ? 'F' : 'C'}
                                                  </span>
                                                </div>
                                              )}
                                            </>
                                          )}
                                          {c.city === 'hong-kong' && (c.wuConditions || c.windSpeed !== null) && (
                                            <div className="text-[9px] text-gray-600 mb-0.5 italic">
                                              Conditions from VHHH airport area:
                                            </div>
                                          )}
                                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mb-2">
                                            {c.wuConditions && (
                                              <span className="text-white font-medium">{c.wuConditions}</span>
                                            )}
                                            {c.windSpeed !== null && c.windSpeed !== undefined && (
                                              <span className="text-gray-400">
                                                {WX_MINI_WIND}
                                                {c.windSpeed}
                                                mph {c.windDirection || ''}
                                              </span>
                                            )}
                                            {c.humidity !== null && c.humidity !== undefined && (
                                              <span className="text-gray-400">
                                                {WX_MINI_DROP}
                                                {c.humidity}%
                                              </span>
                                            )}
                                            {c.openMeteoObs?.cloudCover !== null &&
                                              c.openMeteoObs?.cloudCover !== undefined && (
                                                <span className="text-gray-400">
                                                  {WX_MINI_CLOUD}
                                                  {c.openMeteoObs.cloudCover}%
                                                </span>
                                              )}
                                            {c.pressureTrend && (
                                              <span className="text-gray-400">
                                                {c.pressureTrend === 'Falling'
                                                  ? '↓'
                                                  : c.pressureTrend === 'Rising'
                                                    ? '↑'
                                                    : '→'}{' '}
                                                {c.pressure?.toFixed(1) || ''}
                                              </span>
                                            )}
                                          </div>
                                          {c.wuHourlyForecast && c.wuHourlyForecast.filter((h) => h.hour !== '12 AM').length > 0 && (
                                            <div className="pt-1.5 border-t border-white/5">
                                              <div className="text-[9px] text-gray-500 mb-1">Hourly Forecast:</div>
                                              <div className="flex gap-2 overflow-x-auto pb-1">
                                                {c.wuHourlyForecast
                                                  .filter((h) => h.hour !== '12 AM')
                                                  .map((h, i) => (
                                                    <div
                                                      key={i}
                                                      className="flex flex-col items-center gap-0.5 min-w-[44px] flex-shrink-0"
                                                      title={h.conditions}
                                                    >
                                                      <span className="text-[10px] text-gray-500 font-medium">
                                                        {h.hour}
                                                      </span>
                                                      <span className="text-base leading-none">
                                                        {weatherIcon(h.conditions, h.hour)}
                                                      </span>
                                                      <span className="text-sm font-mono font-bold text-white">
                                                        {h.temp}°
                                                      </span>
                                                      {h.precipChance > 0 && (
                                                        <span className="text-[9px] text-blue-400 font-medium">
                                                          {h.precipChance}%
                                                        </span>
                                                      )}
                                                    </div>
                                                  ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                        {/* ── RIGHT panel: METAR Station (non-HK) OR Hong Kong Observatory (HK).
                                             v3.99.84 (2026-04-20): for HK, this column now shows HKO Observatory
                                             data (the actual PM resolution source) instead of VHHH airport METAR
                                             (which is 25km away and not the resolution source). VHHH cross-ref
                                             stays available via the vhhhTemp / vhhhHigh chips. Station label
                                             shows "HKO Observatory" for HK, the METAR ICAO for everyone else. */}
                                        {true && (
                                          <div className="px-3 py-2.5">
                                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                                              <span
                                                className={`text-[10px] font-bold uppercase tracking-wider ${c.city === 'hong-kong' ? 'text-emerald-400' : 'text-emerald-400'}`}
                                              >
                                                {c.city === 'hong-kong' ? 'Hong Kong Observatory' : 'METAR Station'}
                                              </span>
                                              <span className={`text-[9px] font-mono text-emerald-400/60`}>
                                                ({c.city === 'hong-kong' ? 'HKO' : c.station})
                                              </span>
                                              {c.city === 'hong-kong' && (
                                                <span className="text-[9px] text-emerald-400/80 italic">
                                                  PM resolution source
                                                </span>
                                              )}
                                              {(() => {
                                                if (!c.decodedMetar?.obsTime) return null
                                                const obsDate = new Date(c.decodedMetar.obsTime)
                                                const minsAgo = Math.floor((Date.now() - obsDate.getTime()) / 60000)
                                                const timeStr = obsDate.toLocaleTimeString('en-US', {
                                                  timeZone: c.timezone || 'UTC',
                                                  hour: 'numeric',
                                                  minute: '2-digit',
                                                  hour12: true,
                                                })
                                                return (
                                                  <span
                                                    className={`text-[9px] font-mono ${minsAgo > 60 ? 'text-red-400' : minsAgo > 30 ? 'text-yellow-500' : 'text-gray-500'}`}
                                                  >
                                                    {timeStr} ({minsAgo}m ago)
                                                  </span>
                                                )
                                              })()}
                                            </div>
                                            {/* METAR reliability warning */}
                                            {c.metarGrade === 'C' && (
                                              <div className="mb-2 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 flex items-start gap-1.5">
                                                <svg
                                                  xmlns="http://www.w3.org/2000/svg"
                                                  viewBox="0 0 20 20"
                                                  fill="currentColor"
                                                  className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                                                >
                                                  <path
                                                    fillRule="evenodd"
                                                    d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                                                    clipRule="evenodd"
                                                  />
                                                </svg>
                                                <span className="text-[10px] text-red-400">
                                                  METAR unreliable for this city ({c.metarMatchPct ?? '?'}% match rate).
                                                  Do not trust for trading decisions.
                                                </span>
                                              </div>
                                            )}
                                            {/* Today's High — for HK uses HKO (v1ArchiveHigh = HKO peak),
                                                everyone else uses METAR */}
                                            {c.city === 'hong-kong'
                                              ? c.v1ArchiveHigh !== null &&
                                                c.v1ArchiveHigh !== undefined && (
                                                  <div className="mb-1.5">
                                                    <div className="text-[9px] text-gray-500 mb-0.5">
                                                      Today&apos;s High (HKO)
                                                    </div>
                                                    <span className="text-xl font-mono font-black text-emerald-400">
                                                      {Math.round(c.v1ArchiveHigh * 10) / 10}°C
                                                    </span>
                                                  </div>
                                                )
                                              : c.metarHigh !== null &&
                                                c.metarHigh !== undefined && (
                                                  <div className="mb-1.5">
                                                    <div className="text-[9px] text-gray-500 mb-0.5">
                                                      Today&apos;s High
                                                    </div>
                                                    <span
                                                      className={`text-xl font-mono font-black ${c.metarGrade === 'C' ? 'text-red-400/60' : 'text-emerald-400'}`}
                                                    >
                                                      {typeof c.metarHigh === 'number'
                                                        ? Math.round(c.metarHigh * 10) / 10
                                                        : c.metarHigh}
                                                      °{c.unit === 'F' ? 'F' : 'C'}
                                                    </span>
                                                  </div>
                                                )}
                                            {c.city === 'hong-kong'
                                              ? c.v3LiveCurrent !== null &&
                                                c.v3LiveCurrent !== undefined && (
                                                  <div className="mb-1.5">
                                                    <div className="text-[9px] text-gray-500 mb-0.5">Current (HKO)</div>
                                                    <span className="text-lg font-mono font-bold text-white">
                                                      {Math.round(c.v3LiveCurrent * 10) / 10}°C
                                                    </span>
                                                  </div>
                                                )
                                              : c.decodedMetar?.temp !== null &&
                                                c.decodedMetar?.temp !== undefined && (
                                                  <div className="mb-1.5">
                                                    <div className="text-[9px] text-gray-500 mb-0.5">Current</div>
                                                    <span className="text-lg font-mono font-bold text-white">
                                                      {c.decodedMetar.temp}°{c.unit === 'F' ? 'F' : 'C'}
                                                    </span>
                                                  </div>
                                                )}
                                            {/* HK: show VHHH as small cross-reference chip, not as primary data */}
                                            {c.city === 'hong-kong' &&
                                              c.vhhhHigh !== null &&
                                              c.vhhhHigh !== undefined && (
                                                <div className="mb-2 text-[10px] text-gray-500">
                                                  VHHH airport cross-ref: high {Math.round(c.vhhhHigh * 10) / 10}°C
                                                  {c.vhhhTemp !== null && c.vhhhTemp !== undefined
                                                    ? `, current ${Math.round(c.vhhhTemp * 10) / 10}°C`
                                                    : ''}
                                                  <span className="text-yellow-500/70 italic">
                                                    {' '}
                                                    (25km from HKO, not resolution)
                                                  </span>
                                                </div>
                                              )}
                                            {/* Conditions + wind + dewpoint + humidity + visibility + pressure */}
                                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mb-2">
                                              {c.decodedMetar?.conditions && (
                                                <span className="text-white font-medium">
                                                  {weatherIcon(c.decodedMetar.conditions)} {c.decodedMetar.conditions}
                                                </span>
                                              )}
                                              {c.decodedMetar?.windSpeed !== null &&
                                                c.decodedMetar?.windSpeed !== undefined && (
                                                  <span className="text-gray-400">
                                                    {c.decodedMetar.windSpeed}
                                                    mph from {degreesToCompass(c.decodedMetar.windDirection)}
                                                    {c.decodedMetar.windGust
                                                      ? `, gusting ${c.decodedMetar.windGust}mph`
                                                      : ''}
                                                  </span>
                                                )}
                                              {c.decodedMetar?.dewpoint !== null &&
                                                c.decodedMetar?.dewpoint !== undefined && (
                                                  <span className="text-gray-400">Dew {c.decodedMetar.dewpoint}°</span>
                                                )}
                                              {c.decodedMetar?.temp !== null &&
                                                c.decodedMetar?.temp !== undefined &&
                                                c.decodedMetar?.dewpoint !== null &&
                                                c.decodedMetar?.dewpoint !== undefined &&
                                                (() => {
                                                  const tC =
                                                    c.unit === 'F'
                                                      ? ((c.decodedMetar!.temp! - 32) * 5) / 9
                                                      : c.decodedMetar!.temp!
                                                  const tdC =
                                                    c.unit === 'F'
                                                      ? ((c.decodedMetar!.dewpoint! - 32) * 5) / 9
                                                      : c.decodedMetar!.dewpoint!
                                                  const rh = Math.round(
                                                    (100 * Math.exp((17.625 * tdC) / (243.04 + tdC))) /
                                                      Math.exp((17.625 * tC) / (243.04 + tC)),
                                                  )
                                                  return <span className="text-gray-400">{rh}%</span>
                                                })()}
                                              {c.decodedMetar?.visibility !== null &&
                                                c.decodedMetar?.visibility !== undefined && (
                                                  <span className="text-gray-400">
                                                    {' '}
                                                    {c.decodedMetar.visibility >= 10
                                                      ? '10+'
                                                      : c.decodedMetar.visibility}{' '}
                                                    mi
                                                  </span>
                                                )}
                                              {c.decodedMetar?.pressure !== null &&
                                                c.decodedMetar?.pressure !== undefined && (
                                                  <span className="text-gray-400">{c.decodedMetar.pressure} hPa</span>
                                                )}
                                            </div>
                                            {/* Cloud layers decoded to English */}
                                            {c.decodedMetar?.clouds && c.decodedMetar.clouds.length > 0 && (
                                              <div className="flex flex-wrap gap-1.5 mb-2">
                                                {c.decodedMetar.clouds.map((cl, i) => {
                                                  const coverText: Record<string, string> = {
                                                    SKC: 'Clear skies',
                                                    CLR: 'Clear skies',
                                                    FEW: 'Few clouds',
                                                    SCT: 'Scattered clouds',
                                                    BKN: 'Broken clouds',
                                                    OVC: 'Overcast',
                                                  }
                                                  const altFt = Math.round(cl.base)
                                                  return (
                                                    <span
                                                      key={i}
                                                      className="text-[10px] text-gray-400 bg-white/[0.03] px-1.5 py-0.5 rounded"
                                                    >
                                                      {coverText[cl.cover] || cl.cover} at{' '}
                                                      {altFt >= 10000
                                                        ? `${(altFt / 1000).toFixed(1)}k`
                                                        : altFt.toLocaleString()}
                                                      ft
                                                    </span>
                                                  )
                                                })}
                                              </div>
                                            )}
                                            {/* METAR today's observations timeline */}
                                            {c.metarTimeline && c.metarTimeline.length > 0 && (
                                              <div className="pt-1.5 border-t border-white/5">
                                                <div className="text-[9px] text-gray-500 mb-1">
                                                  Today&apos;s METAR Observations:
                                                </div>
                                                <div className="flex gap-2 overflow-x-auto pb-1">
                                                  {c.metarTimeline.map((obs, i) => (
                                                    <div
                                                      key={i}
                                                      className="flex flex-col items-center gap-0.5 min-w-[40px] flex-shrink-0"
                                                    >
                                                      <span className="text-[10px] text-gray-500 font-medium">
                                                        {obs.label?.replace(/\s*(AM|PM)/, (_, m: string) =>
                                                          m.toLowerCase().charAt(0),
                                                        ) || `${obs.hour}:${String(obs.minute).padStart(2, '0')}`}
                                                      </span>
                                                      <span
                                                        className={`text-sm font-mono font-bold ${c.metarHigh !== null && obs.temp === c.metarHigh ? 'text-emerald-400' : 'text-white'}`}
                                                      >
                                                        {typeof obs.temp === 'number'
                                                          ? Math.round(obs.temp * 10) / 10
                                                          : obs.temp}
                                                        °
                                                      </span>
                                                    </div>
                                                  ))}
                                                </div>
                                              </div>
                                            )}
                                            {/* Raw METAR string (collapsed by default) */}
                                            {c.decodedMetar?.rawMetar && (
                                              <div className="pt-1 border-t border-white/5 mt-1">
                                                <details>
                                                  <summary className="text-[9px] text-gray-600 cursor-pointer hover:text-gray-400 select-none">
                                                    Raw METAR
                                                  </summary>
                                                  <div className="text-[9px] text-gray-500 font-mono mt-1 break-all leading-relaxed">
                                                    {c.decodedMetar.rawMetar}
                                                  </div>
                                                </details>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                  {/* ─── Stability Assessment (plain-English weather danger signals) ─── */}
                                  {(() => {
                                    const stability = getStabilityAssessment(c)
                                    if (!stability) return null
                                    const borderColor =
                                      stability.level === 'RED'
                                        ? 'border-red-500/30'
                                        : stability.level === 'YELLOW'
                                          ? 'border-yellow-500/30'
                                          : 'border-green-500/30'
                                    const bgColor =
                                      stability.level === 'RED'
                                        ? 'bg-red-500/[0.06]'
                                        : stability.level === 'YELLOW'
                                          ? 'bg-yellow-500/[0.06]'
                                          : 'bg-green-500/[0.06]'
                                    const dotColor =
                                      stability.level === 'RED'
                                        ? 'bg-red-500'
                                        : stability.level === 'YELLOW'
                                          ? 'bg-yellow-500'
                                          : 'bg-green-500'
                                    const labelColor =
                                      stability.level === 'RED'
                                        ? 'text-red-400'
                                        : stability.level === 'YELLOW'
                                          ? 'text-yellow-400'
                                          : 'text-green-400'
                                    return (
                                      <div className={`mb-3 rounded-md ${bgColor} border ${borderColor} px-3 py-2.5`}>
                                        <div className="flex items-center gap-2 mb-1.5">
                                          <span
                                            className={`w-2.5 h-2.5 rounded-full ${dotColor} ${stability.level === 'RED' ? 'animate-pulse' : ''}`}
                                          />
                                          <span
                                            className={`text-[11px] font-black uppercase tracking-wider ${labelColor}`}
                                          >
                                            {stability.label}
                                          </span>
                                          <span className="text-[10px] text-gray-400">{stability.summary}</span>
                                        </div>
                                        <div className="space-y-0.5">
                                          {stability.factors.map((f, i) => (
                                            <div key={i} className="text-[10px] text-gray-300 leading-relaxed pl-4">
                                              {f}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )
                                  })()}
                                  {/* ─── Signal (moved from column) ─── */}
                                  {(() => {
                                    // For Hong Kong, use HKO running high (resolution source). For others, ASOS/METAR.
                                    const fastHigh =
                                      c.city === 'hong-kong' &&
                                      c.hkoDecimal?.runningHigh !== null &&
                                      c.hkoDecimal?.runningHigh !== undefined
                                        ? c.hkoDecimal.runningHigh
                                        : (c.asosHigh ?? c.metarHigh ?? null)
                                    if (fastHigh === null || c.activeBuckets.length === 0) return null
                                    if (c.recommendation === 'CLOSED') return null
                                    const confirmedBucket = [...c.activeBuckets]
                                      .sort((a, b) => b.upper - a.upper)
                                      .find((b) => fastHigh >= b.upper)
                                    const nearBucket = c.activeBuckets
                                      .filter((b) => fastHigh < b.upper && fastHigh >= b.lower)
                                      .sort((a, b) => a.upper - b.upper)[0]
                                    const gapToNext = nearBucket ? nearBucket.upper - fastHigh : null
                                    const ul = c.unit === 'F' ? '°F' : '°C'
                                    return (
                                      <div className="flex items-center gap-3 mb-2 text-xs">
                                        {confirmedBucket ? (
                                          <>
                                            <span className="px-2 py-1 rounded bg-green-500/20 text-green-400 border border-green-500/30 font-bold">
                                              ✓ LOCKED past {confirmedBucket.upper}
                                              {ul}
                                            </span>
                                            <span className="text-gray-500">
                                              {c.city === 'hong-kong' ? 'HKO' : 'ASOS'} confirmed above ceiling — buy
                                              YES below {confirmedBucket.upper}
                                            </span>
                                          </>
                                        ) : gapToNext !== null && gapToNext <= 2 ? (
                                          <>
                                            <span className="px-2 py-1 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 font-bold">
                                              ⚠ {gapToNext.toFixed(1)}° from {nearBucket.upper}
                                              {ul}
                                            </span>
                                            <span className="text-gray-500">Close but not confirmed — risky</span>
                                          </>
                                        ) : (
                                          <>
                                            <span className="px-2 py-1 rounded bg-red-500/10 text-red-400/70 border border-red-500/20 font-bold">
                                              ✕ No edge
                                            </span>
                                            <span className="text-gray-500">Below all bucket ceilings</span>
                                          </>
                                        )}
                                      </div>
                                    )
                                  })()}
                                  {/* ─── METAR Countdown ─── */}
                                  {(() => {
                                    // Compute edge-based last METAR time as fallback when c.metarLastObsTime is null
                                    const edgeStn = edgePanel?.stations[c.station]
                                    let edgeMetarTime: string | null = null
                                    let edgeMetarTimestamp: number | null = null
                                    if (edgeStn?.obs_time_utc) {
                                      const raw = edgeStn.obs_time_utc
                                      let obsDate: Date | null = null
                                      if (typeof raw === 'string' && raw.endsWith('Z') && raw.includes(':')) {
                                        const [hh, mm] = raw.replace('Z', '').split(':').map(Number)
                                        const now = new Date()
                                        obsDate = new Date(
                                          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm),
                                        )
                                      } else if (
                                        typeof raw === 'number' ||
                                        (typeof raw === 'string' && /^\d+$/.test(raw))
                                      ) {
                                        obsDate = new Date(Number(raw) * 1000)
                                      }
                                      if (obsDate && !isNaN(obsDate.getTime())) {
                                        edgeMetarTime = formatLocalTimeWithTZ(obsDate, c.timezone || 'America/New_York')
                                        edgeMetarTimestamp = obsDate.getTime()
                                      }
                                    } else if (edgeStn?.captured_at) {
                                      const d = new Date(edgeStn.captured_at)
                                      if (!isNaN(d.getTime())) {
                                        edgeMetarTime = formatLocalTimeWithTZ(d, c.timezone || 'America/New_York')
                                        edgeMetarTimestamp = d.getTime()
                                      }
                                    }
                                    return (
                                      <MetarCountdown
                                        metarLastObsTime={c.metarLastObsTime || edgeMetarTime}
                                        metarTimeline={c.metarTimeline}
                                        timezone={c.timezone || 'America/New_York'}
                                        isUS={c.unit === 'F'}
                                        cityName={c.city}
                                        metarHigh={c.metarHigh}
                                        unit={c.unit}
                                        edgeObsTimestamp={edgeMetarTimestamp}
                                        metarObsIntervalMin={c.metarObsIntervalMin}
                                        metarLastObsTimestamp={c.metarLastObsTimestamp}
                                        metarTypicalMinutes={c.metarTypicalMinutes}
                                        metarNextExpectedTimestamp={c.metarNextExpectedTimestamp}
                                      />
                                    )
                                  })()}
                                  {/* ─── V1 Next Update Countdown ─── */}
                                  {c.obsTimeline && c.obsTimeline.length >= 2 && (
                                    <V1Countdown
                                      obsIntervalMin={c.obsIntervalMin}
                                      lastObsTimestamp={c.lastObsTimestamp}
                                      nextExpectedTimestamp={c.nextExpectedTimestamp}
                                      lastObsLocalTime={c.lastObsLocalTime}
                                      typicalMinutes={c.typicalMinutes}
                                      cityName={c.city}
                                      runningHigh={c.runningHigh}
                                      unit={c.unit}
                                    />
                                  )}

                                  {/* V2 Sniper removed — no longer used */}

                                  {/* ─── V1 Trade Intelligence Line ─── */}
                                  {(() => {
                                    const unitLabel = c.unit === 'F' ? '°F' : '°C'
                                    const gapThreshold = c.unit === 'C' ? 1 : 2
                                    const fastHigh = Math.max(c.asosHigh ?? 0, c.metarHigh ?? 0)
                                    const v1High = c.runningHigh ?? 0
                                    const gap = fastHigh - v1High
                                    const minsUntilV1 = c.nextExpectedTimestamp
                                      ? Math.round((c.nextExpectedTimestamp - Date.now()) / 60000)
                                      : null
                                    const overdueMins =
                                      minsUntilV1 !== null && minsUntilV1 < -2 ? Math.abs(minsUntilV1) : null
                                    const tempDropping = (c.currentTemp ?? 0) < v1High && v1High > 0

                                    let icon = ''
                                    let msg = ''
                                    let color = 'text-gray-500'

                                    if (overdueMins && overdueMins > 5) {
                                      icon = '⚠'
                                      msg = `V1 is ${overdueMins}m overdue. Data may be lagging. Wait for confirmation.`
                                      color = 'text-amber-400'
                                    } else if (
                                      gap >= gapThreshold &&
                                      minsUntilV1 !== null &&
                                      minsUntilV1 > 0 &&
                                      minsUntilV1 <= 15
                                    ) {
                                      icon = ''
                                      msg = `HIGH CONFIDENCE: Fast source reads ${fastHigh.toFixed(1)}${unitLabel}, V1 updating in ~${minsUntilV1}m — buckets below ${fastHigh.toFixed(0)} will die`
                                      color = 'text-green-400'
                                    } else if (gap >= gapThreshold && minsUntilV1 !== null && minsUntilV1 > 30) {
                                      icon = ''
                                      msg = `Fast source leads by ${gap.toFixed(1)}°. V1 won't catch up for ~${minsUntilV1}m. Early entry = more risk.`
                                      color = 'text-yellow-400'
                                    } else if (gap >= gapThreshold) {
                                      icon = ''
                                      msg = `Fast source leads by ${gap.toFixed(1)}° (${fastHigh.toFixed(1)} vs V1 ${v1High.toFixed(1)}${unitLabel}).${minsUntilV1 !== null ? ` V1 update in ~${minsUntilV1}m.` : ''}`
                                      color = 'text-cyan-400'
                                    } else if (c.highIsDeclining && v1High > 0 && (c.hoursSincePeak ?? 0) < 8) {
                                      // Only show declining if peak was recent (< 8h ago) — otherwise it's stale
                                      icon = '↘'
                                      msg = `Temp declining — current ${c.currentTemp?.toFixed(1)}°, V1 high ${v1High.toFixed(1)}${unitLabel} set ${c.hoursSincePeak?.toFixed(1)}h ago. Temp may still rise.`
                                      color = 'text-blue-400'
                                    } else if (tempDropping && v1High > 0) {
                                      icon = ''
                                      msg = `Current ${c.currentTemp?.toFixed(1)}° vs V1 high ${v1High.toFixed(1)}${unitLabel}. Temp may still rise.`
                                      color = 'text-gray-400'
                                    }

                                    if (!msg) return null
                                    return (
                                      <div
                                        className={`mb-3 px-3 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-xs ${color}`}
                                      >
                                        <span className="mr-1">{icon}</span> {msg}
                                      </div>
                                    )
                                  })()}

                                  {/* ─── Temperature Timeline Chart — WU + METAR ─── */}
                                  {c.obsTimeline &&
                                    (c.obsTimeline.length > 2 || (c.asosTimeline && c.asosTimeline.length > 0)) &&
                                    (() => {
                                      // Convert 24h "14:55" → "2:55 PM"
                                      const to12h = (key: string) => {
                                        const [h, m] = key.split(':').map(Number)
                                        const ampm = h >= 12 ? 'PM' : 'AM'
                                        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
                                        return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
                                      }
                                      // Merge WU, METAR, ASOS, and HKO into unified timeline
                                      const isHongKong = c.city === 'hong-kong'
                                      const hasHko = isHongKong && c.hkoTimeline && c.hkoTimeline.length > 0
                                      const timeMap = new Map<
                                        string,
                                        {
                                          time: string
                                          sortKey: string
                                          wu: number | null
                                          metar: number | null
                                          asos: number | null
                                          hko: number | null
                                          asosSource?: string
                                          asosPrecision?: string
                                        }
                                      >()
                                      for (const p of c.obsTimeline) {
                                        const key = `${p.hour}:${String(p.minute).padStart(2, '0')}`
                                        timeMap.set(key, {
                                          time: to12h(key),
                                          sortKey: key,
                                          wu: p.temp,
                                          metar: null,
                                          asos: null,
                                          hko: null,
                                        })
                                      }
                                      for (const p of c.metarTimeline || []) {
                                        const key = `${p.hour}:${String(p.minute).padStart(2, '0')}`
                                        const existing = timeMap.get(key)
                                        if (existing) {
                                          existing.metar = p.temp
                                        } else {
                                          timeMap.set(key, {
                                            time: to12h(key),
                                            sortKey: key,
                                            wu: null,
                                            metar: p.temp,
                                            asos: null,
                                            hko: null,
                                          })
                                        }
                                      }
                                      for (const p of c.asosTimeline || []) {
                                        const key = `${p.hour}:${String(p.minute).padStart(2, '0')}`
                                        const existing = timeMap.get(key)
                                        if (existing) {
                                          existing.asos = p.temp
                                          existing.asosSource = (p as Record<string, unknown>).source as string
                                          existing.asosPrecision = (p as Record<string, unknown>).precision as string
                                        } else {
                                          timeMap.set(key, {
                                            time: to12h(key),
                                            sortKey: key,
                                            wu: null,
                                            metar: null,
                                            asos: p.temp,
                                            hko: null,
                                            asosSource: (p as Record<string, unknown>).source as string,
                                            asosPrecision: (p as Record<string, unknown>).precision as string,
                                          })
                                        }
                                      }
                                      // HKO Observatory readings (Hong Kong only) — resolution source
                                      if (hasHko) {
                                        for (const p of c.hkoTimeline!) {
                                          const key = `${p.hour}:${String(p.minute).padStart(2, '0')}`
                                          const existing = timeMap.get(key)
                                          if (existing) {
                                            existing.hko = p.temp
                                          } else {
                                            timeMap.set(key, {
                                              time: to12h(key),
                                              sortKey: key,
                                              wu: null,
                                              metar: null,
                                              asos: null,
                                              hko: p.temp,
                                            })
                                          }
                                        }
                                      }
                                      const merged = Array.from(timeMap.values()).sort((a, b) => {
                                        const [ah, am] = a.sortKey.split(':').map(Number)
                                        const [bh, bm] = b.sortKey.split(':').map(Number)
                                        return ah * 60 + am - (bh * 60 + bm)
                                      })
                                      const hasMetar = merged.some((d) => d.metar !== null)
                                      const hasAsos = merged.some((d) => d.asos !== null)

                                      return (
                                        <div className="mb-4">
                                          <div className="flex items-center gap-3 mb-2 flex-wrap">
                                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">
                                              {hasHko
                                                ? 'HKO Observatory (Resolution Source)'
                                                : 'Temperature Timeline (ASOS + WU + METAR)'}
                                            </span>
                                            {/* HKO Observatory legend (Hong Kong only) */}
                                            {hasHko && (
                                              <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
                                                <span className="inline-block w-4 h-0 border-t-2 border-emerald-400" />{' '}
                                                <span className="text-emerald-400 font-bold">HKO</span>
                                                {c.hkoTimeline && c.hkoTimeline.length > 0 && (
                                                  <span className="text-emerald-400 font-bold ml-0.5">
                                                    {c.hkoTimeline[c.hkoTimeline.length - 1].temp.toFixed(1)}°C
                                                  </span>
                                                )}
                                                {c.hkoRunningMax !== null && c.hkoRunningMax !== undefined && (
                                                  <span className="text-emerald-300 ml-1">
                                                    (max: {c.hkoRunningMax.toFixed(1)}°C)
                                                  </span>
                                                )}
                                                <span className="text-[9px] text-emerald-500/60 ml-1">0.1°C</span>
                                              </span>
                                            )}
                                            {/* Standard METAR/WU legends (non-HK cities only) */}
                                            {!hasHko && (
                                              <>
                                                {hasMetar && (
                                                  <>
                                                    <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
                                                      <span className="inline-block w-4 h-0 border-t-2 border-amber-400" />{' '}
                                                      WU
                                                      {c.currentTemp !== null && c.currentTemp !== undefined && (
                                                        <span className="text-amber-400 font-bold ml-0.5">
                                                          {c.currentTemp.toFixed(1)}°
                                                        </span>
                                                      )}
                                                    </span>
                                                    <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
                                                      <span className="inline-block w-4 h-0 border-t-2 border-sky-400" />{' '}
                                                      METAR
                                                      {c.metarCurrent !== null && c.metarCurrent !== undefined && (
                                                        <span className="text-sky-400 font-bold ml-0.5">
                                                          {c.metarCurrent.toFixed(2)}°
                                                        </span>
                                                      )}
                                                      {c.metarHigh !== null && c.metarHigh !== undefined && (
                                                        <span className="text-sky-300 ml-1">
                                                          (high: {c.metarHigh.toFixed(2)}°)
                                                        </span>
                                                      )}
                                                      {c.metarLastObsTime && (
                                                        <span className="text-[9px] text-gray-600 ml-1">
                                                          @{c.metarLastObsTime}
                                                        </span>
                                                      )}
                                                    </span>
                                                  </>
                                                )}
                                                {hasAsos && (
                                                  <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
                                                    <span className="inline-block w-4 h-0 border-t-2 border-pink-500" />{' '}
                                                    ASOS <span className="text-[8px] text-pink-300/70">(T-group)</span>
                                                    {c.asosCurrent !== null && c.asosCurrent !== undefined && (
                                                      <span className="text-pink-400 font-bold ml-0.5">
                                                        {c.asosCurrent.toFixed(2)}°
                                                      </span>
                                                    )}
                                                    {c.asosHigh !== null && c.asosHigh !== undefined && (
                                                      <span className="text-pink-300 ml-1">
                                                        (high: {c.asosHigh.toFixed(2)}°)
                                                      </span>
                                                    )}
                                                    {c.asosLastObsTime && (
                                                      <span className="text-[9px] text-gray-600 ml-1">
                                                        @{c.asosLastObsTime}
                                                      </span>
                                                    )}
                                                    {/* Source + latency indicator */}
                                                    {(() => {
                                                      const latest = c.asosTimeline?.length
                                                        ? c.asosTimeline[c.asosTimeline.length - 1]
                                                        : null
                                                      if (!latest) return null
                                                      const src = latest.source || 'nws'
                                                      const sourceLabel =
                                                        src === 'edge'
                                                          ? 'EDGE'
                                                          : src === 'phone'
                                                            ? 'PHONE'
                                                            : src === 'metar'
                                                              ? '✈ METAR'
                                                              : src === 'v3'
                                                                ? 'V3'
                                                                : 'NWS'
                                                      const isIntl = c.unit === 'C'
                                                      const latency =
                                                        src === 'phone'
                                                          ? '0sec'
                                                          : src === 'edge' && !isIntl
                                                            ? '2-5min'
                                                            : src === 'edge' && isIntl
                                                              ? 'METAR'
                                                              : src === 'metar'
                                                                ? isIntl
                                                                  ? 'METAR'
                                                                  : '3-8min'
                                                                : src === 'nws'
                                                                  ? '~5min'
                                                                  : '10-30min'
                                                      const isEdge = src === 'edge' || src === 'metar'
                                                      return (
                                                        <span
                                                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ml-2 ${
                                                            isEdge
                                                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                              : 'bg-gray-600/30 text-gray-400 border border-gray-500/20'
                                                          }`}
                                                        >
                                                          {sourceLabel} ({latency})
                                                        </span>
                                                      )
                                                    })()}
                                                  </span>
                                                )}
                                              </>
                                            )}
                                            <a
                                              href={
                                                hasHko
                                                  ? 'https://www.hko.gov.hk/en/cis/dailyExtract.htm'
                                                  : `https://aviationweather.gov/data/metar/?id=${c.station}`
                                              }
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="ml-auto inline-flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300 transition-colors"
                                            >
                                              {hasHko ? 'HKO Daily Extract' : 'METAR Proof'}
                                            </a>
                                          </div>
                                          <div className="h-[160px] w-full">
                                            <ResponsiveContainer width="100%" height="100%">
                                              <AreaChart
                                                data={merged}
                                                margin={{ top: 8, right: 12, bottom: 0, left: 4 }}
                                              >
                                                <defs>
                                                  <linearGradient id={`tempGrad-${c.city}`} x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                                                  </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                                                <XAxis
                                                  dataKey="time"
                                                  tick={{ fill: '#6b7280', fontSize: 10 }}
                                                  axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                                                  tickLine={false}
                                                  interval="preserveStartEnd"
                                                />
                                                <YAxis
                                                  tick={{ fill: '#6b7280', fontSize: 10 }}
                                                  axisLine={false}
                                                  tickLine={false}
                                                  domain={[
                                                    'dataMin - 1',
                                                    hasHko && c.hkoRunningMax !== null && c.hkoRunningMax !== undefined
                                                      ? (dataMax: number) =>
                                                          Math.max(dataMax + 1, c.hkoRunningMax! + 0.5)
                                                      : 'dataMax + 1',
                                                  ]}
                                                  width={46}
                                                  tickFormatter={(v: number) => v.toFixed(2)}
                                                />
                                                <RechartsTooltip
                                                  contentStyle={{
                                                    background: 'rgba(0,0,0,0.92)',
                                                    border: '1px solid rgba(255,255,255,0.15)',
                                                    borderRadius: '10px',
                                                    fontSize: '12px',
                                                    padding: '8px 12px',
                                                  }}
                                                  labelStyle={{ color: '#9ca3af', fontWeight: 600 }}
                                                  content={({ active, payload, label: tooltipLabel }) => {
                                                    if (!active || !payload?.length) return null
                                                    const dataPoint = payload[0]?.payload as Record<string, unknown>
                                                    const src = (dataPoint?.asosSource as string) || 'nws'
                                                    const isIntlCity = c.unit === 'C'
                                                    const srcInfo: Record<
                                                      string,
                                                      { emoji: string; name: string; latency: string }
                                                    > = {
                                                      edge: {
                                                        emoji: isIntlCity ? '✈' : '',
                                                        name: isIntlCity ? 'METAR' : 'EDGE',
                                                        latency: isIntlCity ? '~10 min' : '2-5 min',
                                                      },
                                                      phone: { emoji: '', name: 'PHONE', latency: '0 sec' },
                                                      metar: {
                                                        emoji: '✈',
                                                        name: 'METAR',
                                                        latency: isIntlCity ? '~10 min' : '3-8 min',
                                                      },
                                                      v3: { emoji: '', name: 'V3', latency: '10-30 min' },
                                                      nws: { emoji: '', name: 'NWS', latency: '15-20 min' },
                                                    }
                                                    const si = srcInfo[src] || srcInfo.nws
                                                    const isFast = src === 'phone' || src === 'edge' || src === 'metar'

                                                    return (
                                                      <div
                                                        style={{
                                                          background: 'rgba(0,0,0,0.92)',
                                                          border: '1px solid rgba(255,255,255,0.15)',
                                                          borderRadius: '10px',
                                                          padding: '8px 12px',
                                                          fontSize: '12px',
                                                        }}
                                                      >
                                                        <div
                                                          style={{
                                                            color: '#9ca3af',
                                                            fontWeight: 600,
                                                            marginBottom: 4,
                                                          }}
                                                        >
                                                          {tooltipLabel as string}
                                                        </div>
                                                        {payload.map((entry, i) => {
                                                          if (entry.value === null || entry.value === undefined)
                                                            return null
                                                          const nm = entry.name as string
                                                          const prec = (dataPoint?.asosPrecision as string) || ''
                                                          const lbl =
                                                            nm === 'hko'
                                                              ? 'HKO Observatory'
                                                              : nm === 'wu'
                                                                ? hasHko
                                                                  ? 'WU (VHHH)'
                                                                  : 'WU Station'
                                                                : nm === 'metar'
                                                                  ? hasHko
                                                                    ? 'VHHH Airport'
                                                                    : 'METAR'
                                                                  : nm === 'asos'
                                                                    ? prec === 'tgroup'
                                                                      ? 'ASOS T-group'
                                                                      : 'ASOS (body)'
                                                                    : nm
                                                          return (
                                                            <div key={i} style={{ color: entry.color as string }}>
                                                              {lbl}:{' '}
                                                              {typeof entry.value === 'number'
                                                                ? entry.value.toFixed(2)
                                                                : entry.value}
                                                              {c.unit === 'F' ? '°F' : '°C'}
                                                            </div>
                                                          )
                                                        })}
                                                        {/* HKO source badge for Hong Kong */}
                                                        {hasHko &&
                                                          dataPoint?.hko !== null &&
                                                          dataPoint?.hko !== undefined && (
                                                            <div
                                                              style={{
                                                                marginTop: 6,
                                                                paddingTop: 5,
                                                                borderTop: '1px solid rgba(255,255,255,0.1)',
                                                                fontSize: '11px',
                                                              }}
                                                            >
                                                              <div style={{ color: '#34d399', fontWeight: 700 }}>
                                                                HKO Observatory (~1 min)
                                                              </div>
                                                            </div>
                                                          )}
                                                        {/* ASOS source badge for non-HK cities */}
                                                        {!hasHko &&
                                                          dataPoint?.asos !== null &&
                                                          dataPoint?.asos !== undefined && (
                                                            <div
                                                              style={{
                                                                marginTop: 6,
                                                                paddingTop: 5,
                                                                borderTop: '1px solid rgba(255,255,255,0.1)',
                                                                fontSize: '11px',
                                                              }}
                                                            >
                                                              <div
                                                                style={{
                                                                  color: isFast ? '#34d399' : '#9ca3af',
                                                                  fontWeight: 700,
                                                                }}
                                                              >
                                                                {si.emoji} {si.name} ({si.latency})
                                                              </div>
                                                            </div>
                                                          )}
                                                      </div>
                                                    )
                                                  }}
                                                />
                                                {/* HKO Observatory — PRIMARY line for Hong Kong (emerald, resolution source) */}
                                                {hasHko && (
                                                  <>
                                                    <defs>
                                                      <linearGradient
                                                        id={`hkoGrad-${c.city}`}
                                                        x1="0"
                                                        y1="0"
                                                        x2="0"
                                                        y2="1"
                                                      >
                                                        <stop offset="5%" stopColor="#34d399" stopOpacity={0.35} />
                                                        <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                                                      </linearGradient>
                                                    </defs>
                                                    <Area
                                                      type="monotone"
                                                      dataKey="hko"
                                                      stroke="#34d399"
                                                      strokeWidth={2.5}
                                                      fill={`url(#hkoGrad-${c.city})`}
                                                      dot={false}
                                                      activeDot={{
                                                        r: 4,
                                                        fill: '#34d399',
                                                        stroke: '#fff',
                                                        strokeWidth: 1,
                                                      }}
                                                      connectNulls
                                                      name="hko"
                                                    />
                                                  </>
                                                )}
                                                {/* HKO running daily max — horizontal reference line */}
                                                {hasHko &&
                                                  c.hkoRunningMax !== null &&
                                                  c.hkoRunningMax !== undefined && (
                                                    <ReferenceLine
                                                      y={c.hkoRunningMax}
                                                      stroke="#f59e0b"
                                                      strokeDasharray="8 4"
                                                      strokeWidth={2}
                                                      strokeOpacity={0.8}
                                                      label={{
                                                        value: `HIGH ${c.hkoRunningMax.toFixed(1)}°C (Bucket: ${Math.round(c.hkoRunningMax)}°C)`,
                                                        position: 'insideTopRight',
                                                        fill: '#f59e0b',
                                                        fontSize: 11,
                                                        fontWeight: 700,
                                                      }}
                                                    />
                                                  )}
                                                {/* WU Station — HIDDEN for HK (VHHH is irrelevant), shown for other cities */}
                                                {!hasHko && (
                                                  <Area
                                                    type="monotone"
                                                    dataKey="wu"
                                                    stroke="#f59e0b"
                                                    strokeWidth={2}
                                                    fill={`url(#tempGrad-${c.city})`}
                                                    dot={false}
                                                    activeDot={{ r: 3, fill: '#f59e0b', stroke: '#000' }}
                                                    connectNulls
                                                    name="wu"
                                                  />
                                                )}
                                                {/* METAR Aviation — HIDDEN for HK (VHHH is irrelevant), shown for other cities */}
                                                {hasMetar && !hasHko && (
                                                  <Area
                                                    type="monotone"
                                                    dataKey="metar"
                                                    stroke="#38bdf8"
                                                    strokeWidth={2}
                                                    fill="#38bdf8"
                                                    fillOpacity={0.15}
                                                    dot={false}
                                                    activeDot={{ r: 3, fill: '#38bdf8', stroke: '#000' }}
                                                    connectNulls
                                                    name="metar"
                                                  />
                                                )}
                                                {/* ASOS/METAR fast source — hidden for HK (redundant with HKO), shown for other cities */}
                                                {hasAsos && !hasHko && (
                                                  <Area
                                                    type="monotone"
                                                    dataKey="asos"
                                                    stroke="#ec4899"
                                                    strokeWidth={2.5}
                                                    fill="#ec4899"
                                                    fillOpacity={0.08}
                                                    dot={false}
                                                    activeDot={{
                                                      r: 4,
                                                      fill: '#ec4899',
                                                      stroke: '#fff',
                                                      strokeWidth: 1,
                                                    }}
                                                    connectNulls
                                                    name="asos"
                                                  />
                                                )}
                                              </AreaChart>
                                            </ResponsiveContainer>
                                          </div>
                                          {hasHko ? (
                                            <div className="text-[10px] text-emerald-400/70 mt-1">
                                              HKO Observatory (Tsim Sha Tsui) — Polymarket resolution source. VHHH
                                              airport (dashed) is 25km away, reads ~0.5°C higher.
                                              {c.hkoTimeline && c.hkoTimeline.length > 0 && (
                                                <span className="text-emerald-300 ml-1">
                                                  ({c.hkoTimeline.length} readings today)
                                                </span>
                                              )}
                                            </div>
                                          ) : (
                                            (c.metarHigh !== null || c.metarCurrent !== null) && (
                                              <div className="text-[10px] text-sky-400/70 mt-1">
                                                METAR:{' '}
                                                {c.metarCurrent !== null && (
                                                  <span>
                                                    now{' '}
                                                    {typeof c.metarCurrent === 'number'
                                                      ? c.metarCurrent.toFixed(1)
                                                      : c.metarCurrent}
                                                    °{c.unit}
                                                  </span>
                                                )}
                                                {c.metarCurrent !== null && c.metarHigh !== null && ' · '}
                                                {c.metarHigh !== null && (
                                                  <span>
                                                    high{' '}
                                                    {typeof c.metarHigh === 'number'
                                                      ? c.metarHigh.toFixed(1)
                                                      : c.metarHigh}
                                                    °{c.unit}
                                                  </span>
                                                )}{' '}
                                                — station {c.station}, arrives 1-2hr faster than WU
                                              </div>
                                            )
                                          )}
                                        </div>
                                      )
                                    })()}
                                  {/* ─── AI Prediction v2 ─── */}
                                  {/* v3.100.5: panel renders on BOTH /brain/trading and /brain/trading-preview.
                                      On preview, two sub-sections inside the panel are hidden because they
                                      duplicate what LiveBucketStrip already shows above:
                                        (a) the Obs/Peak/Hours/All-Models metadata row
                                        (b) the BUCKET | PM YES | PM NO | STATUS | EDGE | RECOMMENDATION table
                                      The waterfall adjustment pills, ensemble number, method label, bucket
                                      probability bar, tempPath chart, and recommendation text all STAY on
                                      both routes. Live /brain/trading renders identically to pre-v3.100.3. */}
                                  {c.jarvisPrediction &&
                                    (() => {
                                      const jp = c.jarvisPrediction
                                      const rangeLo = Math.round(jp.prediction - jp.standardDeviation)
                                      const rangeHi = Math.round(jp.prediction + jp.standardDeviation)
                                      // Best bucket = highest probability
                                      const bestBucket = Object.entries(jp.bucketProbabilities).sort(
                                        (a, b) => b[1] - a[1],
                                      )[0]
                                      const bestEdge = jp.marketEdge
                                        .filter((e) => e.edge > 0.03)
                                        .sort((a, b) => b.edge - a.edge)[0]
                                      return (
                                        <div className="mb-4 bg-gradient-to-r from-purple-500/[0.06] to-cyan-500/[0.06] border border-purple-500/20 rounded-lg p-3">
                                          <div className="flex items-center gap-2 mb-2">
                                            <span className="text-[10px] text-purple-400 uppercase tracking-wider font-bold">
                                              AI Prediction
                                            </span>
                                            <span
                                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                                jp.confidence >= 70
                                                  ? 'bg-emerald-500/20 text-emerald-400'
                                                  : jp.confidence >= 40
                                                    ? 'bg-amber-500/20 text-amber-400'
                                                    : 'bg-red-500/20 text-red-400'
                                              }`}
                                            >
                                              {jp.confidence}% conf
                                            </span>
                                            <span
                                              className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                                jp.method === 'CONFIRMED'
                                                  ? 'bg-green-500/20 text-green-400'
                                                  : jp.method === 'TRAJECTORY'
                                                    ? 'bg-blue-500/20 text-blue-400'
                                                    : jp.method === 'BLEND'
                                                      ? 'bg-purple-500/20 text-purple-400'
                                                      : 'bg-gray-500/20 text-gray-400'
                                              }`}
                                            >
                                              {jp.method}
                                            </span>
                                          </div>
                                          <div className="flex items-baseline gap-3 mb-2">
                                            <span className="text-2xl font-black text-white">
                                              {jp.prediction.toFixed(1)}
                                              {unitLabel}
                                            </span>
                                            <span className="text-xs text-gray-400">
                                              range: {rangeLo} to {rangeHi}
                                              {unitLabel}
                                            </span>
                                            {bestBucket && (
                                              <span className="text-xs text-purple-400 font-bold">
                                                Best bucket: {bestBucket[0]}
                                              </span>
                                            )}
                                          </div>
                                          {/* Adjustment waterfall pills */}
                                          {(() => {
                                            const trajectoryApplied =
                                              jp.method === 'TRAJECTORY' || jp.method === 'BLEND'
                                            const adjs = [
                                              {
                                                factor: c.wxPhrase || 'Weather',
                                                adjustment: jp.adjustments.conditionBias,
                                              },
                                              {
                                                factor: `${c.windDirection || ''} wind`,
                                                adjustment: jp.adjustments.windAdj,
                                              },
                                              { factor: 'Pressure', adjustment: jp.adjustments.pressureAdj },
                                              { factor: 'Humidity', adjustment: jp.adjustments.humidityAdj },
                                              {
                                                factor: 'Bias correction',
                                                adjustment: jp.adjustments.biasCorrection,
                                              },
                                              // Trajectory only included when the engine actually applies it
                                              // (TRAJECTORY or BLEND methods). In CONFIRMED/ENSEMBLE modes the
                                              // trajectoryAdj field is bookkeeping and should not appear as a pill.
                                              ...(trajectoryApplied
                                                ? [
                                                    {
                                                      factor: 'Trajectory',
                                                      adjustment: jp.adjustments.trajectoryAdj,
                                                    },
                                                  ]
                                                : []),
                                              { factor: 'Market signal', adjustment: jp.adjustments.marketSignal },
                                              { factor: 'V1 Floor', adjustment: jp.adjustments.v1Floor },
                                            ].filter((a) => Math.abs(a.adjustment) >= 0.05)
                                            return (
                                              adjs.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mb-2">
                                                  {adjs.map((adj, i) => (
                                                    <span
                                                      key={i}
                                                      className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                                                        adj.adjustment > 0
                                                          ? 'bg-red-500/15 text-red-400'
                                                          : 'bg-blue-500/15 text-blue-400'
                                                      }`}
                                                    >
                                                      {adj.factor}: {adj.adjustment > 0 ? '+' : ''}
                                                      {adj.adjustment.toFixed(2)}°
                                                    </span>
                                                  ))}
                                                </div>
                                              )
                                            )
                                          })()}
                                          {/* Bucket probabilities bar */}
                                          <div className="flex gap-[1px] h-5 rounded overflow-hidden mb-1">
                                            {Object.entries(jp.bucketProbabilities)
                                              .sort((a, b) => b[1] - a[1])
                                              .slice(0, 5)
                                              .map(([bucket, prob]) => (
                                                <div
                                                  key={bucket}
                                                  className="relative group"
                                                  style={{ width: `${Math.max(prob * 100, 8)}%` }}
                                                >
                                                  <div
                                                    className={`h-full ${
                                                      bestBucket && bucket === bestBucket[0]
                                                        ? 'bg-purple-500/40'
                                                        : 'bg-white/10'
                                                    }`}
                                                  />
                                                  <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white font-bold">
                                                    {bucket}: {(prob * 100).toFixed(0)}%
                                                  </span>
                                                </div>
                                              ))}
                                          </div>
                                          {/* Ensemble + conditions summary */}
                                          <div className="text-[10px] text-gray-400 mt-1">
                                            Ensemble: {jp.adjustments.ensembleRaw.toFixed(1)}° | Std: ±
                                            {jp.standardDeviation.toFixed(1)}°{c.wxPhrase && ` | ${c.wxPhrase}`}
                                            {c.windSpeed !== null &&
                                              c.windSpeed !== undefined &&
                                              `, ${c.windDirection || ''} wind ${c.windSpeed}mph`}
                                            {c.pressureTrend && `, pressure ${c.pressureTrend.toLowerCase()}`}
                                          </div>
                                          {/* Best trade recommendation */}
                                          {bestEdge && (
                                            <div className="text-[10px] text-purple-400/80 mt-1 font-medium">
                                              High ~{jp.prediction.toFixed(1)}
                                              {unitLabel}. Best play: {bestEdge.bucket} {bestEdge.side} @{' '}
                                              {Math.round(bestEdge.marketProb * 100)}c (
                                              {(bestEdge.ourProb * 100).toFixed(0)}% win prob,{' '}
                                              {bestEdge.edge > 0 ? '+' : ''}
                                              {(bestEdge.edge * 100).toFixed(0)}% edge over market)
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })()}
                                  {/* ─── Temperature Path Predictor ─── */}
                                  {c.tempPath && c.tempPath.closestBuckets.length > 0 && (
                                    <div className="mb-4 bg-white/[0.03] border border-white/10 rounded-lg p-3">
                                      <div className="flex items-center gap-2 mb-2">
                                        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">
                                          Historical Daily High Prediction
                                        </span>
                                        {c.tempPath.predictedBucket && c.tempPath.confidence && (
                                          <span
                                            title={
                                              c.tempPath.confidence === 'HIGH'
                                                ? 'Strong match: current temp closely matches historical pattern for this daily high (within 2°)'
                                                : c.tempPath.confidence === 'MEDIUM'
                                                  ? 'Moderate match: current temp is close to historical pattern (within 3°)'
                                                  : "Weak match: current temp doesn't closely match any historical pattern (>3° off)"
                                            }
                                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded cursor-help ${
                                              c.tempPath.confidence === 'HIGH'
                                                ? 'bg-emerald-500/20 text-emerald-400'
                                                : c.tempPath.confidence === 'MEDIUM'
                                                  ? 'bg-amber-500/20 text-amber-400'
                                                  : 'bg-red-500/20 text-red-400'
                                            }`}
                                          >
                                            {c.tempPath.confidence}
                                          </span>
                                        )}
                                      </div>
                                      {/* Explanation text */}
                                      <div className="text-[10px] text-gray-500 mb-2 leading-relaxed">
                                        Based on 2 years of WU data (731 days): &quot;On days that ended at X° high,
                                        what was the temp at this hour?&quot;
                                        {c.tempPath.confidence === 'HIGH' &&
                                          ' Current temp closely matches a historical pattern.'}
                                        {c.tempPath.confidence === 'LOW' &&
                                          " Current temp doesn't match any pattern well — prediction is unreliable."}
                                      </div>
                                      <div className="text-xs text-gray-400 mb-2">
                                        Now:{' '}
                                        <span className="text-white font-medium">
                                          {c.tempPath.currentTemp !== null
                                            ? `${c.tempPath.currentTemp}°${c.unit}`
                                            : '—'}
                                        </span>
                                        {c.tempPath.currentHour !== null && (
                                          <>
                                            {' '}
                                            at{' '}
                                            <span className="text-white font-medium">
                                              {c.tempPath.currentHour > 12
                                                ? `${c.tempPath.currentHour - 12}:00 PM`
                                                : c.tempPath.currentHour === 12
                                                  ? '12:00 PM'
                                                  : c.tempPath.currentHour === 0
                                                    ? '12:00 AM'
                                                    : `${c.tempPath.currentHour}:00 AM`}
                                            </span>
                                          </>
                                        )}
                                        {c.tempPath.predictedBucket && (
                                          <>
                                            {' '}
                                            → Predicted daily high:{' '}
                                            <span className="text-cyan-400 font-bold">
                                              {c.tempPath.predictedBucket}
                                            </span>
                                            <span className="text-gray-500 ml-1">
                                              (closest historical match to current temp at this hour)
                                            </span>
                                          </>
                                        )}
                                      </div>
                                      {/* ─── Hourly Trend Chart: historical avg paths for top buckets ─── */}
                                      {c.tempPath!.hours &&
                                        c.tempPath!.closestBuckets.some(
                                          (b) => Object.keys(b.hourlyAvg || {}).length > 2,
                                        ) && (
                                          <div className="mb-3">
                                            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1">
                                              Historical hourly temps — each line shows what temp looked like throughout
                                              the day when the high ended at that value
                                            </div>
                                            <div className="h-[130px] w-full">
                                              <ResponsiveContainer width="100%" height="100%">
                                                <LineChart
                                                  data={c.tempPath!.hours.map((h) => {
                                                    const point: Record<string, unknown> = {
                                                      hour:
                                                        h <= 12
                                                          ? `${h === 0 ? 12 : h}${h < 12 ? 'a' : 'p'}`
                                                          : `${h - 12}p`,
                                                    }
                                                    c.tempPath!.closestBuckets.slice(0, 3).forEach((b) => {
                                                      point[b.label] = b.hourlyAvg?.[h] ?? null
                                                    })
                                                    return point
                                                  })}
                                                  margin={{ top: 4, right: 8, bottom: 0, left: 4 }}
                                                >
                                                  <CartesianGrid
                                                    strokeDasharray="3 3"
                                                    stroke="rgba(255,255,255,0.04)"
                                                  />
                                                  <XAxis
                                                    dataKey="hour"
                                                    tick={{ fill: '#6b7280', fontSize: 9 }}
                                                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                                                    tickLine={false}
                                                    interval={2}
                                                  />
                                                  <YAxis
                                                    tick={{ fill: '#6b7280', fontSize: 9 }}
                                                    axisLine={false}
                                                    tickLine={false}
                                                    domain={['dataMin - 2', 'dataMax + 2']}
                                                    width={28}
                                                  />
                                                  <RechartsTooltip
                                                    contentStyle={{
                                                      background: 'rgba(0,0,0,0.85)',
                                                      border: '1px solid rgba(255,255,255,0.1)',
                                                      borderRadius: '8px',
                                                      fontSize: '11px',
                                                    }}
                                                    labelStyle={{ color: '#9ca3af' }}
                                                  />
                                                  {/* Current temp horizontal line */}
                                                  {c.tempPath!.currentTemp !== null && (
                                                    <ReferenceLine
                                                      y={c.tempPath!.currentTemp}
                                                      stroke="#f59e0b"
                                                      strokeDasharray="4 4"
                                                      strokeWidth={1}
                                                      label={{
                                                        value: `Now ${c.tempPath!.currentTemp}°`,
                                                        position: 'right',
                                                        fill: '#f59e0b',
                                                        fontSize: 9,
                                                      }}
                                                    />
                                                  )}
                                                  {/* Top 3 bucket paths */}
                                                  {c.tempPath!.closestBuckets.slice(0, 3).map((b, i) => (
                                                    <Line
                                                      key={b.label}
                                                      type="monotone"
                                                      dataKey={b.label}
                                                      name={`${b.label} (${b.days}d)`}
                                                      stroke={i === 0 ? '#10b981' : i === 1 ? '#06b6d4' : '#8b5cf6'}
                                                      strokeWidth={i === 0 ? 2 : 1.5}
                                                      strokeDasharray={i === 0 ? undefined : '4 3'}
                                                      dot={false}
                                                      connectNulls
                                                    />
                                                  ))}
                                                </LineChart>
                                              </ResponsiveContainer>
                                            </div>
                                            {/* Legend */}
                                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 px-1">
                                              {c.tempPath!.closestBuckets.slice(0, 3).map((b, i) => (
                                                <div key={b.label} className="flex items-center gap-1.5">
                                                  <div
                                                    className="h-[2px] w-4"
                                                    style={{
                                                      backgroundColor:
                                                        i === 0 ? '#10b981' : i === 1 ? '#06b6d4' : '#8b5cf6',
                                                      ...(i > 0
                                                        ? {
                                                            backgroundImage:
                                                              'repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(0,0,0,0.8) 3px, rgba(0,0,0,0.8) 6px)',
                                                          }
                                                        : {}),
                                                    }}
                                                  />
                                                  <span className="text-[9px] text-gray-400">
                                                    <span
                                                      style={{
                                                        color: i === 0 ? '#10b981' : i === 1 ? '#06b6d4' : '#8b5cf6',
                                                      }}
                                                      className="font-medium"
                                                    >
                                                      {b.label}
                                                    </span>{' '}
                                                    high ({b.days}d){i === 0 ? ' — best match' : ''}
                                                  </span>
                                                </div>
                                              ))}
                                              {c.tempPath!.currentTemp !== null && (
                                                <div className="flex items-center gap-1.5">
                                                  <div
                                                    className="h-[2px] w-4"
                                                    style={{
                                                      backgroundColor: '#f59e0b',
                                                      backgroundImage:
                                                        'repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(0,0,0,0.8) 2px, rgba(0,0,0,0.8) 4px)',
                                                    }}
                                                  />
                                                  <span className="text-[9px] text-gray-400">
                                                    <span style={{ color: '#f59e0b' }} className="font-medium">
                                                      Current temp
                                                    </span>{' '}
                                                    ({c.tempPath!.currentTemp}°{c.unit})
                                                  </span>
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                        )}

                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="text-gray-500 uppercase tracking-wider">
                                            <th
                                              className="text-left pb-1 pr-3"
                                              title="Possible daily high bucket from Polymarket"
                                            >
                                              Daily High
                                            </th>
                                            <th
                                              className="text-right pb-1 pr-3"
                                              title="Number of days in the last 2 years that ended at this daily high"
                                            >
                                              Days Seen
                                            </th>
                                            <th
                                              className="text-right pb-1 pr-3"
                                              title="On those days, what was the average temp at the current hour?"
                                            >
                                              Hist Avg@
                                              {c.tempPath.currentHour !== null
                                                ? `${c.tempPath.currentHour > 12 ? c.tempPath.currentHour - 12 : c.tempPath.currentHour}${c.tempPath.currentHour >= 12 ? 'PM' : 'AM'}`
                                                : '—'}
                                            </th>
                                            <th
                                              className="text-right pb-1 pr-3"
                                              title="Difference between current temp and the historical avg at this hour. Closer to 0 = better match."
                                            >
                                              Delta
                                            </th>
                                            <th
                                              className="text-left pb-1"
                                              title="MATCH = current temp is within ±2° of the historical avg"
                                            >
                                              Match
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {c.tempPath.closestBuckets.map((b, i) => (
                                            <tr
                                              key={i}
                                              className={`border-t border-white/[0.04] ${b.isMatch ? 'bg-emerald-500/10' : ''}`}
                                            >
                                              <td className="py-1 pr-3 font-mono text-gray-200">{b.label}</td>
                                              <td className="py-1 pr-3 text-right font-mono text-gray-400">{b.days}</td>
                                              <td className="py-1 pr-3 text-right font-mono text-gray-300">
                                                {b.avgAtCurrentHour !== null ? `${b.avgAtCurrentHour}°` : '—'}
                                              </td>
                                              <td
                                                className={`py-1 pr-3 text-right font-mono font-bold ${
                                                  Math.abs(b.delta) < 2
                                                    ? 'text-emerald-400'
                                                    : Math.abs(b.delta) < 3
                                                      ? 'text-yellow-400'
                                                      : 'text-gray-500'
                                                }`}
                                              >
                                                {b.delta > 0 ? '+' : ''}
                                                {b.delta}°
                                              </td>
                                              <td className="py-1 text-left">
                                                {b.isMatch ? (
                                                  <span className="text-emerald-400 font-bold">← MATCH</span>
                                                ) : Math.abs(b.delta) < 3 ? (
                                                  <span className="text-yellow-500">close</span>
                                                ) : null}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      {/* Spread play suggestion */}
                                      {(() => {
                                        const matches = c.tempPath!.closestBuckets.filter((b) => Math.abs(b.delta) < 3)
                                        if (matches.length >= 2) {
                                          // Check if primary bucket has a 4x+ multiplier in activeBuckets
                                          const primaryLabel = matches[0].label
                                          const primaryBucket = c.activeBuckets.find((ab) =>
                                            ab.label
                                              .replace('°F', '')
                                              .replace('°C', '')
                                              .includes(primaryLabel.replace('≤', '').replace('≥', '')),
                                          )
                                          const multiplier = primaryBucket ? 1 / primaryBucket.yesPrice : 0
                                          if (multiplier >= 4) {
                                            return (
                                              <div className="mt-2 pt-2 border-t border-white/[0.06] text-xs text-amber-400">
                                                Spread play: $15 on{' '}
                                                <span className="font-bold">{matches[0].label}</span> (
                                                {multiplier.toFixed(1)}x)
                                                {' + '}$10 on <span className="font-bold">{matches[1].label}</span>{' '}
                                                (hedge)
                                              </div>
                                            )
                                          }
                                        }
                                        return null
                                      })()}
                                    </div>
                                  )}

                                  {/* v3.100.5: metadata row — hidden on /brain/trading-preview because
                                      LiveBucketStrip's header already shows Obs / Peak / Hours / All-Models.
                                      Stays on live /brain/trading. */}
                                  {!isUnifiedPreview && (
                                    <div className="flex items-center gap-5 mb-3 text-xs text-gray-400">
                                      <span>
                                        Obs: <span className="text-white font-medium">{c.obsCount}</span>
                                      </span>
                                      <span>
                                        Peak Hour:{' '}
                                        <span className="text-white font-medium">
                                          {c.peakHourLocal}:{String(c.peakMinuteLocal || 0).padStart(2, '0')}
                                        </span>
                                      </span>
                                      <span>
                                        Hours Since Peak:{' '}
                                        <span className="text-white font-medium">{c.hoursSincePeak.toFixed(1)}h</span>
                                      </span>
                                      {/* v3.99.80 — show today-applicable WR (not historical combo) */}
                                      {c.todayApplicableModel &&
                                      c.todayApplicableWR !== null &&
                                      c.todayApplicableWR !== undefined ? (
                                        <span className="text-cyan-400">
                                          {c.todayApplicableModel} WR:{' '}
                                          <span className="font-bold">{c.todayApplicableWR}%</span>
                                          {c.comboStatus === 'PENDING' &&
                                            c.pendingModels &&
                                            c.pendingModels.length > 0 && (
                                              <span className="ml-1 text-amber-300 text-[10px]">
                                                ⏳ combo pending {c.pendingModels.join(',')}
                                              </span>
                                            )}
                                          {c.comboStatus === 'DISAGREEMENT' && (
                                            <span className="ml-1 text-gray-400 text-[10px]">combo split</span>
                                          )}
                                        </span>
                                      ) : c.bestModelWR ? (
                                        <span className="text-cyan-400">
                                          {c.bestModel} WR: <span className="font-bold">{c.bestModelWR}%</span>
                                        </span>
                                      ) : null}
                                      <span>
                                        All Models:{' '}
                                        <span className="text-gray-300 font-mono">
                                          E:{c.ecmwf?.toFixed(0) ?? '?'} G:{c.gfs?.toFixed(0) ?? '?'} I:
                                          {c.icon?.toFixed(0) ?? '?'} Ge:{c.gem?.toFixed(0) ?? '?'} J:
                                          {c.jma?.toFixed(0) ?? '?'}
                                        </span>
                                      </span>
                                    </div>
                                  )}
                                  {/* v3.100.5: BUCKET | PM YES | PM NO | STATUS | EDGE | RECOMMENDATION table
                                      hidden on /brain/trading-preview because LiveBucketStrip is the bucket
                                      view there. Stays on live /brain/trading. */}
                                  {!isUnifiedPreview && (
                                    <table className="w-full">
                                      <thead>
                                        <tr className="text-gray-500 text-xs uppercase tracking-wider">
                                          <th className="text-left pb-2 pr-4">Bucket</th>
                                          <th className="text-right pb-2 pr-4">
                                            <span className="text-purple-400">PM</span> YES
                                          </th>
                                          <th className="text-right pb-2 pr-4">
                                            <span className="text-purple-400">PM</span> NO
                                          </th>
                                          <th className="text-center pb-2 pr-4">Status</th>
                                          <th className="text-right pb-2 pr-4">Edge</th>
                                          <th className="text-left pb-2">Recommendation</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {c.activeBuckets.map((b, bi) => {
                                          const statusColor =
                                            b.status === 'CONFIRMED_YES'
                                              ? 'text-green-400 bg-green-500/15'
                                              : b.status === 'FADE_LOCK'
                                                ? 'text-amber-400 bg-amber-500/15'
                                                : b.status === 'DEAD'
                                                  ? 'text-red-400 bg-red-500/10 line-through opacity-50'
                                                  : 'text-gray-400'
                                          const rowOpacity = b.status === 'DEAD' ? 'opacity-40' : ''
                                          const recTextColor = b.recommendation.includes('BUY')
                                            ? 'text-green-400'
                                            : b.recommendation.includes('WATCH')
                                              ? 'text-yellow-400'
                                              : b.recommendation.includes('DEAD')
                                                ? 'text-red-500'
                                                : 'text-gray-500'

                                          return (
                                            <tr key={bi} className={`border-t border-white/[0.04] ${rowOpacity}`}>
                                              <td className="py-2 pr-4 text-sm font-mono text-gray-200">{b.label}</td>
                                              <td className="py-2 pr-4 text-right text-sm font-mono text-gray-300">
                                                {(b.yesPrice * 100).toFixed(0)}¢
                                              </td>
                                              <td className="py-2 pr-4 text-right text-sm font-mono text-gray-300">
                                                {(b.noPrice * 100).toFixed(0)}¢
                                              </td>
                                              <td className="py-2 pr-4 text-center">
                                                <span
                                                  className={`text-xs font-bold px-2 py-0.5 rounded ${statusColor}`}
                                                >
                                                  {b.status === 'CONFIRMED_YES'
                                                    ? 'CONFIRMED'
                                                    : b.status === 'FADE_LOCK'
                                                      ? 'FADE LOCK'
                                                      : b.status}
                                                </span>
                                              </td>
                                              <td className="py-2 pr-4 text-right text-sm font-mono">
                                                <span
                                                  className={
                                                    b.edge !== null && b.edge > 0.05
                                                      ? 'text-green-400 font-bold'
                                                      : 'text-gray-500'
                                                  }
                                                >
                                                  {b.edge !== null ? `${(b.edge * 100).toFixed(0)}%` : '—'}
                                                </span>
                                              </td>
                                              <td className={`py-2 text-sm font-mono ${recTextColor}`}>
                                                {b.recommendation}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  )}
                                  {/* ─── Model Intelligence ─── */}
                                  <div className="mt-3 rounded-md bg-cyan-500/[0.04] border border-cyan-500/20 px-3 py-2.5">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">
                                        Model Intelligence
                                      </span>
                                      <span className="text-[9px] text-gray-500">
                                        {(() => {
                                          // v3.82.0: Count all models reporting (up to 25 across globals + regionals).
                                          // Prefer c.allModels (wide map) when available; fall back to legacy named fields.
                                          const allM = (c as unknown as { allModels?: Record<string, number | null> })
                                            .allModels
                                          if (allM) {
                                            const count = Object.values(allM).filter(
                                              (v) => v !== null && v !== undefined,
                                            ).length
                                            return `${count} models reporting`
                                          }
                                          const models = [
                                            c.gfs,
                                            c.ecmwf,
                                            c.icon,
                                            c.gem,
                                            c.jma,
                                            c.ukmo,
                                            c.meteofrance,
                                            c.knmi,
                                            c.cma,
                                          ].filter((v) => v !== null && v !== undefined)
                                          return `${models.length} models reporting`
                                        })()}
                                      </span>
                                    </div>
                                    <table className="w-full">
                                      <thead>
                                        <tr className="text-gray-500 text-[10px] uppercase tracking-wider">
                                          <th className="text-left pb-1.5 pr-4">Model</th>
                                          <th className="text-right pb-1.5 pr-4">
                                            {new Date().toLocaleDateString('en-US', {
                                              month: 'short',
                                              day: 'numeric',
                                              timeZone: c.timezone || 'America/Puerto_Rico',
                                            })}{' '}
                                            High
                                          </th>
                                          <th className="text-right pb-1.5 pr-4">
                                            {new Date(Date.now() + 86400000).toLocaleDateString('en-US', {
                                              month: 'short',
                                              day: 'numeric',
                                              timeZone: c.timezone || 'America/Puerto_Rico',
                                            })}{' '}
                                            High
                                          </th>
                                          <th className="text-right pb-1.5 pr-6">
                                            {new Date(Date.now() + 86400000).toLocaleDateString('en-US', {
                                              month: 'short',
                                              day: 'numeric',
                                              timeZone: c.timezone || 'America/Puerto_Rico',
                                            })}{' '}
                                            vs{' '}
                                            {new Date().toLocaleDateString('en-US', {
                                              month: 'short',
                                              day: 'numeric',
                                              timeZone: c.timezone || 'America/Puerto_Rico',
                                            })}
                                          </th>
                                          <th className="text-left pb-1.5 pr-4">Data Freshness</th>
                                          <th
                                            className="text-right pb-1.5"
                                            title="Win rate against WU V1 daily-max (Polymarket resolution source)"
                                          >
                                            WU WR
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(() => {
                                          // v3.82.0: Read from c.allModels (25-model map) when available;
                                          // fall back to legacy named fields for backward compat if the API
                                          // response predates v3.82.0.
                                          const allM = (c as unknown as { allModels?: Record<string, number | null> })
                                            .allModels
                                          const mv = (
                                            short: string,
                                            legacy: number | null | undefined,
                                          ): number | null => (allM?.[short] ?? legacy ?? null) as number | null
                                          const miModels = [
                                            // Legacy 9 globals (frozen in ground truth)
                                            { name: 'GFS', val: mv('gfs', c.gfs), tmrwKey: 'gfs', wrKey: 'gfs' },
                                            {
                                              name: 'ECMWF',
                                              val: mv('ecmwf', c.ecmwf),
                                              tmrwKey: 'ecmwf',
                                              wrKey: 'ecmwf',
                                            },
                                            { name: 'ICON', val: mv('icon', c.icon), tmrwKey: 'icon', wrKey: 'icon' },
                                            { name: 'GEM', val: mv('gem', c.gem), tmrwKey: 'gem', wrKey: 'gem' },
                                            { name: 'JMA', val: mv('jma', c.jma), tmrwKey: 'jma', wrKey: 'jma' },
                                            { name: 'UKMO', val: mv('ukmo', c.ukmo), tmrwKey: 'ukmo', wrKey: 'ukmo' },
                                            {
                                              name: 'MF',
                                              val: mv('meteofrance', c.meteofrance),
                                              tmrwKey: 'mf',
                                              wrKey: 'meteofrance',
                                            },
                                            { name: 'KNMI', val: mv('knmi', c.knmi), tmrwKey: 'knmi', wrKey: 'knmi' },
                                            { name: 'CMA', val: mv('cma', c.cma), tmrwKey: 'cma', wrKey: 'cma' },
                                            // v3.82.0: 7 new global models
                                            {
                                              name: 'HRRR',
                                              val: mv('gfs_hrrr', null),
                                              tmrwKey: 'gfs_hrrr',
                                              wrKey: 'gfs_hrrr',
                                            },
                                            {
                                              name: 'AIFS',
                                              val: mv('ecmwf_aifs', null),
                                              tmrwKey: 'ecmwf_aifs',
                                              wrKey: 'ecmwf_aifs',
                                            },
                                            {
                                              name: 'HRDPS',
                                              val: mv('gem_hrdps', null),
                                              tmrwKey: 'gem_hrdps',
                                              wrKey: 'gem_hrdps',
                                            },
                                            { name: 'METNO', val: mv('metno', null), tmrwKey: 'metno', wrKey: 'metno' },
                                            { name: 'DMI', val: mv('dmi', null), tmrwKey: 'dmi', wrKey: 'dmi' },
                                            {
                                              name: 'ARPW',
                                              val: mv('arpege_world', null),
                                              tmrwKey: 'arpege_world',
                                              wrKey: 'arpege_world',
                                            },
                                            {
                                              name: 'JGSM',
                                              val: mv('jma_gsm', null),
                                              tmrwKey: 'jma_gsm',
                                              wrKey: 'jma_gsm',
                                            },
                                            // v3.86.0: BOM + GraphCast (were fetched by tomorrowForecast but
                                            // never displayed in the grid because miModels didn't enumerate them)
                                            {
                                              name: 'BOM',
                                              val: mv('bom', null),
                                              tmrwKey: 'bom',
                                              wrKey: 'bom',
                                            },
                                            {
                                              name: 'GCAST',
                                              val: mv('graphcast', null),
                                              tmrwKey: 'graphcast',
                                              wrKey: 'graphcast',
                                            },
                                            // v3.83.1: 9 regional high-res (max 5 chars, single-line)
                                            {
                                              name: 'AROME',
                                              val: mv('arome_fr', null),
                                              tmrwKey: 'arome_fr',
                                              wrKey: 'arome_fr',
                                            },
                                            {
                                              name: 'AMHD',
                                              val: mv('arome_hd', null),
                                              tmrwKey: 'arome_hd',
                                              wrKey: 'arome_hd',
                                            },
                                            {
                                              name: 'ARPE',
                                              val: mv('arpege_eu', null),
                                              tmrwKey: 'arpege_eu',
                                              wrKey: 'arpege_eu',
                                            },
                                            {
                                              name: 'UK2k',
                                              val: mv('ukmo_2km', null),
                                              tmrwKey: 'ukmo_2km',
                                              wrKey: 'ukmo_2km',
                                            },
                                            {
                                              name: 'ICD2',
                                              val: mv('icon_d2', null),
                                              tmrwKey: 'icon_d2',
                                              wrKey: 'icon_d2',
                                            },
                                            {
                                              name: 'ICEU',
                                              val: mv('icon_eu', null),
                                              tmrwKey: 'icon_eu',
                                              wrKey: 'icon_eu',
                                            },
                                            {
                                              name: 'HRNL',
                                              val: mv('harmonie_nl', null),
                                              tmrwKey: 'harmonie_nl',
                                              wrKey: 'harmonie_nl',
                                            },
                                            {
                                              name: 'HREU',
                                              val: mv('harmonie_eu', null),
                                              tmrwKey: 'harmonie_eu',
                                              wrKey: 'harmonie_eu',
                                            },
                                            {
                                              name: 'NORD',
                                              val: mv('metno_nordic', null),
                                              tmrwKey: 'metno_nordic',
                                              wrKey: 'metno_nordic',
                                            },
                                          ].filter((m) => m.val !== null && m.val !== undefined)
                                          // Find top 2 win rate keys for this city to highlight
                                          // v3.85.0: WU-based WRs (Polymarket resolution source)
                                          const wuWRs = (
                                            c as unknown as { perModelWuWinRates?: Record<string, number> }
                                          ).perModelWuWinRates
                                          const cityWuBestModel = (c as unknown as { wuBestModel?: string }).wuBestModel
                                          // v3.99.26 — audit-backed phantom-fallback pairs for this city.
                                          // Pulled from model_independence_audit_v1.json via the API (PR
                                          // for this version). When a model is phantom-child of a parent
                                          // in this city (e.g. gfs_hrrr for Toronto), it must NOT compete
                                          // for BEST — it is literally the parent's forecast re-served.
                                          const phantomPairs =
                                            (
                                              c as unknown as {
                                                phantomFallbackPairs?: Record<string, string>
                                              }
                                            ).phantomFallbackPairs || {}
                                          const wrEntries = miModels
                                            .map((m) => ({
                                              wrKey: m.wrKey,
                                              wr: wuWRs?.[m.wrKey] ?? c.perModelWinRates?.[m.wrKey] ?? 0,
                                              isPhantom: Boolean(phantomPairs[m.wrKey]),
                                            }))
                                            // Phantom rows are eligible to display but NOT eligible to be BEST.
                                            .sort((a, b) => {
                                              if (a.isPhantom !== b.isPhantom) return a.isPhantom ? 1 : -1
                                              return b.wr - a.wr
                                            })
                                          const topWRKeys = new Set(
                                            wrEntries
                                              .filter((e) => !e.isPhantom)
                                              .slice(0, 2)
                                              .map((e) => e.wrKey),
                                          )
                                          const bestWRKey = wrEntries.find((e) => !e.isPhantom)?.wrKey
                                          // v3.99.61 — suppress BEST badge when the leader's Wilson CI is
                                          // not distinguishable from the runner-up (overlap > 50% of leader
                                          // CI width). `effectiveBestWRKey` is null in that case, which
                                          // makes every `m.wrKey === effectiveBestWRKey` check in the map
                                          // body fall through to the non-BEST styling.
                                          const effectiveBestWRKey = (() => {
                                            if (!bestWRKey) return null
                                            const leaderStat = c.perModelWinRateStats?.[bestWRKey]
                                            if (!leaderStat || leaderStat.attempts <= 0) return bestWRKey
                                            const secondKey = wrEntries.find(
                                              (e) => !e.isPhantom && e.wrKey !== bestWRKey,
                                            )?.wrKey
                                            const secondStat = secondKey ? c.perModelWinRateStats?.[secondKey] : null
                                            return bestIsDistinguishable(
                                              leaderStat,
                                              secondStat
                                                ? { hits: secondStat.hits, attempts: secondStat.attempts }
                                                : null,
                                            )
                                              ? bestWRKey
                                              : null
                                          })()
                                          return miModels.map((m) => {
                                            const runInfo = getModelRunInfo(
                                              m.name,
                                              (c as unknown as { perModelUpdatedAt?: Record<string, string> | null })
                                                .perModelUpdatedAt,
                                            )
                                            const tmrw =
                                              m.tmrwKey && c.tomorrowForecast
                                                ? (c.tomorrowForecast as unknown as Record<string, number | null>)[
                                                    m.tmrwKey
                                                  ]
                                                : null
                                            const dayShift =
                                              tmrw !== null && tmrw !== undefined && m.val !== null
                                                ? tmrw - m.val!
                                                : null
                                            const wr = c.perModelWinRates?.[m.wrKey]
                                            const freshnessColor =
                                              runInfo.freshness === 'fresh'
                                                ? 'text-green-400'
                                                : runInfo.freshness === 'aging'
                                                  ? 'text-yellow-500'
                                                  : 'text-gray-500'
                                            const isHighWR = topWRKeys.has(m.wrKey)
                                            // v3.77.11: DB write age — mute the value cell if cron hasn't
                                            // written this model's row in >30min (last-known-good display).
                                            const dbUpdatedAtForMute = c.forecastDeltas?.today?.[m.wrKey]?.updatedAt
                                            const isDbStale = dbUpdatedAtForMute
                                              ? Date.now() - Date.parse(dbUpdatedAtForMute) > 30 * 60 * 1000
                                              : false
                                            return (
                                              <tr
                                                key={m.name}
                                                className={`border-t border-white/[0.04] ${isHighWR ? 'bg-yellow-500/[0.08]' : ''}`}
                                              >
                                                <td className="py-1.5 pr-4">
                                                  <span
                                                    className={`text-[11px] font-bold ${isHighWR ? 'text-yellow-300' : 'text-gray-300'}`}
                                                  >
                                                    {m.name}
                                                  </span>
                                                  {(m.wrKey === effectiveBestWRKey || m.wrKey === cityWuBestModel) && (
                                                    <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-black bg-green-500/20 text-green-400 border border-green-500/30">
                                                      BEST
                                                    </span>
                                                  )}
                                                  {/* v3.99.21 — fallback badge. When OM's short-range or
                                                       regional model is outside its native domain, it falls
                                                       back to the parent global model with IDENTICAL values.
                                                       Dashboard was counting these as phantom independent
                                                       votes (Toronto: gfs=21 + gfs_hrrr=21 counted as 2x).
                                                       Badge makes the fallback visible; consensus math can
                                                       use modelFallbackMap to dedupe. */}
                                                  {(() => {
                                                    const fm = (
                                                      c as unknown as {
                                                        modelFallbackMap?: Record<string, string | null>
                                                      }
                                                    ).modelFallbackMap
                                                    const parent = fm?.[m.wrKey]
                                                    if (!parent) return null
                                                    return (
                                                      <span
                                                        className="ml-1 px-1 py-0.5 rounded text-[8px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/20"
                                                        title={`This model's value is IDENTICAL to ${parent.toUpperCase()} — the short-range/regional model falls back to its parent here (outside native domain). Does not add independent signal.`}
                                                      >
                                                        {parent.toUpperCase()}
                                                      </span>
                                                    )
                                                  })()}
                                                  {/* v3.99.47 — runtime duplicate chip. Same idea as the 
                                                       fallback badge but derived from live per-tick equality
                                                       across today's pulled values (upstream Open-Meteo is
                                                       serving byte-identical data for the pair). Shown at
                                                       reduced opacity so it reads as "dedupe already applied". */}
                                                  {(() => {
                                                    const dup = c.runtimeDuplicateModels?.[m.wrKey]
                                                    if (!dup) return null
                                                    return (
                                                      <span
                                                        className="ml-1 px-1 py-0.5 rounded text-[8px] font-bold bg-white/[0.03] text-gray-400 border border-white/10 opacity-60"
                                                        title={`Today this model's value is byte-identical to ${dup.toUpperCase()} — runtime-detected duplicate. Treated as one vote in consensus.`}
                                                      >
                                                        = {dup.toUpperCase()}
                                                      </span>
                                                    )
                                                  })()}
                                                </td>
                                                <td className="py-1.5 pr-4 text-right">
                                                  {/* v3.77.11: muted styling when DB write is >30min old (last-known-good).
                                                        Value is always shown — never blanked. Muting is the only signal. */}
                                                  <span
                                                    className={`text-[11px] font-mono font-bold ${
                                                      isDbStale ? 'text-gray-400/60' : 'text-white'
                                                    }`}
                                                    title={
                                                      isDbStale
                                                        ? `Last-known-good value — cron has not refreshed this model in >30min`
                                                        : undefined
                                                    }
                                                  >
                                                    {m.val!.toFixed(1)}
                                                    {unitLabel}
                                                  </span>
                                                  {/* v3.99.36 (project law 2026-04-18): per-model bucket annotation.
                                                        Two models can show different raw values (e.g. icon 18.7°C,
                                                        mf 18.2°C) but both land in the SAME Polymarket bucket (18°C)
                                                        after rounding. The dashboard's "agreement" highlights fire
                                                        on bucket match, not raw match. Without showing the bucket,
                                                        it looks like arbitrary agreement on two different numbers.
                                                        Prefer the API's pre-computed bucket (bias-corrected) from
                                                        comboMemberPredictions when available; else round the raw
                                                        value here (Celsius: round half-up, Fahrenheit: floor). */}
                                                  {(() => {
                                                    if (m.val === null || m.val === undefined) return null
                                                    const cmp = (
                                                      c as unknown as {
                                                        comboMemberPredictions?: Record<
                                                          string,
                                                          { raw: number | null; bucket: number | null }
                                                        > | null
                                                      }
                                                    ).comboMemberPredictions
                                                    const apiBucket =
                                                      cmp?.[m.wrKey]?.bucket ?? cmp?.[m.name.toLowerCase()]?.bucket
                                                    // v3.99.41: half-up both units (matches API marketBucket)
                                                    const computedBucket = Math.round(m.val as number)
                                                    const bucket = apiBucket ?? computedBucket
                                                    const rawRoundedNaive = Math.round(m.val as number)
                                                    // When the API bucket (bias-corrected) differs from the naive
                                                    // round of the raw value, flag it so the user sees the shift.
                                                    const biasShifted =
                                                      apiBucket !== null &&
                                                      apiBucket !== undefined &&
                                                      apiBucket !== rawRoundedNaive
                                                    return (
                                                      <span
                                                        className={`text-[9px] font-mono ml-1 px-1 rounded ${
                                                          biasShifted
                                                            ? 'text-amber-300 bg-amber-500/10 border border-amber-500/30'
                                                            : 'text-gray-500 bg-white/[0.03]'
                                                        }`}
                                                        title={
                                                          biasShifted
                                                            ? `Raw ${(m.val as number).toFixed(1)}${unitLabel} naively rounds to ${rawRoundedNaive}${unitLabel}, but bias-corrected lands in ${bucket}${unitLabel} bucket.`
                                                            : `Raw ${(m.val as number).toFixed(1)}${unitLabel} lands in Polymarket ${bucket}${unitLabel} bucket.`
                                                        }
                                                      >
                                                        → {bucket}
                                                        {unitLabel}
                                                      </span>
                                                    )
                                                  })()}
                                                  {(() => {
                                                    // v3.99.36 (project law 2026-04-18): single-delta format only.
                                                    // The prior v3.99.24 side-by-side "5m +X · 12h +Y" was hostile to
                                                    // read because model runs land ~4× per day (every 6h). Between
                                                    // runs the 5m delta is always 0 and the 12h delta is static;
                                                    // together they add noise without new information. Match the
                                                    // APR 20 (tomorrow) column's format: previous value struck
                                                    // through + signed delta in parens. One reading, one delta.
                                                    // 12h audit moves into the tooltip so drift is still reachable
                                                    // when a reviewer needs it. the operator: "fix it now. … just see the
                                                    // change from the last reading."
                                                    const todayChange = c.forecastDeltas?.today?.[m.wrKey]
                                                    const audit12h = c.forecastDeltas12h?.today?.[m.wrKey]
                                                    const audit12hVal = audit12h?.value12hAgo ?? null
                                                    const audit12hDelta =
                                                      audit12hVal !== null && m.val !== null
                                                        ? m.val! - Number(audit12hVal)
                                                        : null
                                                    const shortDelta = todayChange?.delta
                                                    const shortPrev = todayChange?.previous
                                                    const EPS = 0.05
                                                    const useShort =
                                                      shortDelta !== null &&
                                                      shortDelta !== undefined &&
                                                      Math.abs(shortDelta) >= EPS &&
                                                      shortPrev !== null &&
                                                      shortPrev !== undefined
                                                    const colorFor = (d: number) =>
                                                      d > 0 ? 'text-emerald-400' : 'text-red-400'
                                                    const fmtSigned = (d: number) =>
                                                      `${d > 0 ? '+' : ''}${d.toFixed(1)}`
                                                    if (useShort) {
                                                      const d = shortDelta as number
                                                      const prev = shortPrev as number
                                                      return (
                                                        <span
                                                          className={
                                                            'text-[12px] font-mono font-bold ml-2 ' + colorFor(d)
                                                          }
                                                          title={
                                                            'Last run: ' +
                                                            prev.toFixed(1) +
                                                            unitLabel +
                                                            ' -> now ' +
                                                            m.val!.toFixed(1) +
                                                            unitLabel +
                                                            ' (' +
                                                            fmtSigned(d) +
                                                            '). No 12h audit value available.'
                                                          }
                                                        >
                                                          <span className="text-gray-400 line-through mr-1">
                                                            {prev.toFixed(1)}
                                                          </span>
                                                          ({fmtSigned(d)})
                                                        </span>
                                                      )
                                                    }
                                                    if (
                                                      audit12hVal !== null &&
                                                      audit12hDelta !== null &&
                                                      Math.abs(audit12hDelta) >= EPS
                                                    ) {
                                                      const d = audit12hDelta
                                                      const colorClass = d > 0 ? 'text-emerald-400' : 'text-red-400'
                                                      return (
                                                        <span
                                                          className={'text-[12px] font-mono ml-2 italic ' + colorClass}
                                                          title={
                                                            'No run-over-run change this cycle. 12h ago: ' +
                                                            Number(audit12hVal).toFixed(1) +
                                                            unitLabel +
                                                            ' -> now ' +
                                                            m.val!.toFixed(1) +
                                                            unitLabel
                                                          }
                                                        >
                                                          <span className="text-gray-500 mr-1">
                                                            {Number(audit12hVal).toFixed(1)}
                                                          </span>
                                                          ({d > 0 ? '+' : ''}
                                                          {d.toFixed(1)}
                                                          <span className="text-[9px] text-gray-500 ml-0.5">/12h</span>)
                                                        </span>
                                                      )
                                                    }
                                                    return null
                                                  })()}
                                                </td>
                                                <td className="py-1.5 pr-4 text-right">
                                                  {tmrw !== null && tmrw !== undefined ? (
                                                    <>
                                                      <span className="text-[11px] font-mono text-blue-300">
                                                        {tmrw.toFixed(1)}
                                                        {unitLabel}
                                                      </span>
                                                      {(() => {
                                                        const tmrwChange = c.forecastDeltas?.tomorrow?.[m.wrKey]
                                                        const tmrwDelta = tmrwChange?.delta
                                                        const tmrwPrev = tmrwChange?.previous
                                                        // v3.99.20: render cell even when delta=0 so "no change"
                                                        // shows explicitly instead of a bare value that looks like a
                                                        // data gap. Only skip when data genuinely absent (null/undefined).
                                                        if (tmrwDelta === null || tmrwDelta === undefined) return null
                                                        const d = tmrwDelta
                                                        const colorClass =
                                                          d === 0
                                                            ? 'text-gray-500'
                                                            : d > 0
                                                              ? 'text-emerald-400'
                                                              : 'text-red-400'
                                                        const deltaStr =
                                                          d === 0 ? '±0.0' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`
                                                        return (
                                                          <span
                                                            className={`text-[12px] font-mono ${d === 0 ? '' : 'font-bold'} ml-2 ${colorClass}`}
                                                            title={
                                                              tmrwPrev !== null && tmrwPrev !== undefined
                                                                ? `Was ${tmrwPrev.toFixed(1)}${unitLabel} → now ${tmrw.toFixed(1)}${unitLabel}`
                                                                : ''
                                                            }
                                                          >
                                                            {tmrwPrev !== null && tmrwPrev !== undefined && d !== 0 ? (
                                                              <>
                                                                <span className="text-gray-400 line-through mr-1">
                                                                  {tmrwPrev.toFixed(1)}
                                                                </span>
                                                                ({deltaStr})
                                                              </>
                                                            ) : (
                                                              <>({deltaStr})</>
                                                            )}
                                                          </span>
                                                        )
                                                      })()}
                                                    </>
                                                  ) : (
                                                    (() => {
                                                      const REGIONAL_1DAY = new Set([
                                                        'arome_fr',
                                                        'arome_hd',
                                                        'arpege_eu',
                                                        'ukmo_2km',
                                                        'icon_d2',
                                                        'icon_eu',
                                                        'harmonie_nl',
                                                        'harmonie_eu',
                                                        'metno_nordic',
                                                      ])
                                                      const isRegional = REGIONAL_1DAY.has(m.wrKey)
                                                      return isRegional ? (
                                                        <span
                                                          className="text-[9px] text-gray-600"
                                                          title="Regional model: 1-day lead time only, no tomorrow forecast available"
                                                        >
                                                          1-day only
                                                        </span>
                                                      ) : (
                                                        <span className="text-[10px] text-gray-600">--</span>
                                                      )
                                                    })()
                                                  )}
                                                </td>
                                                <td className="py-1.5 pr-6 text-right">
                                                  {dayShift !== null ? (
                                                    <span
                                                      className={`text-[10px] font-bold ${
                                                        Math.abs(dayShift) < 0.5
                                                          ? 'text-gray-500'
                                                          : dayShift > 0
                                                            ? 'text-emerald-400'
                                                            : 'text-red-400'
                                                      }`}
                                                    >
                                                      {Math.abs(dayShift) < 0.5
                                                        ? 'About the same'
                                                        : dayShift > 0
                                                          ? `${dayShift.toFixed(1)}° warmer`
                                                          : `${Math.abs(dayShift).toFixed(1)}° cooler`}
                                                    </span>
                                                  ) : (
                                                    <span className="text-[10px] text-gray-600">--</span>
                                                  )}
                                                </td>
                                                <td className="py-1.5 pr-4">
                                                  <div>
                                                    <span
                                                      className={`text-[10px] font-bold ${freshnessColor}`}
                                                      title={`Scheduled run ${runInfo.lastRunZ} became available at ${runInfo.lastRunAvailAST} (Open-Meteo's free endpoint does not expose the actual archive write time, so this is the SCHEDULED availability based on the model run cycle, not the precise upstream timestamp).`}
                                                    >
                                                      Updated {runInfo.lastRunAvailAST}
                                                    </span>
                                                  </div>
                                                  <div className="text-[9px] text-gray-500 mt-0.5">
                                                    (
                                                    {runInfo.hoursAgo < 1
                                                      ? `${Math.round(runInfo.hoursAgo * 60)} min`
                                                      : `${Math.round(runInfo.hoursAgo)}h`}{' '}
                                                    ago, run {runInfo.lastRunZ})
                                                  </div>
                                                  <div className="text-[9px] text-purple-400 mt-0.5">
                                                    Next update in {runInfo.nextAvailIn}
                                                  </div>
                                                  {/* v3.77.11 + v3.99.16: DB write age + schedule-divergence badge.
                                                        Primary source: perModelUpdatedAt (v3.99.11, covers all 28
                                                        regional variants). Fallback: forecastDeltas (pre-fix path).
                                                        Two severity levels:
                                                          - amber text at >30min old (informational)
                                                          - RED ⚠ when schedule says a run should be ingested by now
                                                            but DB timestamp is older than the scheduled arrival —
                                                            cron failure or upstream outage. Per consensus review:
                                                            this is the P0 trust-gap badge. */}
                                                  {(() => {
                                                    const cCast = c as unknown as {
                                                      perModelUpdatedAt?: Record<string, string>
                                                    }
                                                    const short = DISPLAY_TO_SHORT_KEY[m.name]
                                                    const dbUpdatedAt =
                                                      (short ? cCast.perModelUpdatedAt?.[short] : undefined) ??
                                                      c.forecastDeltas?.today?.[m.wrKey]?.updatedAt
                                                    if (!dbUpdatedAt) return null
                                                    const dbAgeMs = Date.now() - Date.parse(dbUpdatedAt)
                                                    const dbAgeMin = Math.round(dbAgeMs / 60000)
                                                    // Schedule-vs-DB divergence: scheduleHoursAgo reflects the
                                                    // upstream run's expected availability. If DB age exceeds the
                                                    // schedule age + tolerance, the cron missed a run.
                                                    const scheduleAgeMin = Math.round(runInfo.hoursAgo * 60)
                                                    const divergenceMin = dbAgeMin - scheduleAgeMin
                                                    const isCriticalStale = divergenceMin > 60
                                                    const isMildStale = dbAgeMin > 30 && !isCriticalStale
                                                    if (!isMildStale && !isCriticalStale) return null
                                                    const lastWriteLabel = new Date(dbUpdatedAt).toLocaleTimeString(
                                                      'en-US',
                                                      {
                                                        hour: 'numeric',
                                                        minute: '2-digit',
                                                        hour12: true,
                                                      },
                                                    )
                                                    return (
                                                      <div
                                                        className={`text-[9px] mt-0.5 ${
                                                          isCriticalStale
                                                            ? 'text-red-400 font-bold'
                                                            : 'text-amber-600/70'
                                                        }`}
                                                        title={
                                                          isCriticalStale
                                                            ? `⚠ Ingest delayed. Scheduled ${runInfo.lastRunZ} run should be available (schedule: ${scheduleAgeMin}m ago), but Supabase last write was ${lastWriteLabel} (${dbAgeMin}m ago) — ${divergenceMin}m behind. Cron may have failed or upstream is late.`
                                                            : `Supabase last write: ${lastWriteLabel} — cron may have missed this model`
                                                        }
                                                      >
                                                        {isCriticalStale && '⚠ '}
                                                        DB:{' '}
                                                        <span suppressHydrationWarning>
                                                          {dbAgeMin < 60
                                                            ? `${dbAgeMin}m old`
                                                            : `${Math.round(dbAgeMin / 60)}h old`}
                                                        </span>
                                                        {isCriticalStale && (
                                                          <span className="ml-1">
                                                            ({divergenceMin}m behind schedule)
                                                          </span>
                                                        )}
                                                      </div>
                                                    )
                                                  })()}
                                                </td>
                                                <td className="py-1.5 text-right">
                                                  {(() => {
                                                    const wuWr = wuWRs?.[m.wrKey]
                                                    const displayWr = wuWr ?? wr
                                                    // v3.99.61 — Wilson CI + n<50 suppression.
                                                    // Stats drive BOTH the regime ("hidden" / "ci-band" / "full")
                                                    // and the BEST-distinguishability check below. We ONLY apply
                                                    // stats-based gating when we have the ASOS-side stats (same
                                                    // metric that drives ACTUAL_BUCKET_WIN_RATES). WU-side WR
                                                    // carries no stats today; fall through to the legacy renderer.
                                                    const stat = c.perModelWinRateStats?.[m.wrKey]
                                                    const hasStat = Boolean(stat && stat.attempts > 0)
                                                    const regime = hasStat ? wrRegime(stat!.attempts) : 'full'
                                                    if (hasStat && regime === 'hidden') {
                                                      return (
                                                        <span
                                                          className="text-[9px] text-gray-500 italic"
                                                          title={`Insufficient sample — only n=${stat!.attempts} attempts. Wilson CI is too wide to publish a rate.`}
                                                        >
                                                          n={stat!.attempts}
                                                        </span>
                                                      )
                                                    }
                                                    if (displayWr !== undefined && displayWr !== null) {
                                                      const ci =
                                                        hasStat && stat ? wilsonCI(stat.hits, stat.attempts) : null
                                                      // v3.99.61 — BEST pill uses the distinguishability-gated key
                                                      // (effectiveBestWRKey). The name-column badge uses the same
                                                      // gated key so the two signals agree.
                                                      const isBest =
                                                        m.wrKey === effectiveBestWRKey || m.wrKey === cityWuBestModel
                                                      const baseTitle =
                                                        wuWr !== undefined
                                                          ? `WU: ${wuWr.toFixed(1)}%${wr !== undefined ? ` | ASOS: ${wr.toFixed(1)}%` : ''}`
                                                          : `ASOS: ${displayWr.toFixed(1)}%`
                                                      const ciTitle = ci
                                                        ? `${baseTitle}\n95% Wilson CI: [${ci.lo.toFixed(1)}% – ${ci.hi.toFixed(1)}%] (n=${stat!.attempts}, hits=${stat!.hits})`
                                                        : baseTitle
                                                      return (
                                                        <span
                                                          className={`text-[10px] font-bold ${
                                                            isBest
                                                              ? 'text-green-300 bg-green-500/10 px-1.5 py-0.5 rounded'
                                                              : displayWr >= 40
                                                                ? 'text-green-400'
                                                                : displayWr >= 25
                                                                  ? 'text-yellow-500'
                                                                  : 'text-gray-500'
                                                          }`}
                                                          title={ciTitle}
                                                        >
                                                          {displayWr.toFixed(1)}%
                                                          {wuWr !== undefined && (
                                                            <span className="text-[8px] text-gray-500 ml-0.5">WU</span>
                                                          )}
                                                          {regime === 'ci-band' && ci && (
                                                            <span className="block text-[8px] font-normal text-gray-400">
                                                              [{ci.lo.toFixed(0)}–{ci.hi.toFixed(0)}%] n=
                                                              {stat!.attempts}
                                                            </span>
                                                          )}
                                                        </span>
                                                      )
                                                    }
                                                    return <span className="text-[10px] text-gray-600">--</span>
                                                  })()}
                                                </td>
                                              </tr>
                                            )
                                          })
                                        })()}
                                        {/* Combo WR row — shows best multi-model strategy when available */}
                                        {(() => {
                                          const combo = (
                                            c as unknown as {
                                              comboWR?: number
                                              bestCombo?: string
                                              strategyWR?: number
                                              bestNwpSingleWR?: number
                                              betsPerYear?: number | null
                                              comboDays?: number | null
                                            }
                                          ).comboWR
                                          const comboName = (c as unknown as { bestCombo?: string }).bestCombo
                                          const singleWR = (c as unknown as { bestNwpSingleWR?: number })
                                            .bestNwpSingleWR
                                          const betsPerYear = (c as unknown as { betsPerYear?: number | null })
                                            .betsPerYear
                                          if (!combo || !comboName) return null
                                          const models = comboName
                                            .split('+')
                                            .map((m) => m.replace(/_/g, ' ').toUpperCase())
                                            .join(' + ')
                                          const beatsSingle = singleWR ? combo > singleWR : false
                                          // Phase 02.20 (2026-04-16): base-rate disclosure per the operator.
                                          // "50% WR" is conditional on the combo firing — which doesn't
                                          // happen every day. betsPerYear tells us how often it fires.
                                          // Phrase as "~1 in N days" so it reads like a coin-flip cadence.
                                          const oneInN =
                                            betsPerYear && betsPerYear > 0
                                              ? Math.max(1, Math.round(365 / betsPerYear))
                                              : null
                                          return (
                                            <tr className="border-t-2 border-purple-500/30 bg-purple-500/[0.06]">
                                              <td colSpan={4} className="py-2 px-3">
                                                <span className="text-[10px] font-black text-purple-300 uppercase tracking-wider mr-2">
                                                  COMBO
                                                </span>
                                                <span className="text-[11px] text-purple-200 font-mono">{models}</span>
                                                <span className="text-[8px] text-gray-500 ml-1.5">(ASOS 730d)</span>
                                                {oneInN !== null && (
                                                  <span className="text-[9px] text-gray-500 ml-2">
                                                    fires ~1 in {oneInN} days
                                                  </span>
                                                )}
                                              </td>
                                              <td className="py-2" />
                                              <td className="py-2 text-right pr-1">
                                                <span
                                                  className={`text-[11px] font-black font-mono px-2 py-0.5 rounded ${beatsSingle ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-purple-400'}`}
                                                >
                                                  {combo.toFixed(1)}%
                                                </span>
                                              </td>
                                            </tr>
                                          )
                                        })()}
                                        {/* Ensemble row */}
                                        {c.ensemble !== null && c.ensemble !== undefined && (
                                          <tr className="border-t border-cyan-500/20">
                                            <td className="py-1.5 pr-4">
                                              <span className="text-[11px] font-bold text-cyan-400">ENSEMBLE</span>
                                            </td>
                                            <td className="py-1.5 pr-4 text-right">
                                              <span className="text-[11px] font-mono text-cyan-400 font-bold">
                                                {c.ensemble.toFixed(1)}
                                                {unitLabel}
                                              </span>
                                            </td>
                                            <td className="py-1.5 pr-4 text-right">
                                              {/* ENSEMBLE tomorrow = average of ALL models (v3.86.0: dynamic,
                                                  was hardcoded 10-model list missing HRRR/AIFS/HRDPS/METNO/DMI/
                                                  ARPW/JGSM/BOM + all 9 regionals). Skips non-model keys and dead
                                                  'kma' reference.
                                              */}
                                              {(() => {
                                                const tf = c.tomorrowForecast as
                                                  | Record<string, unknown>
                                                  | null
                                                  | undefined
                                                if (!tf) return <span className="text-[10px] text-gray-600">--</span>
                                                const NON_MODEL_KEYS = new Set([
                                                  'best',
                                                  'model',
                                                  'kma', // removed Phase 02.17.16b, still in some cached shapes
                                                ])
                                                const vals = Object.entries(tf)
                                                  .filter(([k, v]) => !NON_MODEL_KEYS.has(k) && typeof v === 'number')
                                                  .map(([, v]) => v as number)
                                                if (vals.length === 0)
                                                  return <span className="text-[10px] text-gray-600">--</span>
                                                const avg = vals.reduce((a, b) => a + b, 0) / vals.length
                                                return (
                                                  <span
                                                    className="text-[11px] font-mono text-cyan-300"
                                                    title={`Averaging ${vals.length} models`}
                                                  >
                                                    {avg.toFixed(1)}
                                                    {unitLabel}
                                                  </span>
                                                )
                                              })()}
                                            </td>
                                            <td className="py-1.5 pr-6 text-right">
                                              {(() => {
                                                const tf = c.tomorrowForecast as
                                                  | Record<string, unknown>
                                                  | null
                                                  | undefined
                                                if (!tf) return <span className="text-[10px] text-gray-600">--</span>
                                                const NON_MODEL_KEYS = new Set(['best', 'model', 'kma'])
                                                const vals = Object.entries(tf)
                                                  .filter(([k, v]) => !NON_MODEL_KEYS.has(k) && typeof v === 'number')
                                                  .map(([, v]) => v as number)
                                                if (
                                                  vals.length === 0 ||
                                                  c.ensemble === null ||
                                                  c.ensemble === undefined
                                                )
                                                  return <span className="text-[10px] text-gray-600">--</span>
                                                const avg = vals.reduce((a, b) => a + b, 0) / vals.length
                                                const delta = avg - c.ensemble
                                                return (
                                                  <span
                                                    className={`text-[10px] font-bold ${Math.abs(delta) < 0.5 ? 'text-gray-500' : delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}
                                                  >
                                                    {Math.abs(delta) < 0.5
                                                      ? 'About the same'
                                                      : delta > 0
                                                        ? `${delta.toFixed(1)}° warmer`
                                                        : `${Math.abs(delta).toFixed(1)}° cooler`}
                                                  </span>
                                                )
                                              })()}
                                            </td>
                                            <td className="py-1.5 pr-4 text-[10px] text-gray-500">
                                              {c.spread !== null && c.spread !== undefined ? (
                                                c.spread > 4 ? (
                                                  <span className="text-red-400 font-bold">
                                                    Models disagree by {c.spread.toFixed(1)}
                                                    {unitLabel}
                                                  </span>
                                                ) : (
                                                  <span>
                                                    Models agree (within {c.spread.toFixed(1)}
                                                    {unitLabel})
                                                  </span>
                                                )
                                              ) : (
                                                '--'
                                              )}
                                            </td>
                                            <td className="py-1.5 text-right">
                                              <span className="text-[10px] text-cyan-400">Avg of all</span>
                                            </td>
                                          </tr>
                                        )}
                                        {c.strategyName && c.strategyWR && (
                                          <tr
                                            className={`border-t-2 ${
                                              (c as unknown as { comboFiringToday?: boolean | null })
                                                .comboFiringToday === true
                                                ? 'border-emerald-500/40 bg-emerald-500/[0.04]'
                                                : (c as unknown as { comboFiringToday?: boolean | null })
                                                      .comboFiringToday === false
                                                  ? 'border-gray-500/30 bg-gray-800/[0.2]'
                                                  : 'border-yellow-500/30 bg-yellow-500/[0.04]'
                                            }`}
                                          >
                                            <td colSpan={4} className="py-2 pr-4">
                                              <div className="text-[11px] font-bold text-yellow-400">Best Strategy</div>
                                              <div className="text-[10px] text-gray-400 mt-0.5">{c.strategyName}</div>
                                            </td>
                                            <td className="py-2 pr-4">
                                              {(() => {
                                                const cc = c as unknown as {
                                                  comboFiringToday?: boolean | null
                                                  comboActiveBucket?: number | null
                                                  comboMemberPredictions?: Record<
                                                    string,
                                                    { raw: number | null; bucket: number | null }
                                                  > | null
                                                }
                                                if (cc.comboFiringToday === true) {
                                                  const marketUnit = [
                                                    'nyc',
                                                    'chicago',
                                                    'miami',
                                                    'dallas',
                                                    'atlanta',
                                                    'seattle',
                                                    'denver',
                                                    'los-angeles',
                                                    'san-francisco',
                                                    'austin',
                                                    'houston',
                                                    'london',
                                                  ].includes(c.city)
                                                    ? '°F'
                                                    : '°C'
                                                  return (
                                                    <span className="text-[10px] text-emerald-400 font-bold">
                                                      ✓ FIRING TODAY @ {cc.comboActiveBucket}
                                                      {marketUnit}
                                                    </span>
                                                  )
                                                }
                                                if (cc.comboFiringToday === false) {
                                                  const buckets = cc.comboMemberPredictions
                                                    ? Object.entries(cc.comboMemberPredictions)
                                                        .map(([m, p]) => `${m.toUpperCase()}:${p.bucket ?? '—'}`)
                                                        .join(' ')
                                                    : ''
                                                  return (
                                                    <span className="text-[10px] text-gray-400">
                                                      ⏸ NOT FIRING TODAY — models disagree{' '}
                                                      <span className="text-gray-500">({buckets})</span>
                                                    </span>
                                                  )
                                                }
                                                return (
                                                  <span className="text-[10px] text-gray-500">
                                                    When these models agree on the same bucket
                                                  </span>
                                                )
                                              })()}
                                            </td>
                                            <td className="py-2 text-right">
                                              {(() => {
                                                const firing = (c as unknown as { comboFiringToday?: boolean | null })
                                                  .comboFiringToday
                                                return (
                                                  <span
                                                    className={`text-[11px] font-bold ${
                                                      firing === true
                                                        ? 'text-emerald-400'
                                                        : firing === false
                                                          ? 'text-gray-500 line-through'
                                                          : 'text-yellow-400'
                                                    }`}
                                                  >
                                                    {c.strategyWR}%
                                                  </span>
                                                )
                                              })()}
                                            </td>
                                          </tr>
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                </>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Summary bar */}
          <div className="mt-4 pt-3 border-t border-white/5 flex flex-wrap gap-5 text-sm text-gray-400">
            <span>
              BUY:{' '}
              <span className="text-green-400 font-bold">
                {weatherIntel.cities.filter((c) => c.recommendation === 'BUY').length}
              </span>
            </span>
            <span>
              FADE:{' '}
              <span className="text-amber-400 font-bold">
                {weatherIntel.cities.filter((c) => c.recommendation === 'FADE_BUY').length}
              </span>
            </span>
            <span>
              WATCH:{' '}
              <span className="text-yellow-400 font-bold">
                {weatherIntel.cities.filter((c) => c.recommendation === 'WATCH').length}
              </span>
            </span>
            <span>
              SKIP:{' '}
              <span className="text-gray-300 font-bold">
                {weatherIntel.cities.filter((c) => c.recommendation === 'SKIP').length}
              </span>
            </span>
            <span>
              CLOSED:{' '}
              <span className="text-gray-500 font-bold">
                {weatherIntel.cities.filter((c) => c.recommendation === 'CLOSED').length}
              </span>
            </span>
            <span>
              Total Buckets:{' '}
              <span className="text-white font-bold">
                {weatherIntel.cities.reduce((s, c) => s + c.activeBuckets.length, 0)}
              </span>
            </span>
          </div>
        </GlassCard>
      )}

      {/* ─── Section: Data Feeds, Agents and Running Costs ─── */}
      <InfraCosts />

      {/* ─── Section: Backtest Data and Methodology ─── */}
      <DataProvenance />

      {/* Footer */}
      <footer className="mt-2 pt-5 border-t border-white/[0.06] flex flex-col md:flex-row items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-3">
          <PolymarketLogo className="h-4 w-auto text-gray-500" />
          <span className="h-4 w-px bg-white/[0.1]" />
          <span className="text-xs text-gray-500">Weather Command Center</span>
        </div>
        <a
          href="https://tested.media"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 opacity-60 hover:opacity-100 transition-opacity"
        >
          <span className="text-[10px] uppercase tracking-wider text-gray-500">Built by</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/testedmedia.svg" alt="tested.media" className="h-5 w-auto" />
        </a>
        <span className="text-[10px] text-gray-600 max-w-sm text-center md:text-right leading-relaxed">
          Research tooling, not financial advice. Markets can lose your entire stake.
        </span>
      </footer>
    </div>
  )
}
