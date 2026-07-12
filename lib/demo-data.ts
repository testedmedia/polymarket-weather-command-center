/**
 * Demo mode — bundled synthetic sample payload so `npm run dev` renders a
 * fully populated dashboard with zero env vars set. See GitHub issue #8.
 *
 * `isDemoMode()` decides whether the API proxy route serves this generator
 * instead of proxying to `UPSTREAM_BASE`. Demo mode is ON by default whenever
 * no upstream engine is configured (the out-of-the-box `npm run dev`
 * experience for anyone evaluating the repo), and can be forced on/off
 * explicitly with the `DEMO` env var.
 *
 * Every value below is synthetic. Nothing here is a real trade, a real
 * balance, or a real market read — it exists only to exercise every panel in
 * the UI so evaluators aren't staring at an empty screen. The shipped
 * `data/backtest/` artifacts (real, verified) are used where it's cheap to do
 * so (see DAILY_SCORECARD) so the demo doesn't invent numbers the repo
 * already proves.
 */

import { CITY_IDS, type CityKey, type StationRegistryEntry, getRegistryEntry } from './weather-cities'

export function isDemoMode(): boolean {
  if (process.env.DEMO === '0') return false
  if (process.env.DEMO === '1') return true
  // Zero-config default: no real engine configured → serve the sample payload
  // instead of a proxy that 502s against localhost:3000.
  return !process.env.UPSTREAM_BASE
}

/* ─── deterministic PRNG (mulberry32) — stable per city per day ──────────── */
function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return h
}
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CITY_TZ: Record<CityKey, string> = {
  nyc: 'America/New_York',
  chicago: 'America/Chicago',
  miami: 'America/New_York',
  dallas: 'America/Chicago',
  atlanta: 'America/New_York',
  seattle: 'America/Los_Angeles',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  ankara: 'Europe/Istanbul',
  'buenos-aires': 'America/Argentina/Buenos_Aires',
  'sao-paulo': 'America/Sao_Paulo',
  seoul: 'Asia/Seoul',
  toronto: 'America/Toronto',
  wellington: 'Pacific/Auckland',
  tokyo: 'Asia/Tokyo',
  taipei: 'Asia/Taipei',
  shanghai: 'Asia/Shanghai',
  shenzhen: 'Asia/Shanghai',
  'hong-kong': 'Asia/Hong_Kong',
  chongqing: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai',
  singapore: 'Asia/Singapore',
  chengdu: 'Asia/Shanghai',
  madrid: 'Europe/Madrid',
  wuhan: 'Asia/Shanghai',
  'mexico-city': 'America/Mexico_City',
  denver: 'America/Denver',
  'los-angeles': 'America/Los_Angeles',
  milan: 'Europe/Rome',
  jakarta: 'Asia/Jakarta',
  'kuala-lumpur': 'Asia/Kuala_Lumpur',
  munich: 'Europe/Berlin',
  austin: 'America/Chicago',
  busan: 'Asia/Seoul',
  lucknow: 'Asia/Kolkata',
  amsterdam: 'Europe/Amsterdam',
  warsaw: 'Europe/Warsaw',
  houston: 'America/Chicago',
  helsinki: 'Europe/Helsinki',
  'san-francisco': 'America/Los_Angeles',
  'panama-city': 'America/Panama',
}

const MODEL_KEYS = [
  'ecmwf',
  'gfs',
  'icon',
  'gem',
  'jma',
  'ukmo',
  'meteofrance',
  'knmi',
  'kma',
  'cma',
  'gfs_hrrr',
  'ecmwf_aifs',
] as const

function localParts(tz: string, at: Date): { hour: number; minute: number; dateStr: string; timeStr: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const dp = dateFmt.formatToParts(at)
  const dget = (t: string) => dp.find((p) => p.type === t)?.value ?? '01'
  const dateStr = `${dget('year')}-${dget('month')}-${dget('day')}`
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  return { hour, minute, dateStr, timeStr }
}

const TIERS: Array<'S' | 'A' | 'B' | 'C' | 'D'> = ['S', 'A', 'B', 'C', 'D']

// Real, published win-rate anchors from the shipped backtest (README "Headline
// verified numbers" table) — used verbatim so the demo scorecard never
// contradicts the repo's own verified data.
const VERIFIED_BETS = [
  { city: 'london', model: 'UKMO', winRate: 60.05, mae: 1.1 },
  { city: 'nyc', model: 'GFS-HRRR', winRate: 55.73, mae: 1.4 },
  { city: 'dallas', model: 'GFS-HRRR', winRate: 66.4, mae: 1.2 },
  { city: 'toronto', model: 'ICON', winRate: 52.1, mae: 1.6 },
]

function round(n: number, dp = 1): number {
  const f = Math.pow(10, dp)
  return Math.round(n * f) / f
}

interface DemoCity {
  entry: StationRegistryEntry
  cityId: CityKey
  index: number
  rng: () => number
  unit: 'F' | 'C'
  local: { hour: number; minute: number; dateStr: string; timeStr: string }
  baseHigh: number
  currentTemp: number
  models: Record<string, number>
  ensemble: number
  spread: number
  bestModel: string
  bestModelWR: number
  tier: 'S' | 'A' | 'B' | 'C' | 'D'
}

function buildDemoCity(cityId: CityKey, index: number, now: Date): DemoCity {
  const entry = getRegistryEntry(cityId)
  const tz = CITY_TZ[cityId] ?? 'UTC'
  const local = localParts(tz, now)
  const rng = mulberry32(hashSeed(`${cityId}:${local.dateStr}`))
  const unit: 'F' | 'C' = entry.unit

  // Rough seasonal base per unit — not a real climatology, just enough spread
  // to make 41 rows look like 41 different cities instead of one clone.
  const base = unit === 'F' ? 55 + rng() * 40 : 12 + rng() * 22

  const models: Record<string, number> = {}
  for (const key of MODEL_KEYS) {
    models[key] = round(base + (rng() - 0.5) * (unit === 'F' ? 6 : 3))
  }
  const modelVals = Object.values(models)
  const ensemble = round(modelVals.reduce((a, b) => a + b, 0) / modelVals.length)
  const spread = round(Math.max(...modelVals) - Math.min(...modelVals))

  // Diurnal curve — peaks ~14-16 local, currentTemp trails/leads base by how
  // far local hour is from peak.
  const peakHour = 14 + Math.floor(rng() * 3)
  const hourDelta = Math.abs(local.hour - peakHour)
  const diurnalRange = unit === 'F' ? 14 : 8
  const currentTemp = round(base - (hourDelta / 12) * diurnalRange + (rng() - 0.5) * 2)

  const bestModelIdx = Math.floor(rng() * MODEL_KEYS.length)
  const bestModel = MODEL_KEYS[bestModelIdx]
  const bestModelWR = round(38 + rng() * 22, 1)
  const tier = TIERS[Math.floor(rng() * TIERS.length)]

  return { entry, cityId, index, rng, unit, local, baseHigh: round(base), currentTemp, models, ensemble, spread, bestModel, bestModelWR, tier }
}

function bucketLabel(lower: number, upper: number, unit: string, isLow: boolean, isHigh: boolean): string {
  if (isLow) return `< ${upper}°${unit}`
  if (isHigh) return `> ${lower}°${unit}`
  return `${lower}-${upper}°${unit}`
}

function buildBuckets(city: DemoCity) {
  const { unit, ensemble, rng } = city
  const width = unit === 'F' ? 2 : 1
  const center = Math.round(ensemble / width) * width
  const bounds = [center - 3 * width, center - 2 * width, center - width, center, center + width, center + 2 * width, center + 3 * width]
  const raw = bounds.map((_, i) => Math.exp(-Math.pow(i - 3, 2) / 3) * (0.7 + rng() * 0.6))
  const sum = raw.reduce((a, b) => a + b, 0)
  const probs = raw.map((r) => r / sum)

  return bounds.map((lower, i) => {
    const isLow = i === 0
    const isHigh = i === bounds.length - 1
    const upper = lower + width
    const ensembleProb = round(probs[i] * 100, 1)
    const yesPrice = Math.max(0.01, Math.min(0.98, round(probs[i] * 100 + (rng() - 0.5) * 8, 0) / 100))
    const noPrice = round(1 - yesPrice, 2)
    const edge = round(ensembleProb - yesPrice * 100, 1)
    let status: 'CONFIRMED_YES' | 'FADE_LOCK' | 'DEAD' | 'UNCERTAIN' = 'UNCERTAIN'
    if (i === 3 && ensembleProb > 30) status = rng() > 0.7 ? 'CONFIRMED_YES' : 'UNCERTAIN'
    if (isLow || isHigh) status = rng() > 0.85 ? 'DEAD' : 'UNCERTAIN'
    return {
      label: bucketLabel(lower, upper, unit, isLow, isHigh),
      lower,
      upper,
      yesPrice,
      noPrice,
      status,
      edge,
      ensembleProb: ensembleProb / 100,
      recommendation: edge > 8 ? 'BUY YES — model overweights this bucket vs market' : edge < -8 ? 'BUY NO — market overpricing this bucket' : 'SKIP — no meaningful edge',
      bucketType: isLow ? 'wide_below' : isHigh ? 'wide_above' : 'between',
      empProb: round(probs[i], 3),
      empN: 300 + Math.floor(rng() * 400),
      empHits: Math.floor((300 + rng() * 400) * probs[i]),
      probSource: 'empirical' as const,
    }
  })
}

function buildTimeline(city: DemoCity, kind: 'obs' | 'metar' | 'asos') {
  const points: Array<{ hour: number; minute: number; temp: number; label: string; timestamp?: number }> = []
  const { local, baseHigh, unit, rng } = city
  const startHour = Math.max(0, local.hour - 8)
  for (let h = startHour; h <= local.hour; h += 1) {
    const peakDistance = Math.abs(h - 14)
    const temp = round(baseHigh - (peakDistance / 10) * (unit === 'F' ? 12 : 7) + (rng() - 0.5) * 1.5)
    points.push({
      hour: h,
      minute: 0,
      temp,
      label: `${String(h).padStart(2, '0')}:00`,
      timestamp: Date.now() - (local.hour - h) * 3600_000,
    })
  }
  return points
}

function polymarketSlug(entry: StationRegistryEntry, dateStr: string): string {
  const [y, m, d] = dateStr.split('-')
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const monthName = months[Number(m) - 1]
  return entry.polymarketSlugTemplate.replace('{slug}', entry.slug).replace('{month}', monthName).replace('{day}', String(Number(d))).replace('{year}', y)
}

function buildWUCityIntel(city: DemoCity) {
  const { entry, cityId, unit, local, currentTemp, baseHigh, models, ensemble, spread, bestModel, bestModelWR, tier, rng } = city
  const buckets = buildBuckets(city)
  const slug = polymarketSlug(entry, local.dateStr)
  const highIsDeclining = local.hour >= 15 && rng() > 0.4
  const recommendation = highIsDeclining ? 'FADE_BUY' : rng() > 0.6 ? 'BUY' : rng() > 0.3 ? 'WATCH' : 'SKIP'
  const signalConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = spread < (unit === 'F' ? 3 : 1.5) ? 'HIGH' : spread < (unit === 'F' ? 6 : 3) ? 'MEDIUM' : 'LOW'

  const allModels: Record<string, number | null> = { ...models }

  return {
    city: cityId,
    station: entry.station,
    unit,
    timezone: CITY_TZ[cityId] ?? 'UTC',
    localTime: local.timeStr,
    localHour: local.hour,
    currentTemp,
    runningHigh: round(Math.max(currentTemp, baseHigh - 1)),
    v1ArchiveHigh: round(Math.max(currentTemp, baseHigh - 1)),
    v3LiveCurrent: currentTemp,
    metarPeak: round(baseHigh),
    obsCount: 12 + Math.floor(rng() * 30),
    highIsDeclining,
    hoursSincePeak: highIsDeclining ? 1 + Math.floor(rng() * 4) : 0,
    peakHourLocal: 14 + Math.floor(rng() * 3),
    peakMinuteLocal: Math.floor(rng() * 60),
    trendLabel: highIsDeclining ? 'Falling' : 'Rising',
    wuLink: entry.wuHistoryUrlTemplate,
    weatherComLink: entry.wuHistoryUrlTemplate,
    resolutionLink: entry.wuHistoryUrlTemplate,
    resolutionSource: entry.resolutionSourceType === 'OBSERVATORY' ? 'HKO Observatory' : 'Weather Underground V1',
    polymarketUrl: `https://polymarket.com/event/${slug}`,
    eventDate: local.dateStr,
    ecmwf: models.ecmwf,
    gfs: models.gfs,
    icon: models.icon,
    gem: models.gem,
    jma: models.jma,
    ensemble,
    spread,
    bestModel,
    bestModelWR,
    bestModelTemp: models[bestModel] ?? ensemble,
    todayApplicableModel: bestModel,
    todayApplicableWR: bestModelWR,
    comboHistoricalWR: round(bestModelWR + 4, 1),
    comboStatus: rng() > 0.5 ? 'FIRING' : rng() > 0.5 ? 'PENDING' : 'DISAGREEMENT',
    pendingModels: [],
    isAggregateWR: false,
    activeBuckets: buckets,
    liveMarkets: buckets.filter((b) => b.status !== 'DEAD').length,
    totalMarkets: buckets.length,
    recommendation,
    recommendationReason:
      recommendation === 'FADE_BUY'
        ? `Running high confirmed ${city.local.hour - (city.local.hour - 2)}h ago and declining — buckets above ${round(baseHigh)}°${unit} are near-dead.`
        : recommendation === 'BUY'
          ? `${bestModel.toUpperCase()} (${bestModelWR}% verified WR) agrees with the ensemble center bucket and the market is underpricing it.`
          : recommendation === 'WATCH'
            ? 'Edge is forming but has not cleared the sizing threshold yet.'
            : 'No meaningful edge between model consensus and market price.',
    signalConfidence,
    obsTimeline: buildTimeline(city, 'obs'),
    metarTimeline: buildTimeline(city, 'metar'),
    metarHigh: round(baseHigh),
    metarCurrent: currentTemp,
    metarLastObsTime: new Date(Date.now() - 5 * 60_000).toISOString(),
    metarGrade: (['A+', 'A', 'B+', 'B'] as const)[Math.floor(rng() * 4)],
    metarMatchPct: round(88 + rng() * 10, 1),
    metarObsIntervalMin: 30,
    asosTimeline: buildTimeline(city, 'asos').map((p) => ({ ...p, source: 'metar' as const, precision: 'integer' })),
    asosHigh: round(baseHigh),
    asosCurrent: currentTemp,
    asosLastObsTime: new Date(Date.now() - 4 * 60_000).toISOString(),
    wuFcstHigh: round(baseHigh + 1),
    wuFcstLow: round(baseHigh - (unit === 'F' ? 18 : 10)),
    wuForecastWR: round(45 + rng() * 15, 1),
    bestNwpModel: bestModel,
    bestNwpSingleWR: bestModelWR,
    tradeBlocked: false,
    tradeBlockedReason: null,
    stationWarning: null,
    wuConditions: (['Clear', 'Partly Cloudy', 'Cloudy', 'Mostly Sunny'] as const)[Math.floor(rng() * 4)],
    wuHourlyForecast: Array.from({ length: 6 }, (_, i) => ({
      hour: `${String((local.hour + i + 1) % 24).padStart(2, '0')}:00`,
      temp: round(baseHigh - i * 0.6),
      conditions: 'Partly Cloudy',
      precipChance: Math.floor(rng() * 30),
      windSpeed: Math.floor(5 + rng() * 12),
      cloudCover: Math.floor(rng() * 80),
    })),
    obsIntervalMin: 30,
    lastObsTimestamp: Date.now() - 5 * 60_000,
    lastObsLocalTime: local.timeStr,
    nextExpectedTimestamp: Date.now() + 25 * 60_000,
    typicalMinutes: [51],
    tier,
    centerRate: round(40 + rng() * 20, 1),
    isFadeLock: highIsDeclining,
    modelWeights: Object.fromEntries(MODEL_KEYS.map((k) => [k, round(1 / MODEL_KEYS.length, 3)])),
    fadeLockData: highIsDeclining
      ? {
          peakHour: `${14 + Math.floor(rng() * 2)}:00`,
          peakPct: round(60 + rng() * 20, 1),
          window12to5Pct: round(70 + rng() * 15, 1),
          fade1hEvents: 40 + Math.floor(rng() * 60),
          fade1hHeldPct: round(85 + rng() * 10, 1),
          fade2hEvents: 30 + Math.floor(rng() * 50),
          fade2hHeldPct: round(90 + rng() * 8, 1),
          fade3hEvents: 20 + Math.floor(rng() * 40),
          fade3hHeldPct: round(93 + rng() * 6, 1),
        }
      : null,
    hourlyHoldRates: Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), round(40 + (h / 23) * 50, 1)])),
    ukmo: models.ukmo,
    meteofrance: models.meteofrance,
    knmi: models.knmi,
    kma: models.kma,
    cma: models.cma,
    strategyName: `${bestModel.toUpperCase()} single-model`,
    strategyWR: bestModelWR,
    betsPerYear: 200 + Math.floor(rng() * 300),
    marketSpeed: (['SLOW', 'MEDIUM', 'FAST'] as const)[Math.floor(rng() * 3)],
    windSpeed: round(5 + rng() * 15, 1),
    windDirection: (['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const)[Math.floor(rng() * 8)],
    humidity: Math.floor(30 + rng() * 55),
    pressure: round(1005 + rng() * 20, 1),
    pressureTrend: (['rising', 'steady', 'falling'] as const)[Math.floor(rng() * 3)],
    openMeteoObs: {
      temperature: currentTemp,
      windSpeed: round(5 + rng() * 15, 1),
      windDirection: Math.floor(rng() * 360),
      humidity: Math.floor(30 + rng() * 55),
      cloudCover: Math.floor(rng() * 80),
      pressure: round(1005 + rng() * 20, 1),
      precipitation: 0,
      conditions: 'Partly Cloudy',
      fcstHigh: round(baseHigh),
      hourlyForecast: Array.from({ length: 6 }, (_, i) => ({
        hour: `${String((local.hour + i + 1) % 24).padStart(2, '0')}:00`,
        temp: round(baseHigh - i * 0.6),
        conditions: 'Partly Cloudy',
        precipChance: Math.floor(rng() * 30),
        windSpeed: Math.floor(5 + rng() * 12),
        cloudCover: Math.floor(rng() * 80),
      })),
    },
    decodedMetar: {
      temp: currentTemp,
      dewpoint: round(currentTemp - 5 - rng() * 5),
      windSpeed: round(5 + rng() * 15, 1),
      windDirection: Math.floor(rng() * 360),
      windGust: null,
      visibility: 10,
      pressure: round(1013 + rng() * 10, 1),
      cloudCover: 'FEW',
      clouds: [{ cover: 'FEW', base: 3500 }],
      conditions: null,
      rawMetar: `${entry.station} ${local.timeStr.replace(':', '')}Z AUTO`,
      obsTime: new Date().toISOString(),
      fltCat: 'VFR',
    },
    jarvisPrediction: {
      prediction: ensemble,
      confidence: round(60 + rng() * 30, 1),
      standardDeviation: round(unit === 'F' ? 1.5 + rng() : 0.8 + rng() * 0.5, 2),
      method: (['ENSEMBLE', 'TRAJECTORY', 'CONFIRMED', 'BLEND'] as const)[Math.floor(rng() * 4)],
      adjustments: {
        ensembleRaw: ensemble,
        biasCorrection: round((rng() - 0.5) * 1.5, 2),
        conditionBias: round((rng() - 0.5), 2),
        trajectoryAdj: round((rng() - 0.5), 2),
        marketSignal: round((rng() - 0.5) * 0.5, 2),
        windAdj: round((rng() - 0.5) * 0.3, 2),
        pressureAdj: round((rng() - 0.5) * 0.3, 2),
        humidityAdj: round((rng() - 0.5) * 0.3, 2),
        v1Floor: round(baseHigh - 1, 1),
        total: ensemble,
      },
      bucketProbabilities: Object.fromEntries(buckets.map((b) => [b.label, b.ensembleProb ?? 0])),
      marketEdge: buckets.map((b) => ({
        bucket: b.label,
        ourProb: b.ensembleProb ?? 0,
        marketProb: b.yesPrice,
        edge: b.edge ?? 0,
        side: (b.edge ?? 0) >= 0 ? 'YES' : ('NO' as const),
        recommendation: b.recommendation,
      })),
      consensus: 'TWO_AGREE' as const,
      consensusBucket: Math.round(ensemble),
      climatologyPeakHour: 15,
    },
    dynamicSignal: {
      currentWR: bestModelWR,
      modelAccuracy: bestModelWR,
      method: 'CONSENSUS' as const,
      label: `${bestModel.toUpperCase()} + 2 agree`,
      modelsAgreeing: [bestModel, 'gfs', 'icon'].filter((v, i, a) => a.indexOf(v) === i),
      agreedBucket: buckets[3]?.label ?? null,
      bestSingleModel: bestModel,
      bestSingleWR: bestModelWR,
      consensusWR: round(bestModelWR + 3, 1),
      confidence: signalConfidence,
      betsPerYear: 200 + Math.floor(rng() * 300),
      nBets: 300 + Math.floor(rng() * 400),
      signalAge: '6h',
      compositeConfidence: round(60 + rng() * 30, 1),
      seasonalWR: round(40 + rng() * 20, 1),
      seasonalRanking: [bestModel, 'gfs', 'icon'],
      biasCorrection: round((rng() - 0.5) * 2, 2),
      holdRate: round(60 + rng() * 30, 1),
      holdRateSeason: 'summer',
      holdRateHour: local.hour,
      targetBucketNum: Math.round(ensemble),
      expectedROI: round(15 + rng() * 40, 1),
      riskOfRuin: round(rng() * 8, 2),
      monthlyWR: round(40 + rng() * 20, 1),
      monthlyWRMonth: new Date().toLocaleString('en-US', { month: 'long' }),
      monthlyWRSample: 20 + Math.floor(rng() * 30),
      prevMonthWR: round(40 + rng() * 20, 1),
      prevMonthName: 'last month',
      seasonalWRAsos: round(40 + rng() * 20, 1),
      seasonalWRAsosN: 200 + Math.floor(rng() * 200),
      monthlyWRAsos: round(40 + rng() * 20, 1),
      monthlyWRAsosN: 20 + Math.floor(rng() * 30),
    },
    perModelWinRates: Object.fromEntries(MODEL_KEYS.map((k) => [k, round(35 + rng() * 25, 1)])),
    wuAuditStatus: 'clean' as const,
    allModels,
    dataFreshness: {
      asosStaleMins: 4,
      phoneStaleMins: null,
      edgeStaleMins: 6,
      tgroupAvailable: false,
      asosCurrentSource: 'metar',
      displayedSourceStaleMins: 4,
    },
    ...(cityId === 'hong-kong'
      ? {
          hkoTemp: currentTemp,
          hkoDecimal: {
            current: currentTemp,
            runningHigh: round(baseHigh),
            officialMax: round(baseHigh),
            bucket: Math.round(ensemble),
            readingCount: 18,
            isDecimal: true,
          },
          vhhhTemp: round(currentTemp + 0.4),
          vhhhHigh: round(baseHigh + 0.4),
          hkoRunningMax: round(baseHigh),
        }
      : {}),
    buyNoSafe: entry.dataQualityStatus !== 'unverified',
  }
}

/* ─── top-level payload builders ─────────────────────────────────────────── */

export function buildWeatherIntel(now: Date = new Date()) {
  const cities = CITY_IDS.map((id, i) => buildWUCityIntel(buildDemoCity(id, i, now)))
  const metarReliability: Record<string, unknown> = {}
  for (const c of cities) {
    metarReliability[c.station] = {
      station: c.station,
      totalDays: 728,
      exactMatchPct: c.metarMatchPct,
      within1Pct: round((c.metarMatchPct ?? 90) + 5, 1),
      within2Pct: round((c.metarMatchPct ?? 90) + 8, 1),
      meanBias: 0.2,
      maxDisagreement: 3,
      obsPerDay: 24,
      reportingFreq: '30-60 min',
      has5minAsos: c.city === 'nyc' || c.city === 'chicago',
      v1LeadTimeMins: 45,
      dstIssue: false,
      dstDates: '',
      notes: 'Synthetic demo-mode reliability record.',
      grade: c.metarGrade,
    }
  }
  return {
    timestamp: now.toISOString(),
    cities,
    metarReliability,
    snipePlaybook: {
      activePhase: now.getUTCHours() < 12 ? 'morning' : 'afternoon',
      topPlays: cities.slice(0, 5).map((c) => ({
        city: c.city,
        entryPrice: 0.06,
        buckets: 2,
        hitProb: (c.dynamicSignal?.currentWR ?? 50) / 100,
        ev: round(0.3 + Math.random() * 0.4, 2),
        roi: round(200 + Math.random() * 400, 1),
        holdRate: round(70 + Math.random() * 20, 1),
      })),
    },
    pennyBidBoard: null,
    phoneEnabled: false,
    edgeLastUpdate: new Date(Date.now() - 2 * 60_000).toISOString(),
    hongKongMultiStation: null,
    freshness: buildFreshness(now),
  }
}

export function buildWeatherReport(now: Date = new Date()) {
  const cities = CITY_IDS.map((id, i) => {
    const c = buildDemoCity(id, i, now)
    return {
      city: c.cityId,
      station: c.entry.station,
      unit: c.unit,
      currentTemp: c.currentTemp,
      dayHigh: c.baseHigh,
      dataSource: 'METAR',
      obsCount: 20,
      ecmwf: c.models.ecmwf,
      gfs: c.models.gfs,
      icon: c.models.icon,
      gem: c.models.gem,
      jma: c.models.jma,
      ensemble: c.ensemble,
      spread: c.spread,
      gap: round(c.baseHigh - c.currentTemp, 1),
      bestModel: c.bestModel,
      bestModelWR: c.bestModelWR,
      bestModelTemp: c.models[c.bestModel],
    }
  })
  return { timestamp: now.toISOString(), cities }
}

function buildFreshness(now: Date) {
  const iso = now.toISOString()
  const live = { last_ok_at: iso, age_seconds: 30, status: 'LIVE' as const }
  return {
    server_build: 'demo',
    response_generated_at: iso,
    snapshot_at: iso,
    oldest_component_updated_at: iso,
    source_status: { openmeteo: live, metar: live, wu: live, polymarket: live },
  }
}

export function buildModelStatus(now: Date = new Date()) {
  const cities = CITY_IDS.slice(0, 6).map((id, i) => buildDemoCity(id, i, now))
  const positions = cities.map((c) => ({
    title: `Highest temperature in ${c.entry.displayName} on ${c.local.dateStr}?`,
    city: c.cityId,
    size: round(50 + c.rng() * 150, 1),
    avgPrice: round(0.08 + c.rng() * 0.1, 3),
    curPrice: round(0.1 + c.rng() * 0.3, 3),
    currentValue: round(20 + c.rng() * 60, 2),
    outcome: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`,
    runningHigh: c.baseHigh,
    bucketCeiling: c.baseHigh + 2,
    health: (['ALIVE', 'THREATENED', 'DEAD'] as const)[Math.floor(c.rng() * 3)],
    bestModel: c.bestModel,
    bestModelWR: c.bestModelWR,
  }))
  const summary = {
    total: positions.length,
    alive: positions.filter((p) => p.health === 'ALIVE').length,
    threatened: positions.filter((p) => p.health === 'THREATENED').length,
    dead: positions.filter((p) => p.health === 'DEAD').length,
  }
  return { timestamp: now.toISOString(), positions, summary }
}

export function buildDailyScorecard(now: Date = new Date()) {
  const cityAccuracy: Record<string, { bestModel: string; winRate: number; mae: number }> = {}
  for (const b of VERIFIED_BETS) {
    cityAccuracy[b.city] = { bestModel: b.model, winRate: b.winRate, mae: b.mae }
  }
  return {
    timestamp: now.toISOString(),
    backtestPeriod: '730 days',
    totalDays: 730,
    dataVerified: 'data/backtest/polymarket_asos_ground_truth_v1.json',
    cityAccuracy,
    topStrategies: VERIFIED_BETS.map((b, i) => ({
      rank: i + 1,
      name: `${b.city}/${b.model}`,
      win_rate: b.winRate,
      wins: Math.round((b.winRate / 100) * 436),
      total: 436,
    })),
    overallWR: round(VERIFIED_BETS.reduce((a, b) => a + b.winRate, 0) / VERIFIED_BETS.length, 2),
  }
}

export function buildEdgePanel(now: Date = new Date()) {
  const stations: Record<string, unknown> = {}
  const kills: unknown[] = []
  CITY_IDS.slice(0, 10).forEach((id, i) => {
    const c = buildDemoCity(id, i, now)
    stations[c.entry.station] = {
      station: c.entry.station,
      city: c.cityId,
      temp_f: c.unit === 'F' ? c.currentTemp : round(c.currentTemp * 1.8 + 32, 1),
      day_high_f: c.unit === 'F' ? c.baseHigh : round(c.baseHigh * 1.8 + 32, 1),
      source: 't-group',
      precision: 'tenth',
      obs_time_utc: now.toISOString(),
      captured_at: now.toISOString(),
      bucket_status: [{ bucket: `${Math.round(c.ensemble)}`, status: 'alive' }],
    }
    if (c.rng() > 0.7) {
      kills.push({
        station: c.entry.station,
        city: c.cityId,
        bucket: `> ${Math.round(c.baseHigh) + 2}`,
        killed_at: new Date(now.getTime() - c.rng() * 3_600_000).toISOString(),
        temp_at_kill: c.baseHigh,
        v1_confirmed: true,
        polymarket_yes_price: round(c.rng() * 0.05, 3),
        minutes_since_kill: Math.floor(c.rng() * 120),
      })
    }
  })
  return { timestamp: now.toISOString(), stations, kills_today: kills }
}

export function buildProfileStats(now: Date = new Date()) {
  return {
    portfolioValue: 4820.55,
    cashBalance: 1240.1,
    biggestWin: 2241.22,
    predictions: 386,
    activityEntries: 386,
    activityPages: 4,
    activityComplete: true,
    activitySource: 'api' as const,
    pnl: { ALL: 1180.4, '30D': 210.6, '7D': 64.2 },
  }
}

export function buildPnl() {
  return {
    totalBuyUsdc: 9840.2,
    totalSellUsdc: 8210.4,
    totalRedeemUsdc: 2050.6,
    totalRewardUsdc: 12.4,
    totalReturnedUsdc: 10261.0,
    totalMarkets: 386,
    activityEntries: 386,
    activityPages: 4,
    activityComplete: true,
    activitySource: 'api' as const,
  }
}

export function buildBalance() {
  return { balance: 1240.1 }
}

export function buildConfig() {
  return { enabled: true, mode: 'paper', last_updated: new Date().toISOString(), updated_by: 'demo' }
}

export function buildPositions(now: Date = new Date()) {
  return CITY_IDS.slice(0, 8).map((id, i) => {
    const c = buildDemoCity(id, i, now)
    const size = round(40 + c.rng() * 120, 1)
    const avgPrice = round(0.06 + c.rng() * 0.12, 3)
    const curPrice = round(avgPrice * (0.6 + c.rng() * 1.2), 3)
    const initialValue = round(size * avgPrice, 2)
    const currentValue = round(size * curPrice, 2)
    return {
      asset: `demo-${id}-${i}`,
      conditionId: `0xdemo${i.toString(16).padStart(6, '0')}`,
      title: `Highest temperature in ${c.entry.displayName} on ${c.local.dateStr}?`,
      outcome: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`,
      outcomeIndex: 3,
      size,
      avgPrice,
      curPrice,
      initialValue,
      currentValue,
      cashPnl: round(currentValue - initialValue, 2),
      realizedPnl: 0,
      percentPnl: round(((currentValue - initialValue) / initialValue) * 100, 1),
    }
  })
}

export function buildTrades(now: Date = new Date()) {
  return CITY_IDS.slice(0, 12).map((id, i) => {
    const c = buildDemoCity(id, i, now)
    return {
      transactionHash: `0xdemo${i.toString(16).padStart(8, '0')}`,
      timestamp: Math.floor((now.getTime() - c.rng() * 6 * 3_600_000) / 1000),
      title: `Highest temperature in ${c.entry.displayName} on ${c.local.dateStr}?`,
      outcome: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`,
      outcomeIndex: 3,
      side: c.rng() > 0.5 ? 'BUY' : 'SELL',
      price: round(0.05 + c.rng() * 0.15, 3),
      size: round(20 + c.rng() * 100, 1),
    }
  })
}

export function buildProfileStatsBundle() {
  return buildProfileStats()
}

export function buildBotStrategy(now: Date = new Date()) {
  const recCities = CITY_IDS.slice(0, 6).map((id, i) => buildDemoCity(id, i, now))
  const recommendations = recCities.map((c) => ({
    city: c.cityId,
    station: c.entry.station,
    unit: c.unit,
    localTime: c.local.timeStr,
    localHour: c.local.hour,
    currentTemp: c.currentTemp,
    runningHigh: c.baseHigh,
    trendLabel: 'Rising',
    highIsDeclining: false,
    weatherCondition: 'Partly Cloudy',
    weatherBias: 'NEUTRAL' as const,
    ensemble: c.ensemble,
    spread: c.spread,
    bestModel: c.bestModel,
    bestModelTemp: c.models[c.bestModel],
    conviction: (['HIGH', 'MEDIUM', 'LOW', 'SKIP'] as const)[Math.floor(c.rng() * 4)],
    convictionReasons: [`${c.bestModel.toUpperCase()} verified ${c.bestModelWR}% WR`, 'Ensemble spread tight'],
    trades: [
      {
        bucket: `${Math.round(c.ensemble) - 2}-${Math.round(c.ensemble)}`,
        lower: Math.round(c.ensemble) - 2,
        upper: Math.round(c.ensemble),
        yesPrice: 0.08,
        multiplier: round(1 / 0.08, 1),
        suggestedSize: 25,
        maxFillable: 40,
        actualSize: 25,
        expectedReturn: round(25 / 0.08, 1),
        bucketType: 'NO_ELIMINATION' as const,
        layer: 1 as const,
        edge: 6.2,
        modelProb: 0.14,
        orderType: 'LIMIT' as const,
        limitOffset: 0.01,
        reason: 'Dead-bucket NO — running high already above this range.',
      },
    ],
    inTradingWindow: true,
    windowLabel: 'AM window',
    budgetPhase: 'AM' as const,
    signalStatus: 'READY' as const,
    signalLabel: 'Fresh 12Z run',
    bestModelCycle: '12Z',
    nextModelDrop: '18Z',
    hoursUntilSignal: 2,
    signalIsFresh: true,
  }))
  return {
    timestamp: now.toISOString(),
    config: {
      dailyBudget: 400,
      amRatio: 0.6,
      pmRatio: 0.4,
      amBudget: 240,
      pmBudget: 160,
      layers: {
        l1: { noRange: '0.85-0.97', sizeRange: '10-40', maxPerDay: 20, minEdge: '5%', minDegrees: 4 },
        l2: { noMin: '0.9', size: '10-20', maxPerDay: 10, minDegrees: 6 },
        l3: { yesRange: '0.1-0.35', sizeRange: '10-25', maxPerDay: 8, maxSpread: 4, minConviction: 0.6 },
      },
    },
    summary: {
      totalCities: CITY_IDS.length,
      layer1: { trades: 12, exposure: 180, avgEdge: 6.4 },
      layer2: { trades: 6, exposure: 90 },
      layer3: { trades: 4, exposure: 70 },
      totalExposure: 340,
      existingPositions: 8,
      existingCities: recCities.slice(0, 3).map((c) => c.cityId),
    },
    recommendations,
  }
}

export function buildTradeScorecard(now: Date = new Date()) {
  const perCity: Record<string, unknown> = {}
  CITY_IDS.slice(0, 10).forEach((id, i) => {
    const c = buildDemoCity(id, i, now)
    const trades = 4 + Math.floor(c.rng() * 20)
    const wins = Math.round(trades * (0.4 + c.rng() * 0.3))
    perCity[id] = {
      trades,
      wins,
      losses: trades - wins,
      winRate: round((wins / trades) * 100, 1),
      invested: round(trades * 15, 1),
      profit: round(wins * 25 - (trades - wins) * 15, 1),
      roi: round(((wins * 25 - (trades - wins) * 15) / (trades * 15)) * 100, 1),
      bestTrade: { bucket: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`, multiplier: 12.5, profit: 187.5 },
    }
  })
  return {
    timestamp: now.toISOString(),
    totalTrades: 386,
    totalResolved: 340,
    wins: 198,
    losses: 142,
    winRate: 58.2,
    totalInvested: 9840.2,
    totalReturned: 11020.6,
    totalProfit: 1180.4,
    roi: 12.0,
    perCity,
    recentResolved: CITY_IDS.slice(0, 8).map((id, i) => {
      const c = buildDemoCity(id, i, now)
      const win = c.rng() > 0.4
      return {
        city: id,
        bucket: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`,
        outcome: (win ? 'WIN' : 'LOSS') as 'WIN' | 'LOSS',
        invested: 20,
        returned: win ? round(20 * (4 + c.rng() * 8), 1) : 0,
        multiplier: win ? round(4 + c.rng() * 8, 1) : 0,
        profit: win ? round(20 * (3 + c.rng() * 7), 1) : -20,
        resolvedAt: new Date(now.getTime() - i * 3_600_000).toISOString(),
      }
    }),
    daily: { wins: 4, losses: 3, winRate: 57.1, profit: 62.4, roi: 8.9 },
    weekly: { wins: 26, losses: 18, winRate: 59.1, profit: 412.6, roi: 11.2 },
    byStrategy: {
      sniper: { wins: 120, losses: 90, winRate: 57.1, profit: 680.2, roi: 9.8 },
      guaranteed: { wins: 78, losses: 52, winRate: 60.0, profit: 500.2, roi: 15.1 },
    },
  }
}

export function buildBotStatus(now: Date = new Date()) {
  const cities: Record<string, unknown> = {}
  CITY_IDS.slice(0, 12).forEach((id, i) => {
    const c = buildDemoCity(id, i, now)
    cities[id] = {
      v1_high: c.baseHigh,
      v3_current: c.currentTemp,
      dead_buckets: [],
      obs_count: 20,
      status: 'live',
      local_hour: c.local.hour,
      rising: c.rng() > 0.5,
      gap: round(c.baseHigh - c.currentTemp, 1),
      metar: c.currentTemp,
    }
  })
  return {
    status: {
      timestamp: now.toISOString(),
      version: 'demo-3.100.24',
      fills_today: 6,
      total_profit: 187.4,
      total_cost: 420.6,
      budget_spent: 420.6,
      budget_remaining: 179.4,
      asks_seen: 1240,
      dead_bucket_count: 9,
      websocket_status: 'connected (demo)',
      subscribed_tokens: 82,
      maker_bids_active: 4,
      cities,
      capital_recycling: {
        enabled: true,
        positions: [],
        open_sells: 2,
        trades_today: 6,
        realized_pnl: 187.4,
        capital_recycled: 420.6,
        price_range: { min: 0.04, max: 0.12 },
        scanning: true,
      },
      self_learning: {
        enabled: true,
        transitions: 12,
        attempts: 340,
        fills: 82,
        current_fok_max: 0.09,
        min_fok: 0.05,
        max_fok: 0.12,
        last_adaptation: Date.now() - 3_600_000,
      },
      trades: CITY_IDS.slice(0, 6).map((id, i) => {
        const c = buildDemoCity(id, i, now)
        return {
          city: id,
          bucket: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`,
          price: 0.08,
          roi_pct: 1150,
          cost: 20,
          profit: round(20 * (11.5 * c.rng()), 1),
          type: 'FOK',
          status: 'filled',
          time: new Date(now.getTime() - i * 900_000).toISOString(),
        }
      }),
      budget_total: 600,
      scan_log: [],
      reports: [],
    },
    config: {
      enabled: true,
      mode: 'paper',
      daily_budget: 600,
      max_single_trade: 40,
      min_roi_pct: 400,
      maker_bid_enabled: true,
      maker_bid_price: 0.05,
      fok_snipe_enabled: true,
      fok_max_price: 0.09,
    },
  }
}

export function buildPaperTrades(now: Date = new Date()) {
  return {
    timestamp: now.toISOString(),
    strategy: 'resting-no-bid',
    config: { bid_price: 0.9, min_distance_f: 6, min_distance_c: 3, trade_size: 20 },
    today: { date: now.toISOString().slice(0, 10), candidates: 34, bids_placed: 12, filled: 5, resolved_win: 4, resolved_loss: 1, pnl: 22.4 },
    cumulative: { total_bids: 340, total_filled: 128, total_wins: 108, total_losses: 20, total_pnl: 612.4, days_active: 46 },
    positions_today: CITY_IDS.slice(0, 6).map((id, i) => {
      const c = buildDemoCity(id, i, now)
      return {
        city: id,
        bucket: `> ${Math.round(c.baseHigh) + 2}`,
        distance: round(6 + c.rng() * 4, 1),
        bid_price: 0.9,
        yes_price: round(0.02 + c.rng() * 0.05, 3),
        winner: 'NO',
        shares: 22.2,
        cost: 20,
        status: i < 4 ? 'filled' : 'open',
        pnl: i < 4 ? 2.2 : null,
        bid_time: new Date(now.getTime() - i * 1_800_000).toISOString(),
      }
    }),
    positions_yesterday: [],
    city_summary: CITY_IDS.slice(0, 6).map((id, i) => {
      const c = buildDemoCity(id, i, now)
      return { city: id, bids: 8, filled: 3, total_cost: 60, total_pnl: round(c.rng() * 10, 1), avg_distance: 7.2 }
    }),
  }
}

export function buildRecommendedTrades(now: Date = new Date()) {
  const cities = CITY_IDS.slice(0, 8).map((id, i) => buildDemoCity(id, i, now))
  return {
    timestamp: now.toISOString(),
    snipes: cities.slice(0, 3).map((c) => ({
      city: c.cityId,
      bucket: `> ${Math.round(c.baseHigh) + 2}`,
      side: 'NO',
      price: 0.05,
      multiplier: 20,
      v1: c.baseHigh,
      unit: c.unit,
      reason: 'Running high confirmed, bucket dead',
      url: `https://polymarket.com/event/${polymarketSlug(c.entry, c.local.dateStr)}`,
    })),
    guaranteed: cities.slice(3, 5).map((c) => ({
      city: c.cityId,
      bucket: `${Math.round(c.baseHigh)}-${Math.round(c.baseHigh) + 2}`,
      side: 'YES',
      price: 0.12,
      roi: 733,
      v1: c.baseHigh,
      unit: c.unit,
      reason: 'Model consensus locked, 3h to close',
      url: `https://polymarket.com/event/${polymarketSlug(c.entry, c.local.dateStr)}`,
    })),
    favorites: cities.slice(5, 7).map((c) => ({
      city: c.cityId,
      bucket: `${Math.round(c.ensemble)}-${Math.round(c.ensemble) + 2}`,
      yesPrice: 0.22,
      noPrice: 0.78,
      v1: c.baseHigh,
      ensemble: c.ensemble,
      unit: c.unit,
      reason: `${c.bestModel.toUpperCase()} best-in-class for this city`,
      url: `https://polymarket.com/event/${polymarketSlug(c.entry, c.local.dateStr)}`,
    })),
    watching: cities.slice(7, 8).map((c) => ({ city: c.cityId, v1: c.baseHigh, v3: c.currentTemp, unit: c.unit, note: 'Waiting on next model drop' })),
    summary: 'Demo sample: 3 snipes, 2 guaranteed, 2 favorites, 1 watching.',
  }
}

export function buildGfsSignals(now: Date = new Date(), date?: string) {
  const cities = CITY_IDS.slice(0, 10).map((id, i) => buildDemoCity(id, i, now))
  const signals = cities.map((c) => {
    const predicted = Math.round(c.ensemble)
    const snipeable = c.rng() > 0.5
    return {
      city: c.entry.displayName,
      citySlug: c.cityId,
      date: date ?? c.local.dateStr,
      gfs: c.models.gfs,
      ecmwf: c.models.ecmwf,
      icon: c.models.icon,
      gem: c.models.gem,
      predictedBucket: `${predicted}-${predicted + 2}`,
      modelsAgreeing: 2 + Math.floor(c.rng() * 3),
      consensusModels: ['gfs', 'ecmwf', 'icon'],
      signalStrength: (['STRONG', 'MODERATE', 'WEAK'] as const)[Math.floor(c.rng() * 3)],
      modelConsensusTemp: c.ensemble,
      distanceFromConsensus: round(c.rng() * 2, 1),
      marketExists: true,
      polymarketUrl: `https://polymarket.com/event/${polymarketSlug(c.entry, c.local.dateStr)}`,
      bestAsk: round(0.05 + c.rng() * 0.1, 3),
      askDepthUsd: round(200 + c.rng() * 800, 0),
      allBuckets: [0, 1, 2].map((k) => ({ label: `${predicted + k * 2}-${predicted + k * 2 + 2}`, yesPrice: round(0.3 / (k + 1), 2), isTarget: k === 0 })),
      winRate: c.bestModelWR,
      evAtFiveCents: round(c.bestModelWR / 100 - 0.05, 3),
      roiPct: round((c.bestModelWR / 100 / 0.05 - 1) * 100, 1),
      recommendedSizeUsd: 25,
      unit: c.unit,
      snipeable,
      verdict: (snipeable ? 'SNIPE' : 'OVERPRICED') as 'SNIPE' | 'OVERPRICED',
      verdictLabel: snipeable ? 'Snipe — model/market gap clears threshold' : 'Overpriced vs model consensus',
      sharesAtFiveCents: 20,
      sharesAtTenCents: 10,
      costAtFiveCents: 1,
      maxSnipeSizeUsd: 40,
      bidStrategy: 'SINGLE' as const,
      tier1: { label: `${predicted}-${predicted + 2}`, price: 0.05, shares: 20, cost: 1, payout: 20 },
      tier2: null,
      totalCost: 1,
      totalPayout: 20,
    }
  })
  return {
    signals,
    date: date ?? cities[0]?.local.dateStr,
    summary: {
      snipeable: signals.filter((s) => s.snipeable).length,
      overpriced: signals.filter((s) => !s.snipeable).length,
      noMarket: 0,
      strong: signals.filter((s) => s.signalStrength === 'STRONG').length,
      moderate: signals.filter((s) => s.signalStrength === 'MODERATE').length,
      weak: signals.filter((s) => s.signalStrength === 'WEAK').length,
      totalCities: signals.length,
      totalCapital: signals.length * 25,
      expectedEV: round(signals.reduce((a, s) => a + s.evAtFiveCents, 0), 2),
      totalSharesAvailable: signals.length * 20,
      totalPotentialPayout: signals.length * 20,
      twoTierCount: 0,
      singleTierCount: signals.length,
    },
  }
}

export function buildClobDepth(city: string, now: Date = new Date()) {
  const idx = Math.max(0, CITY_IDS.indexOf(city as CityKey))
  const c = buildDemoCity((CITY_IDS[idx] ?? 'nyc') as CityKey, idx, now)
  const buckets = buildBuckets(c)
  const byBound: Record<string, unknown> = {}
  for (const b of buckets) {
    byBound[String(b.lower)] = {
      bestYesAsk: b.yesPrice,
      vwapBuyYes100: round(b.yesPrice * 1.05, 3),
      askSize5pp: Math.floor(200 + c.rng() * 600),
      depthOk: true,
      reason: 'Demo sample depth — not a live order book.',
    }
  }
  return { byBound }
}

export function buildResolutionSource(city: string, now: Date = new Date()) {
  const idx = Math.max(0, CITY_IDS.indexOf(city as CityKey))
  const entry = getRegistryEntry((CITY_IDS[idx] ?? 'nyc') as CityKey)
  return {
    station: entry.station,
    sourceUrl: entry.wuHistoryUrlTemplate,
    precision: 'integer' as const,
    precisionUnit: entry.unit,
    rule: 'Highest recorded METAR/ASOS temperature for the local calendar day, per the Weather Underground V1 daily archive.',
    settlementText: `Resolves to the daily maximum reported for ${entry.station}.`,
    verified: true,
  }
}

/**
 * Central dispatcher used by the API proxy route. `type` is the single-type
 * query param name (e.g. `weather-intel`); returns the exact JSON shape the
 * real upstream engine would return for that type.
 */
export function getDemoData(type: string, params: URLSearchParams): unknown {
  const now = new Date()
  switch (type) {
    case 'weather-intel':
      return buildWeatherIntel(now)
    case 'weather-report':
      return buildWeatherReport(now)
    case 'model-status':
      return buildModelStatus(now)
    case 'daily-scorecard':
      return buildDailyScorecard(now)
    case 'edge-readings':
      return buildEdgePanel(now)
    case 'recommended-trades':
      return buildRecommendedTrades(now)
    case 'gfs-signals':
      return buildGfsSignals(now, params.get('date') ?? undefined)
    case 'balance':
      return buildBalance()
    case 'positions':
      return buildPositions(now)
    case 'trades':
      return buildTrades(now)
    case 'pnl':
      return buildPnl()
    case 'config':
      return buildConfig()
    case 'profile-stats':
      return buildProfileStats(now)
    case 'bot-strategy':
      return buildBotStrategy(now)
    case 'trade-scorecard':
      return buildTradeScorecard(now)
    case 'bot-status':
      return buildBotStatus(now)
    case 'paper-trades':
      return buildPaperTrades(now)
    default:
      return { error: `demo mode has no sample data for type "${type}"` }
  }
}

export function getDemoSubroute(subPath: string, params: URLSearchParams): unknown {
  if (subPath === '/clob-depth') return buildClobDepth(params.get('city') ?? 'nyc')
  if (subPath === '/resolution-source') return buildResolutionSource(params.get('city') ?? 'nyc')
  return { error: `demo mode has no sample data for route "${subPath}"` }
}
