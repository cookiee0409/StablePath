"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Asset = "USDT" | "USDC";
type Exchange = "Binance" | "Bitget" | "Bybit" | "OKX";
type DomesticExchange = "Upbit" | "Bithumb";
type FeeExchange = Exchange | DomesticExchange;
type Chain = "Tron" | "Ethereum" | "Kaia" | "Aptos" | "Solana";
type TransferDirection = "toKrw" | "fromKrw";
type OrderbookView = "domestic" | "foreign";
type QuoteSource = "live" | "stale" | "unavailable";
type FeeSource = "live" | "stale" | "manual";
type RouteSource = "live" | "estimate";
type OrderLevel = {
  price: number;
  size: number;
};
type QuoteDiagnostics = {
  checkedAt: string;
  endpoint?: string;
  latencyMs?: number;
  reason?: string;
  statusCode?: number;
};
type FeeAssetPayload = {
  fees: Partial<Record<Chain, number>>;
  supportedChains: Chain[];
  source: QuoteSource;
  checkedAt: string;
  endpoint?: string;
  latencyMs?: number;
  reason?: string;
  statusCode?: number;
};

type MarketPayload = {
  foreign: Array<QuoteDiagnostics & {
    exchange: Exchange;
    bid: number;
    ask: number;
    last: number;
    bids: OrderLevel[];
    asks: OrderLevel[];
    source: QuoteSource;
  }>;
  domestic: Array<QuoteDiagnostics & {
    exchange: DomesticExchange;
    asset: Asset;
    bid: number;
    ask: number;
    bids: OrderLevel[];
    asks: OrderLevel[];
    source: QuoteSource;
  }>;
  liveFees?: {
    Bitget?: Partial<Record<Asset, FeeAssetPayload>>;
  };
  quality?: {
    quotes: "live" | "partial";
    fees: "live" | "partial";
  };
  updatedAt: string;
  hasFallback: boolean;
};

type FeeMatrix = Record<
  FeeExchange,
  Record<Asset, Partial<Record<Chain, number>>>
>;
type FeeSourceMatrix = Record<FeeExchange, Record<Asset, FeeSource>>;
type TradingFeeSettings = {
  foreign: Record<Exchange, number>;
  domestic: Record<DomesticExchange, number>;
};

type RouteResult = {
  id: string;
  direction: TransferDirection;
  exchange: Exchange;
  startAsset: Asset;
  transferAsset: Asset;
  domestic: DomesticExchange;
  chain: Chain;
  withdrawalFee: number;
  totalWithdrawalFee: number;
  transferCount: number;
  quantityAfterSwap: number;
  netQuantity: number;
  filledQuantity: number;
  unfilledQuantity: number;
  fillRatio: number;
  fullyFillable: boolean;
  grossKrw: number;
  averageSellPrice: number;
  topBid: number;
  slippageBps: number;
  levelsUsed: number;
  visibleBidLiquidity: number;
  krw: number;
  inputAmount: number;
  outputAmount: number;
  averageDomesticPrice: number;
  domesticSlippageBps: number;
  domesticLevelsUsed: number;
  source: RouteSource;
  feeSource: FeeSource;
  converted: boolean;
  foreignFilledInput: number;
  foreignUnfilledInput: number;
  foreignFillRatio: number;
  foreignFullyFillable: boolean;
  foreignAveragePrice: number;
  foreignSlippageBps: number;
  foreignLevelsUsed: number;
};

const EXCHANGES: Exchange[] = ["Binance", "Bitget", "Bybit", "OKX"];
const DOMESTIC_EXCHANGES: DomesticExchange[] = ["Upbit", "Bithumb"];
const FEE_EXCHANGES: FeeExchange[] = [
  ...EXCHANGES,
  ...DOMESTIC_EXCHANGES,
];
const ASSETS: Asset[] = ["USDT", "USDC"];
const CHAINS: Record<Asset, Chain[]> = {
  USDT: ["Tron", "Ethereum", "Kaia", "Aptos"],
  USDC: ["Ethereum", "Solana"],
};

const CHAIN_LABELS: Record<Chain, string> = {
  Tron: "TRON",
  Ethereum: "ETH",
  Kaia: "KAIA",
  Aptos: "APTOS",
  Solana: "SOL",
};

const DEFAULT_TRADING_FEES: TradingFeeSettings = {
  foreign: {
    Binance: 0.001,
    Bitget: 0.001,
    Bybit: 0.001,
    OKX: 0.001,
  },
  domestic: {
    Upbit: 0.0005,
    Bithumb: 0.0004,
  },
};

function fallbackOrderbook(
  bid: number,
  ask: number,
  fallbackAsset: Asset,
) {
  const multiplier = fallbackAsset === "USDT" ? 1 : 0.86;
  const sizes = [2_500, 5_000, 9_000, 15_000, 24_000, 38_000, 60_000];
  return {
    bids: sizes.map((size, index) => ({
      price: Math.max(1, bid - index),
      size: size * multiplier,
    })),
    asks: sizes.map((size, index) => ({
      price: ask + index,
      size: size * multiplier * 0.92,
    })),
  };
}

function fallbackForeignOrderbook(bid: number, ask: number) {
  const sizes = [5_000, 10_000, 20_000, 35_000, 60_000, 100_000];
  return {
    bids: sizes.map((size, index) => ({
      price: Math.max(0.0001, bid - index * 0.0001),
      size,
    })),
    asks: sizes.map((size, index) => ({
      price: ask + index * 0.0001,
      size: size * 0.92,
    })),
  };
}

const DEFAULT_FEES: FeeMatrix = {
  Binance: {
    USDT: { Tron: 1.5, Ethereum: 0.4, Kaia: 0.02, Aptos: 0.1 },
    USDC: { Ethereum: 0.6, Solana: 0.3 },
  },
  Bitget: {
    USDT: { Tron: 1, Ethereum: 4, Kaia: 0.1, Aptos: 0.1 },
    USDC: { Ethereum: 4, Solana: 1 },
  },
  Bybit: {
    USDT: { Tron: 1, Ethereum: 0.8, Kaia: 0.1, Aptos: 0 },
    USDC: { Ethereum: 0.8, Solana: 1 },
  },
  OKX: {
    USDT: { Tron: 1.5, Ethereum: 2.6, Aptos: 0.0014 },
    USDC: { Ethereum: 2.6, Solana: 0.1 },
  },
  Upbit: {
    USDT: { Tron: 1 },
    USDC: { Ethereum: 1, Solana: 1 },
  },
  Bithumb: {
    USDT: { Tron: 1 },
    USDC: { Ethereum: 1, Solana: 1 },
  },
};

const FALLBACK_MARKET: MarketPayload = {
  foreign: EXCHANGES.map((exchange) => ({
    exchange,
    bid: 0.9997,
    ask: 1.0003,
    last: 1,
    ...fallbackForeignOrderbook(0.9997, 1.0003),
    source: "unavailable",
    checkedAt: new Date(0).toISOString(),
    reason: "CONNECTING",
  })),
  domestic: DOMESTIC_EXCHANGES.flatMap((exchange, exchangeIndex) =>
    ASSETS.map((asset, assetIndex) => {
      const bid = 1385 - exchangeIndex - assetIndex;
      const ask = 1386 - exchangeIndex;
      return {
        exchange,
        asset,
        bid,
        ask,
        ...fallbackOrderbook(bid, ask, asset),
        source: "unavailable" as const,
        checkedAt: new Date(0).toISOString(),
        reason: "CONNECTING",
      };
    }),
  ),
  updatedAt: new Date(0).toISOString(),
  hasFallback: true,
};

const krwFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});
const coinFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function mergeFees(
  current: FeeMatrix,
  liveFees: MarketPayload["liveFees"],
): FeeMatrix {
  const bitget = liveFees?.Bitget;
  if (!bitget) return current;
  const usdt =
    bitget.USDT &&
    bitget.USDT.source !== "unavailable" &&
    Object.keys(bitget.USDT.fees).length > 0
      ? { ...bitget.USDT.fees }
      : { ...current.Bitget.USDT };
  const usdc =
    bitget.USDC &&
    bitget.USDC.source !== "unavailable" &&
    Object.keys(bitget.USDC.fees).length > 0
      ? { ...bitget.USDC.fees }
      : { ...current.Bitget.USDC };
  return {
    ...current,
    Bitget: {
      USDT: usdt,
      USDC: usdc,
    },
  };
}

function createManualFeeSources(): FeeSourceMatrix {
  return Object.fromEntries(
    FEE_EXCHANGES.map((exchange) => [
      exchange,
      { USDT: "manual", USDC: "manual" },
    ]),
  ) as FeeSourceMatrix;
}

function resolveFeeSources(
  liveFees: MarketPayload["liveFees"],
): FeeSourceMatrix {
  const sources = createManualFeeSources();
  for (const feeAsset of ASSETS) {
    const result = liveFees?.Bitget?.[feeAsset];
    if (
      result &&
      result.source !== "unavailable" &&
      Object.keys(result.fees).length > 0
    ) {
      sources.Bitget[feeAsset] = result.source;
    }
  }
  return sources;
}

function sourceLabel(source: QuoteSource) {
  if (source === "live") return "live";
  if (source === "stale") return "stale";
  return "unavailable";
}

function feeSourceLabel(source: FeeSource) {
  if (source === "live") return "API 반영";
  if (source === "stale") return "최근 API 값";
  return "편집값";
}

function browserNumeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseBrowserForeignOrderbook(
  bidValues: unknown,
  askValues: unknown,
  lastValue?: unknown,
) {
  const parseLevels = (values: unknown, side: "bid" | "ask") => {
    if (!Array.isArray(values)) return [];
    return values
      .map((item) => {
        if (!Array.isArray(item)) return null;
        const price = browserNumeric(item[0]);
        const size = browserNumeric(item[1]);
        return price && size ? { price, size } : null;
      })
      .filter((item): item is OrderLevel => item !== null)
      .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  };
  const bids = parseLevels(bidValues, "bid");
  const asks = parseLevels(askValues, "ask");
  const bid = bids[0]?.price ?? 0;
  const ask = asks[0]?.price ?? 0;
  const last = browserNumeric(lastValue) || (bid + ask) / 2;
  if (!bid || !ask || !last) throw new Error("No usable quote");
  return { bid, ask, last, bids, asks };
}

async function fetchBrowserJson(url: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return {
      data: (await response.json()) as unknown,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

const BROWSER_FOREIGN_LOADERS: Record<
  Exchange,
  {
    url: string;
    parse: (raw: unknown) => {
      bid: number;
      ask: number;
      last: number;
      bids: OrderLevel[];
      asks: OrderLevel[];
    };
  }
> = {
  Binance: {
    url: "https://data-api.binance.vision/api/v3/depth?symbol=USDCUSDT&limit=50",
    parse: (raw) => {
      const data = raw as Record<string, unknown>;
      return parseBrowserForeignOrderbook(data.bids, data.asks);
    },
  },
  Bitget: {
    url: "https://api.bitget.com/api/v2/spot/market/orderbook?symbol=USDCUSDT&type=step0&limit=50",
    parse: (raw) => {
      const response = raw as { data?: Record<string, unknown> };
      const data = response.data ?? {};
      return parseBrowserForeignOrderbook(data.bids, data.asks);
    },
  },
  Bybit: {
    url: "https://api.bybit.com/v5/market/orderbook?category=spot&symbol=USDCUSDT&limit=50",
    parse: (raw) => {
      const response = raw as { result?: Record<string, unknown> };
      const data = response.result ?? {};
      return parseBrowserForeignOrderbook(data.b, data.a);
    },
  },
  OKX: {
    url: "https://www.okx.com/api/v5/market/books?instId=USDC-USDT&sz=50",
    parse: (raw) => {
      const response = raw as { data?: Array<Record<string, unknown>> };
      const data = response.data?.[0] ?? {};
      return parseBrowserForeignOrderbook(data.bids, data.asks);
    },
  },
};

function normalizeBrowserChain(value: unknown): Chain | null {
  const chain = String(value ?? "").toUpperCase();
  if (chain.includes("TRC") || chain.includes("TRON")) return "Tron";
  if (chain.includes("ERC") || chain === "ETH" || chain.includes("ETHEREUM"))
    return "Ethereum";
  if (chain.includes("KAIA") || chain.includes("KLAY")) return "Kaia";
  if (chain.includes("APT")) return "Aptos";
  if (chain.includes("SOL") || chain.includes("SPL")) return "Solana";
  return null;
}

async function recoverBrowserFee(
  asset: Asset,
  current?: FeeAssetPayload,
): Promise<FeeAssetPayload> {
  if (current?.source === "live") return current;
  const url = `https://api.bitget.com/api/v2/spot/public/coins?coin=${asset}`;
  try {
    const response = await fetchBrowserJson(url);
    const raw = response.data as {
      data?: Array<{
        chains?: Array<{
          chain?: string;
          chainType?: string;
          withdrawFee?: string;
          withdrawable?: string | boolean;
        }>;
      }>;
    };
    const fees: Partial<Record<Chain, number>> = {};
    for (const item of raw.data?.[0]?.chains ?? []) {
      const chain = normalizeBrowserChain(item.chainType ?? item.chain);
      const fee = Number(item.withdrawFee);
      if (
        chain &&
        CHAINS[asset].includes(chain) &&
        Number.isFinite(fee) &&
        fee >= 0 &&
        String(item.withdrawable ?? "true").toLowerCase() !== "false"
      ) {
        fees[chain] = fee;
      }
    }
    const supportedChains = Object.keys(fees) as Chain[];
    if (supportedChains.length === 0) throw new Error("No compatible chains");
    return {
      fees,
      supportedChains,
      source: "live",
      checkedAt: new Date().toISOString(),
      endpoint: new URL(url).host,
      latencyMs: response.latencyMs,
    };
  } catch {
    return (
      current ?? {
        fees: {},
        supportedChains: [],
        source: "unavailable",
        checkedAt: new Date().toISOString(),
        reason: "BROWSER_RECOVERY_FAILED",
      }
    );
  }
}

async function recoverBrowserMarket(
  payload: MarketPayload,
): Promise<MarketPayload> {
  const foreign = await Promise.all(
    payload.foreign.map(async (quote) => {
      if (quote.source === "live") return quote;
      const loader = BROWSER_FOREIGN_LOADERS[quote.exchange];
      try {
        const response = await fetchBrowserJson(loader.url);
        return {
          exchange: quote.exchange,
          ...loader.parse(response.data),
          source: "live" as const,
          checkedAt: new Date().toISOString(),
          endpoint: new URL(loader.url).host,
          latencyMs: response.latencyMs,
        };
      } catch {
        return quote;
      }
    }),
  );
  const [usdtFees, usdcFees] = await Promise.all([
    recoverBrowserFee("USDT", payload.liveFees?.Bitget?.USDT),
    recoverBrowserFee("USDC", payload.liveFees?.Bitget?.USDC),
  ]);
  const liveFees = {
    ...payload.liveFees,
    Bitget: { USDT: usdtFees, USDC: usdcFees },
  };
  const quotesLive =
    foreign.every((quote) => quote.source === "live") &&
    payload.domestic.every((quote) => quote.source === "live");
  const feesLive = [usdtFees, usdcFees].every(
    (result) => result.source === "live",
  );
  return {
    ...payload,
    foreign,
    liveFees,
    quality: {
      quotes: quotesLive ? "live" : "partial",
      fees: feesLive ? "live" : "partial",
    },
    hasFallback: !quotesLive || !feesLive,
  };
}

function displayTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return "연결 대기";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function executeMarketSell(quantity: number, bids: OrderLevel[]) {
  const sortedBids = [...bids]
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        Number.isFinite(level.size) &&
        level.size > 0,
    )
    .sort((a, b) => b.price - a.price);
  const visibleBidLiquidity = sortedBids.reduce(
    (total, level) => total + level.size,
    0,
  );
  const topBid = sortedBids[0]?.price ?? 0;
  let remaining = quantity;
  let filledQuantity = 0;
  let grossKrw = 0;
  let levelsUsed = 0;

  for (const level of sortedBids) {
    if (remaining <= 0.00000001) break;
    const fillSize = Math.min(remaining, level.size);
    if (fillSize <= 0) continue;
    filledQuantity += fillSize;
    grossKrw += fillSize * level.price;
    remaining -= fillSize;
    levelsUsed += 1;
  }

  const unfilledQuantity = Math.max(0, quantity - filledQuantity);
  const fillRatio = quantity > 0 ? filledQuantity / quantity : 0;
  const averageSellPrice =
    filledQuantity > 0 ? grossKrw / filledQuantity : 0;
  const slippageBps =
    topBid > 0 && averageSellPrice > 0
      ? Math.max(0, ((topBid - averageSellPrice) / topBid) * 10_000)
      : 0;

  return {
    filledQuantity,
    unfilledQuantity,
    fillRatio,
    fullyFillable: unfilledQuantity <= Math.max(0.000001, quantity * 0.000001),
    grossKrw,
    averageSellPrice,
    topBid,
    slippageBps,
    levelsUsed,
    visibleBidLiquidity,
  };
}

function executeMarketBuy(budgetKrw: number, asks: OrderLevel[]) {
  const sortedAsks = [...asks]
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        Number.isFinite(level.size) &&
        level.size > 0,
    )
    .sort((a, b) => a.price - b.price);
  const visibleAskValue = sortedAsks.reduce(
    (total, level) => total + level.price * level.size,
    0,
  );
  const topAsk = sortedAsks[0]?.price ?? 0;
  let remainingKrw = budgetKrw;
  let spentKrw = 0;
  let boughtQuantity = 0;
  let levelsUsed = 0;

  for (const level of sortedAsks) {
    if (remainingKrw <= 0.01) break;
    const levelValue = level.price * level.size;
    const spend = Math.min(remainingKrw, levelValue);
    if (spend <= 0) continue;
    spentKrw += spend;
    boughtQuantity += spend / level.price;
    remainingKrw -= spend;
    levelsUsed += 1;
  }

  const fillRatio = budgetKrw > 0 ? spentKrw / budgetKrw : 0;
  const averageBuyPrice =
    boughtQuantity > 0 ? spentKrw / boughtQuantity : 0;
  const slippageBps =
    topAsk > 0 && averageBuyPrice > 0
      ? Math.max(0, ((averageBuyPrice - topAsk) / topAsk) * 10_000)
      : 0;

  return {
    boughtQuantity,
    spentKrw,
    unspentKrw: Math.max(0, budgetKrw - spentKrw),
    fillRatio,
    fullyFillable:
      remainingKrw <= Math.max(1, budgetKrw * 0.000001),
    averageBuyPrice,
    topAsk,
    slippageBps,
    levelsUsed,
    visibleAskValue,
  };
}

function executeForeignSwap(
  startAsset: Asset,
  transferAsset: Asset,
  quantity: number,
  quote: MarketPayload["foreign"][number] | undefined,
  feeRate: number,
) {
  if (startAsset === transferAsset) {
    return {
      outputQuantity: quantity,
      foreignFilledInput: quantity,
      foreignUnfilledInput: 0,
      foreignFillRatio: 1,
      foreignFullyFillable: true,
      foreignAveragePrice: 1,
      foreignSlippageBps: 0,
      foreignLevelsUsed: 0,
    };
  }

  if (!quote || quote.source !== "live") {
    return {
      outputQuantity: 0,
      foreignFilledInput: 0,
      foreignUnfilledInput: quantity,
      foreignFillRatio: 0,
      foreignFullyFillable: false,
      foreignAveragePrice: 0,
      foreignSlippageBps: 0,
      foreignLevelsUsed: 0,
    };
  }

  let foreignFilledInput = 0;
  let grossOutput = 0;
  let foreignLevelsUsed = 0;
  let foreignAveragePrice = 0;
  let foreignSlippageBps = 0;

  if (startAsset === "USDC" && transferAsset === "USDT") {
    const bids = [...quote.bids].sort((a, b) => b.price - a.price);
    let remainingUsdc = quantity;
    for (const level of bids) {
      if (remainingUsdc <= 0.00000001) break;
      const soldUsdc = Math.min(remainingUsdc, level.size);
      if (soldUsdc <= 0) continue;
      foreignFilledInput += soldUsdc;
      grossOutput += soldUsdc * level.price;
      remainingUsdc -= soldUsdc;
      foreignLevelsUsed += 1;
    }
    foreignAveragePrice =
      foreignFilledInput > 0 ? grossOutput / foreignFilledInput : 0;
    const topBid = bids[0]?.price ?? 0;
    foreignSlippageBps =
      topBid > 0 && foreignAveragePrice > 0
        ? Math.max(
            0,
            ((topBid - foreignAveragePrice) / topBid) * 10_000,
          )
        : 0;
  } else {
    const asks = [...quote.asks].sort((a, b) => a.price - b.price);
    let remainingUsdt = quantity;
    for (const level of asks) {
      if (remainingUsdt <= 0.00000001) break;
      const availableCost = level.price * level.size;
      const spentUsdt = Math.min(remainingUsdt, availableCost);
      const boughtUsdc = spentUsdt / level.price;
      if (boughtUsdc <= 0) continue;
      foreignFilledInput += spentUsdt;
      grossOutput += boughtUsdc;
      remainingUsdt -= spentUsdt;
      foreignLevelsUsed += 1;
    }
    foreignAveragePrice =
      grossOutput > 0 ? foreignFilledInput / grossOutput : 0;
    const topAsk = asks[0]?.price ?? 0;
    foreignSlippageBps =
      topAsk > 0 && foreignAveragePrice > 0
        ? Math.max(
            0,
            ((foreignAveragePrice - topAsk) / topAsk) * 10_000,
          )
        : 0;
  }

  const foreignUnfilledInput = Math.max(0, quantity - foreignFilledInput);
  const foreignFillRatio = quantity > 0 ? foreignFilledInput / quantity : 0;
  const foreignFullyFillable =
    foreignUnfilledInput <= Math.max(0.000001, quantity * 0.000001);

  return {
    outputQuantity: grossOutput * (1 - feeRate),
    foreignFilledInput,
    foreignUnfilledInput,
    foreignFillRatio,
    foreignFullyFillable,
    foreignAveragePrice,
    foreignSlippageBps,
    foreignLevelsUsed,
  };
}

export default function Home() {
  const [direction, setDirection] = useState<TransferDirection>("toKrw");
  const [holdingAsset, setHoldingAsset] = useState<Asset>("USDT");
  const [selectedTransferAsset, setSelectedTransferAsset] =
    useState<Asset>("USDT");
  const [amount, setAmount] = useState("10000");
  const [transferCount, setTransferCount] = useState(1);
  const [selectedExchange, setSelectedExchange] = useState<Exchange | "all">(
    "all",
  );
  const [selectedDomesticExchange, setSelectedDomesticExchange] =
    useState<DomesticExchange>("Upbit");
  const [selectedDomesticSource, setSelectedDomesticSource] = useState<
    DomesticExchange | "all"
  >("all");
  const [selectedForeignOrderbookExchange, setSelectedForeignOrderbookExchange] =
    useState<Exchange>("Binance");
  const [orderbookView, setOrderbookView] =
    useState<OrderbookView>("domestic");
  const [market, setMarket] = useState<MarketPayload>(FALLBACK_MARKET);
  const [fees, setFees] = useState<FeeMatrix>(DEFAULT_FEES);
  const [tradingFees, setTradingFees] =
    useState<TradingFeeSettings>(DEFAULT_TRADING_FEES);
  const [feeSources, setFeeSources] = useState<FeeSourceMatrix>(
    createManualFeeSources,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFeePanel, setActiveFeePanel] = useState<
    "withdrawal" | "trading" | null
  >(null);
  const [expandedRows, setExpandedRows] = useState(false);
  const hasSavedFees = useRef(false);

  useEffect(() => {
    let restoreTimer: number | undefined;
    try {
      const stored = localStorage.getItem("stablepath-fees");
      if (stored) {
        const savedFees = JSON.parse(stored) as FeeMatrix;
        restoreTimer = window.setTimeout(() => {
          setFees(savedFees);
          setFeeSources(createManualFeeSources());
          hasSavedFees.current = true;
        }, 0);
      }
    } catch {
      // Invalid local preferences fall back to the maintained defaults.
    }
    return () => {
      if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
    };
  }, []);

  useEffect(() => {
    let restoreTimer: number | undefined;
    try {
      const stored = localStorage.getItem("stablepath-trading-fees");
      if (stored) {
        const saved = JSON.parse(stored) as Partial<TradingFeeSettings>;
        restoreTimer = window.setTimeout(() => {
          setTradingFees({
            foreign: {
              ...DEFAULT_TRADING_FEES.foreign,
              ...saved.foreign,
            },
            domestic: {
              ...DEFAULT_TRADING_FEES.domestic,
              ...saved.domestic,
            },
          });
        }, 0);
      }
    } catch {
      // Invalid local preferences fall back to the maintained defaults.
    }
    return () => {
      if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
    };
  }, []);

  const refreshMarket = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/market", { cache: "no-store" });
      if (!response.ok) throw new Error("quote fetch failed");
      const payload = (await response.json()) as MarketPayload;
      const recovered = await recoverBrowserMarket(payload);
      setMarket(recovered);
      if (!hasSavedFees.current) {
        setFees(mergeFees(DEFAULT_FEES, recovered.liveFees));
        setFeeSources(resolveFeeSources(recovered.liveFees));
      }
    } catch {
      setMarket((current) => ({ ...current, hasFallback: true }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => refreshMarket(), 0);
    const interval = window.setInterval(() => refreshMarket(), 20_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [refreshMarket]);

  const routes = useMemo<RouteResult[]>(() => {
    const parsedAmount = Number(amount.replaceAll(",", ""));
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return [];

    const candidates: RouteResult[] = [];
    const activeExchanges =
      selectedExchange === "all" ? EXCHANGES : [selectedExchange];

    if (direction === "toKrw") {
      for (const exchange of activeExchanges) {
        const foreign = market.foreign.find(
          (quote) => quote.exchange === exchange,
        );
        const transferAsset = selectedTransferAsset;
        const converted = transferAsset !== holdingAsset;
        const foreignExecution = executeForeignSwap(
          holdingAsset,
          transferAsset,
          parsedAmount,
          foreign,
          tradingFees.foreign[exchange],
        );
        const quantityAfterSwap = foreignExecution.outputQuantity;
        if (!quantityAfterSwap) continue;

        for (const chain of CHAINS[transferAsset]) {
          const withdrawalFee = fees[exchange][transferAsset][chain];
          if (
            withdrawalFee === undefined ||
            !Number.isFinite(withdrawalFee) ||
            withdrawalFee < 0
          ) {
            continue;
          }

          const totalWithdrawalFee = withdrawalFee * transferCount;
          const netQuantity = Math.max(
            0,
            quantityAfterSwap - totalWithdrawalFee,
          );
          if (!netQuantity) continue;

          for (const domestic of DOMESTIC_EXCHANGES) {
            const domesticQuote = market.domestic.find(
              (quote) =>
                quote.exchange === domestic && quote.asset === transferAsset,
            );
            if (!domesticQuote || domesticQuote.source !== "live") continue;

            const execution = executeMarketSell(
              netQuantity,
              domesticQuote.bids,
            );
            const fullyFillable =
              foreignExecution.foreignFullyFillable &&
              execution.fullyFillable;
            const fillRatio =
              foreignExecution.foreignFillRatio * execution.fillRatio;
            const krw =
              execution.grossKrw * (1 - tradingFees.domestic[domestic]);
            const feeSource = feeSources[exchange][transferAsset];
            const source: RouteSource =
              feeSource === "live" ? "live" : "estimate";

            candidates.push({
              id: [
                direction,
                exchange,
                holdingAsset,
                transferAsset,
                chain,
                domestic,
              ].join("-"),
              direction,
              exchange,
              startAsset: holdingAsset,
              transferAsset,
              domestic,
              chain,
              withdrawalFee,
              totalWithdrawalFee,
              transferCount,
              quantityAfterSwap,
              netQuantity,
              ...execution,
              fullyFillable,
              fillRatio,
              krw,
              inputAmount: parsedAmount,
              outputAmount: krw,
              averageDomesticPrice: execution.averageSellPrice,
              domesticSlippageBps: execution.slippageBps,
              domesticLevelsUsed: execution.levelsUsed,
              source,
              feeSource,
              converted,
              foreignFilledInput: foreignExecution.foreignFilledInput,
              foreignUnfilledInput: foreignExecution.foreignUnfilledInput,
              foreignFillRatio: foreignExecution.foreignFillRatio,
              foreignFullyFillable:
                foreignExecution.foreignFullyFillable,
              foreignAveragePrice: foreignExecution.foreignAveragePrice,
              foreignSlippageBps: foreignExecution.foreignSlippageBps,
              foreignLevelsUsed: foreignExecution.foreignLevelsUsed,
            });
          }
        }
      }
    } else {
      const activeDomesticExchanges =
        selectedDomesticSource === "all"
          ? DOMESTIC_EXCHANGES
          : [selectedDomesticSource];

      for (const domestic of activeDomesticExchanges) {
        const domesticQuote = market.domestic.find(
          (quote) =>
            quote.exchange === domestic && quote.asset === holdingAsset,
        );
        if (!domesticQuote || domesticQuote.source !== "live") continue;
        const spendableKrw =
          parsedAmount * (1 - tradingFees.domestic[domestic]);
        const purchase = executeMarketBuy(spendableKrw, domesticQuote.asks);
        if (!purchase.boughtQuantity) continue;

        for (const chain of CHAINS[holdingAsset]) {
          const withdrawalFee = fees[domestic][holdingAsset][chain];
          if (
            withdrawalFee === undefined ||
            !Number.isFinite(withdrawalFee) ||
            withdrawalFee < 0
          ) {
            continue;
          }
          const totalWithdrawalFee = withdrawalFee * transferCount;
          const netTransferQuantity = Math.max(
            0,
            purchase.boughtQuantity - totalWithdrawalFee,
          );
          if (!netTransferQuantity) continue;

          for (const exchange of activeExchanges) {
            const foreign = market.foreign.find(
              (quote) => quote.exchange === exchange,
            );
            const foreignExecution = executeForeignSwap(
              holdingAsset,
              selectedTransferAsset,
              netTransferQuantity,
              foreign,
              tradingFees.foreign[exchange],
            );
            const outputAmount = foreignExecution.outputQuantity;
            if (!outputAmount) continue;
            const fullyFillable =
              purchase.fullyFillable &&
              foreignExecution.foreignFullyFillable;
            const fillRatio =
              purchase.fillRatio * foreignExecution.foreignFillRatio;
            const feeSource = feeSources[domestic][holdingAsset];
            const source: RouteSource =
              feeSource === "live" ? "live" : "estimate";

            candidates.push({
              id: [
                direction,
                domestic,
                holdingAsset,
                chain,
                exchange,
                selectedTransferAsset,
              ].join("-"),
              direction,
              exchange,
              startAsset: holdingAsset,
              transferAsset: selectedTransferAsset,
              domestic,
              chain,
              withdrawalFee,
              totalWithdrawalFee,
              transferCount,
              quantityAfterSwap: purchase.boughtQuantity,
              netQuantity: outputAmount,
              filledQuantity: purchase.boughtQuantity,
              unfilledQuantity:
                purchase.averageBuyPrice > 0
                  ? purchase.unspentKrw / purchase.averageBuyPrice
                  : 0,
              fillRatio,
              fullyFillable,
              grossKrw: purchase.spentKrw,
              averageSellPrice: purchase.averageBuyPrice,
              topBid: purchase.topAsk,
              slippageBps: purchase.slippageBps,
              levelsUsed: purchase.levelsUsed,
              visibleBidLiquidity: purchase.visibleAskValue,
              krw: parsedAmount,
              inputAmount: parsedAmount,
              outputAmount,
              averageDomesticPrice: purchase.averageBuyPrice,
              domesticSlippageBps: purchase.slippageBps,
              domesticLevelsUsed: purchase.levelsUsed,
              source,
              feeSource,
              converted: holdingAsset !== selectedTransferAsset,
              foreignFilledInput: foreignExecution.foreignFilledInput,
              foreignUnfilledInput: foreignExecution.foreignUnfilledInput,
              foreignFillRatio: foreignExecution.foreignFillRatio,
              foreignFullyFillable:
                foreignExecution.foreignFullyFillable,
              foreignAveragePrice: foreignExecution.foreignAveragePrice,
              foreignSlippageBps: foreignExecution.foreignSlippageBps,
              foreignLevelsUsed: foreignExecution.foreignLevelsUsed,
            });
          }
        }
      }
    }

    return candidates.sort((a, b) => {
      if (a.fullyFillable !== b.fullyFillable) {
        return a.fullyFillable ? -1 : 1;
      }
      if (!a.fullyFillable && !b.fullyFillable && a.fillRatio !== b.fillRatio) {
        return b.fillRatio - a.fillRatio;
      }
      return b.outputAmount - a.outputAmount;
    });
  }, [
    amount,
    direction,
    holdingAsset,
    feeSources,
    fees,
    market,
    selectedDomesticSource,
    selectedExchange,
    selectedTransferAsset,
    tradingFees,
    transferCount,
  ]);

  const fullyFillableRoutes = routes.filter((route) => route.fullyFillable);
  const best = fullyFillableRoutes[0];
  const runnerUp = fullyFillableRoutes[1];
  const numericAmount = Number(amount.replaceAll(",", "")) || 0;
  const visibleRoutes = expandedRows ? routes : routes.slice(0, 8);
  const selectedForeignQuote = market.foreign.find(
    (quote) => quote.exchange === selectedForeignOrderbookExchange,
  );

  const updateFee = (
    exchange: FeeExchange,
    feeAsset: Asset,
    chain: Chain,
    value: string,
  ) => {
    const assetFees = { ...fees[exchange][feeAsset] };
    if (value.trim() === "") {
      delete assetFees[chain];
    } else {
      const parsed = Number(value);
      assetFees[chain] =
        Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    const next: FeeMatrix = {
      ...fees,
      [exchange]: {
        ...fees[exchange],
        [feeAsset]: assetFees,
      },
    };
    setFees(next);
    setFeeSources((current) => ({
      ...current,
      [exchange]: {
        ...current[exchange],
        [feeAsset]: "manual",
      },
    }));
    hasSavedFees.current = true;
    localStorage.setItem("stablepath-fees", JSON.stringify(next));
  };

  const resetFees = () => {
    const next = mergeFees(DEFAULT_FEES, market.liveFees);
    setFees(next);
    setFeeSources(resolveFeeSources(market.liveFees));
    hasSavedFees.current = false;
    localStorage.removeItem("stablepath-fees");
  };

  const updateTradingFee = (
    group: keyof TradingFeeSettings,
    exchange: Exchange | DomesticExchange,
    percentageValue: string,
  ) => {
    const parsed = Number(percentageValue);
    const rate =
      Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 100) / 100 : 0;
    const next: TradingFeeSettings = {
      ...tradingFees,
      [group]: {
        ...tradingFees[group],
        [exchange]: rate,
      },
    };
    setTradingFees(next);
    localStorage.setItem("stablepath-trading-fees", JSON.stringify(next));
  };

  const resetTradingFees = () => {
    setTradingFees(DEFAULT_TRADING_FEES);
    localStorage.removeItem("stablepath-trading-fees");
  };

  const qualityIssues = [
    ...market.foreign
      .filter((quote) => quote.source !== "live")
      .map(
        (quote) =>
          `${quote.exchange} 환전 시세 ${sourceLabel(quote.source)}`,
      ),
    ...market.domestic
      .filter((quote) => quote.source !== "live")
      .map(
        (quote) =>
          `${quote.exchange} ${quote.asset} 호가 ${sourceLabel(quote.source)}`,
      ),
    ...ASSETS.flatMap((feeAsset) => {
      const result = market.liveFees?.Bitget?.[feeAsset];
      return result && result.source !== "live"
        ? [`Bitget ${feeAsset} 수수료 ${sourceLabel(result.source)}`]
        : [];
    }),
  ];

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="StablePath 홈">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>STABLEPATH</span>
        </a>
        <div className="header-actions">
          <span
            className={`live-status ${market.hasFallback ? "is-partial" : ""}`}
          >
            <span className="status-dot" />
            {loading
              ? "시세 연결 중"
              : market.hasFallback
                ? "일부 예상 시세"
                : "실시간 연결"}
          </span>
          <div className="fee-edit-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={() => setActiveFeePanel("withdrawal")}
            >
              출금 수수료 편집
            </button>
            <button
              className="ghost-button trading-fee-button"
              type="button"
              onClick={() => setActiveFeePanel("trading")}
            >
              거래 수수료 편집
            </button>
          </div>
        </div>
      </header>

      {!loading && qualityIssues.length > 0 && (
        <div className="data-quality-banner" role="status">
          <span>!</span>
          <div>
            <strong>일부 실시간 데이터를 확인하지 못했습니다.</strong>
            <p>
              실시간 환전 시세나 국내 호가가 없는 경로는 추천에서 제외합니다.
              수수료가 없을 때만 편집값을 예상치로 사용합니다.
            </p>
            <small>{qualityIssues.join(" · ")}</small>
          </div>
        </div>
      )}

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">STABLECOIN ↔ KRW ROUTE FINDER</p>
          <h1>
            원화 효율 <span>계산기</span>
          </h1>
          <p className="hero-description">
            <span>
              스테이블 코인 ↔ 국내거래소 원화 / 가장 유리한 방법을 찾습니다.
            </span>
            <span>체인별 출금 수수료 및 매매 호가 반영.</span>
          </p>
        </div>
      </section>

      <section className="planner-section" aria-label="전송 효율 계산">
        <div className="calculator-card" aria-label="경로 계산 조건">
          <div className="card-topline">
            <span>계산 조건</span>
            <span className="market-time">
              시세 기준 {displayTime(market.updatedAt)}
            </span>
          </div>

          <div
            className="direction-switch"
            role="group"
            aria-label="계산 방향 선택"
          >
            <button
              type="button"
              className={direction === "toKrw" ? "active" : ""}
              onClick={() => setDirection("toKrw")}
              aria-pressed={direction === "toKrw"}
            >
              해외 코인 <span>→</span> 국내 원화
            </button>
            <button
              type="button"
              className={direction === "fromKrw" ? "active" : ""}
              onClick={() => setDirection("fromKrw")}
              aria-pressed={direction === "fromKrw"}
            >
              국내 원화 <span>→</span> 해외 코인
            </button>
          </div>

          <div className="asset-choice-grid">
            <div className="asset-choice-field">
              <div className="asset-choice-label">
                <span>
                  {direction === "toKrw" ? "보유 자산" : "국내 매수 자산"}
                </span>
                <small>
                  {direction === "toKrw"
                    ? "현재 가지고 있는 코인"
                    : "원화로 먼저 매수할 코인"}
                </small>
              </div>
              <div
                className="asset-switch"
                role="group"
                aria-label="보유 자산 선택"
              >
                {ASSETS.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={holdingAsset === item ? "active" : ""}
                    onClick={() => setHoldingAsset(item)}
                    aria-pressed={holdingAsset === item}
                  >
                    <span className={`coin-dot ${item.toLowerCase()}`}>$</span>
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div className="asset-choice-field">
              <div className="asset-choice-label">
                <span>
                  {direction === "toKrw" ? "전송할 자산" : "해외 도착 자산"}
                </span>
                <small>
                  {direction === "toKrw"
                    ? "국내거래소로 보낼 코인"
                    : "해외거래소에서 최종 보유할 코인"}
                </small>
              </div>
              <div
                className="asset-switch"
                role="group"
                aria-label="전송할 자산 선택"
              >
                {ASSETS.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={selectedTransferAsset === item ? "active" : ""}
                    onClick={() => setSelectedTransferAsset(item)}
                    aria-pressed={selectedTransferAsset === item}
                  >
                    <span className={`coin-dot ${item.toLowerCase()}`}>$</span>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="amount-label" htmlFor="amount">
            <span>{direction === "toKrw" ? "수량" : "원화 금액"}</span>
            <span>{direction === "toKrw" ? holdingAsset : "KRW"}</span>
          </label>
          <input
            id="amount"
            className="amount-input"
            inputMode="decimal"
            value={amount}
            onChange={(event) =>
              setAmount(event.target.value.replace(/[^0-9.]/g, ""))
            }
            aria-describedby="amount-help"
          />
          <p id="amount-help" className="field-help">
            {direction === "toKrw"
              ? "전송 전 해외거래소에 보유한 수량을 입력하세요."
              : "국내거래소에서 매수에 사용할 원화 금액을 입력하세요."}
          </p>

          <div className="transfer-count-field">
            <div className="exchange-label">
              <span>전송 횟수</span>
              <span>매회 출금 수수료 차감</span>
            </div>
            <div
              className="transfer-count-buttons"
              role="group"
              aria-label="전송 횟수 선택"
            >
              {[1, 2, 3, 4].map((count) => (
                <button
                  type="button"
                  key={count}
                  className={transferCount === count ? "active" : ""}
                  onClick={() => setTransferCount(count)}
                  aria-pressed={transferCount === count}
                >
                  {count}회
                </button>
              ))}
            </div>
            <p className="field-help">
              테스트 전송 후 나머지를 보내거나 여러 번 나눠 보낼 때 반영됩니다.
            </p>
          </div>

          {direction === "fromKrw" && (
            <>
              <div className="exchange-label">
                <span>출발 국내거래소</span>
                <span>전체 선택 시 2곳 동시 비교</span>
              </div>
              <div
                className="exchange-grid domestic-source-grid"
                role="group"
                aria-label="출발 국내거래소 선택"
              >
                <button
                  type="button"
                  className={selectedDomesticSource === "all" ? "active" : ""}
                  onClick={() => setSelectedDomesticSource("all")}
                >
                  전체
                </button>
                {DOMESTIC_EXCHANGES.map((exchange) => (
                  <button
                    type="button"
                    key={exchange}
                    className={
                      selectedDomesticSource === exchange ? "active" : ""
                    }
                    onClick={() => setSelectedDomesticSource(exchange)}
                  >
                    {exchange === "Upbit" ? "업비트" : "빗썸"}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="exchange-label">
            <span>
              {direction === "toKrw" ? "보유 해외거래소" : "도착 해외거래소"}
            </span>
            <span>전체 선택 시 4곳 동시 비교</span>
          </div>
          <div className="exchange-grid" role="group" aria-label="해외거래소 선택">
            <button
              type="button"
              className={selectedExchange === "all" ? "active" : ""}
              onClick={() => setSelectedExchange("all")}
            >
              전체
            </button>
            {EXCHANGES.map((exchange) => (
              <button
                type="button"
                key={exchange}
                className={selectedExchange === exchange ? "active" : ""}
                onClick={() => {
                  setSelectedExchange(exchange);
                  setSelectedForeignOrderbookExchange(exchange);
                }}
              >
                {exchange}
              </button>
            ))}
          </div>
        </div>
        <aside className="result-card" aria-live="polite">
          <div className="best-heading">
            <div>
              <p className="eyebrow lime">BEST ROUTE</p>
              <h2>
                {direction === "toKrw"
                  ? "예상 원화 도착액"
                  : "예상 해외 도착 수량"}
              </h2>
            </div>
            {best && (
              <span className={`quote-badge ${best.source}`}>
                {best.source === "live"
                  ? "LIVE"
                  : best.feeSource === "stale"
                    ? "STALE FEE"
                    : "EDITED FEE"}
              </span>
            )}
          </div>

          {best ? (
            <>
              <p className="arrival-value">
                {direction === "toKrw"
                  ? krwFormatter.format(best.outputAmount)
                  : coinFormatter.format(best.outputAmount)}
                <span>
                  {direction === "toKrw" ? "원" : selectedTransferAsset}
                </span>
              </p>
              <p className="result-route">
                {direction === "toKrw" ? (
                  <>
                    <strong>{best.exchange}</strong>
                    <span>→</span>
                    <strong>{CHAIN_LABELS[best.chain]}</strong>
                    <span>→</span>
                    <strong>{best.domestic}</strong>
                  </>
                ) : (
                  <>
                    <strong>{best.domestic}</strong>
                    <span>→</span>
                    <strong>{CHAIN_LABELS[best.chain]}</strong>
                    <span>→</span>
                    <strong>{best.exchange}</strong>
                  </>
                )}
              </p>
              <div className="best-meta">
                <span>
                  {direction === "toKrw"
                    ? `1 ${holdingAsset}당`
                    : "100만원당"}{" "}
                  <strong>
                    {direction === "toKrw"
                      ? `${krwFormatter.format(best.outputAmount / numericAmount)}원`
                      : `${coinFormatter.format(
                          (best.outputAmount / numericAmount) * 1_000_000,
                        )} ${selectedTransferAsset}`}
                  </strong>
                </span>
                {runnerUp && (
                  <span>
                    다음 경로보다{" "}
                    <strong>
                      +
                      {direction === "toKrw"
                        ? `${krwFormatter.format(
                            best.outputAmount - runnerUp.outputAmount,
                          )}원`
                        : `${coinFormatter.format(
                            best.outputAmount - runnerUp.outputAmount,
                          )} ${selectedTransferAsset}`}
                    </strong>
                  </span>
                )}
                <span>
                  국내 평균 {direction === "toKrw" ? "매도가" : "매수가"}{" "}
                  <strong>
                    {krwFormatter.format(best.averageDomesticPrice)}원
                  </strong>
                </span>
                <span>
                  출금 수수료{" "}
                  <strong>
                    {best.totalWithdrawalFee}{" "}
                    {direction === "toKrw"
                      ? best.transferAsset
                      : best.startAsset}
                  </strong>
                </span>
              </div>
              <div className="before-transfer-note">
                <span>BEFORE TRANSFER</span>
                <p>
                  체인 이름이 같아도 입출금 지원 상태, 트래블룰, 최소 금액,
                  주소·메모를 거래소 화면에서 한 번 더 확인하세요.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveFeePanel("withdrawal")}
                >
                  출금 수수료 확인·수정 ↗
                </button>
              </div>
            </>
          ) : (
            <div className="empty-result">
              <strong>
                {numericAmount > 0
                  ? "공개 호가 범위에서 전량 체결이 어렵습니다."
                  : "수량을 입력해 주세요."}
              </strong>
              <span>
                {numericAmount > 0
                  ? `${direction === "toKrw" ? "수량" : "금액"}을 줄이거나 아래 경로별 호가 충족률을 확인하세요.`
                  : direction === "toKrw"
                    ? "0보다 큰 보유 수량이 필요합니다."
                    : "0보다 큰 원화 금액이 필요합니다."}
              </span>
            </div>
          )}
        </aside>
      </section>

      <section className="market-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MARKET SNAPSHOT</p>
            <h2>비교에 쓰인 가격</h2>
          </div>
        </div>

        <div className="quote-grid">
          <article className="quote-panel">
            <div className="panel-title">
              <span>해외 거래소</span>
              <div className="price-column-heading">
                <small>USDC → USDT</small>
                <small>USDT → USDC</small>
                <small>상태</small>
              </div>
            </div>
            {market.foreign.map((quote) => (
              <div className="quote-row" key={quote.exchange}>
                <div>
                  <span
                    className={`exchange-avatar ${quote.exchange.toLowerCase()}`}
                  >
                    {quote.exchange.slice(0, 1)}
                  </span>
                  <strong>{quote.exchange}</strong>
                </div>
                <div>
                  <span>
                    {quote.source === "unavailable"
                      ? "—"
                      : quote.bid.toFixed(4)}
                  </span>
                  <strong>
                    {quote.source === "unavailable"
                      ? "—"
                      : quote.ask.toFixed(4)}
                  </strong>
                  <i className={quote.source}>{quote.source}</i>
                </div>
              </div>
            ))}
          </article>

          <article className="quote-panel domestic-quotes">
            <div className="panel-title">
              <span>국내 거래소</span>
              <div className="price-column-heading">
                <small>USDT 매도 / 매수</small>
                <small>USDC 매도 / 매수</small>
                <small>상태</small>
              </div>
            </div>
            {DOMESTIC_EXCHANGES.map((exchange) => {
              const usdt = market.domestic.find(
                (quote) =>
                  quote.exchange === exchange && quote.asset === "USDT",
              );
              const usdc = market.domestic.find(
                (quote) =>
                  quote.exchange === exchange && quote.asset === "USDC",
              );
              return (
                <div className="quote-row" key={exchange}>
                  <div>
                    <span
                      className={`exchange-avatar ${exchange.toLowerCase()}`}
                    >
                      {exchange.slice(0, 1)}
                    </span>
                    <strong>{exchange}</strong>
                  </div>
                  <div>
                    <span>
                      {usdt?.source === "unavailable"
                        ? "—"
                        : `${krwFormatter.format(usdt?.bid ?? 0)} / ${krwFormatter.format(usdt?.ask ?? 0)}`}
                    </span>
                    <strong>
                      {usdc?.source === "unavailable"
                        ? "—"
                        : `${krwFormatter.format(usdc?.bid ?? 0)} / ${krwFormatter.format(usdc?.ask ?? 0)}`}
                    </strong>
                    <i
                      className={
                        usdt?.source === "live" && usdc?.source === "live"
                          ? "live"
                          : usdt?.source === "stale" ||
                              usdc?.source === "stale"
                            ? "stale"
                            : "unavailable"
                      }
                    >
                      {usdt?.source === "live" && usdc?.source === "live"
                        ? "live"
                        : usdt?.source === "stale" ||
                            usdc?.source === "stale"
                          ? "stale"
                          : "unavailable"}
                    </i>
                  </div>
                </div>
              );
            })}
          </article>
        </div>

        <div className="orderbook-section-heading">
          <div>
            <p className="eyebrow">ORDERBOOK DEPTH</p>
            <h3>호가창 현황</h3>
          </div>
          <div className="orderbook-toolbar">
            <div className="orderbook-view-tabs" role="group" aria-label="호가창 구분">
              <button
                type="button"
                className={orderbookView === "domestic" ? "active" : ""}
                onClick={() => setOrderbookView("domestic")}
                aria-pressed={orderbookView === "domestic"}
              >
                국내 거래소
              </button>
              <button
                type="button"
                className={orderbookView === "foreign" ? "active" : ""}
                onClick={() => setOrderbookView("foreign")}
                aria-pressed={orderbookView === "foreign"}
              >
                해외 스테이블 교환
              </button>
            </div>
            {orderbookView === "foreign" ? (
              <div
                className="foreign-exchange-tabs"
                role="group"
                aria-label="해외거래소 호가창 선택"
              >
                {EXCHANGES.map((exchange) => (
                  <button
                    type="button"
                    key={exchange}
                    className={
                      selectedForeignOrderbookExchange === exchange
                        ? "active"
                        : ""
                    }
                    onClick={() =>
                      setSelectedForeignOrderbookExchange(exchange)
                    }
                    aria-pressed={selectedForeignOrderbookExchange === exchange}
                  >
                    {exchange}
                  </button>
                ))}
              </div>
            ) : (
              <div
                className="domestic-exchange-tabs"
                role="group"
                aria-label="국내거래소 호가창 선택"
              >
                {DOMESTIC_EXCHANGES.map((exchange) => (
                <button
                  type="button"
                  key={exchange}
                  className={
                      selectedDomesticExchange === exchange ? "active" : ""
                  }
                    onClick={() => setSelectedDomesticExchange(exchange)}
                    aria-pressed={selectedDomesticExchange === exchange}
                >
                    {exchange === "Upbit" ? "업비트" : "빗썸"}
                </button>
              ))}
            </div>
            )}
            <button
              className="orderbook-refresh-button"
              type="button"
              onClick={() => refreshMarket(true)}
              disabled={refreshing}
            >
              <span aria-hidden="true" className={refreshing ? "spin" : ""}>
                ↻
              </span>
              {refreshing ? "확인 중" : "실시간 새로고침"}
            </button>
            <small>최근 확인 {displayTime(market.updatedAt)}</small>
          </div>
        </div>

        {orderbookView === "foreign" && (
        <div className="orderbook-grid foreign-orderbook-grid">
          {selectedForeignQuote &&
          selectedForeignQuote.source !== "unavailable" ? (
            (() => {
              const asks = selectedForeignQuote.asks.slice(0, 7).reverse();
              const bids = selectedForeignQuote.bids.slice(0, 10);
              const displayedLevels = [...asks, ...bids];
              const maxSize = Math.max(
                1,
                ...displayedLevels.map((level) => level.size),
              );
              const visibleAskLiquidity = selectedForeignQuote.asks.reduce(
                (total, level) => total + level.size,
                0,
              );
              const visibleBidLiquidity = selectedForeignQuote.bids.reduce(
                (total, level) => total + level.size,
                0,
              );

              return (
                <article className="orderbook-card foreign-orderbook-card">
                  <div className="orderbook-card-header">
                    <div>
                      <span
                        className={`exchange-avatar ${selectedForeignQuote.exchange.toLowerCase()}`}
                      >
                        {selectedForeignQuote.exchange.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{selectedForeignQuote.exchange}</strong>
                        <small>USDC/USDT</small>
                      </div>
                    </div>
                    <div>
                      <span>공개 잔량 · 매도 / 매수</span>
                      <strong>
                        {coinFormatter.format(visibleAskLiquidity)} /{" "}
                        {coinFormatter.format(visibleBidLiquidity)} USDC
                      </strong>
                    </div>
                  </div>
                  <div className="orderbook-column-labels">
                    <span>가격(USDT)</span>
                    <span>수량(USDC)</span>
                  </div>
                  <div className="orderbook-levels">
                    {asks.map((level, index) => (
                      <div
                        className="orderbook-level ask"
                        key={`foreign-ask-${level.price}-${index}`}
                      >
                        <span
                          className="depth-bar"
                          style={{ width: `${(level.size / maxSize) * 100}%` }}
                        />
                        <strong>{level.price.toFixed(6)}</strong>
                        <span>{coinFormatter.format(level.size)}</span>
                      </div>
                    ))}
                    <div className="orderbook-spread">
                      <span>스프레드</span>
                      <strong>
                        {Math.max(
                          0,
                          selectedForeignQuote.ask -
                            selectedForeignQuote.bid,
                        ).toFixed(6)}{" "}
                        USDT
                      </strong>
                    </div>
                    {bids.map((level, index) => (
                      <div
                        className="orderbook-level bid"
                        key={`foreign-bid-${level.price}-${index}`}
                      >
                        <span
                          className="depth-bar"
                          style={{ width: `${(level.size / maxSize) * 100}%` }}
                        />
                        <strong>{level.price.toFixed(6)}</strong>
                        <span>{coinFormatter.format(level.size)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })()
          ) : (
            <div className="orderbook-unavailable">
              <strong>
                {selectedForeignOrderbookExchange} 공개 호가를 불러오지
                못했습니다.
              </strong>
              <span>
                새로고침 후 다시 확인해 주세요. 환전 경로는 추천에서
                제외됩니다.
              </span>
            </div>
          )}
        </div>
        )}

        {orderbookView === "domestic" && (
        <div className="orderbook-grid">
          {market.domestic
            .filter(
              (quote) =>
                quote.source !== "unavailable" &&
                quote.exchange === selectedDomesticExchange,
            )
            .map((quote) => {
              const asks = quote.asks.slice(0, 5).reverse();
              const bids = quote.bids.slice(0, 8);
              const displayedLevels = [...asks, ...bids];
              const maxSize = Math.max(
                1,
                ...displayedLevels.map((level) => level.size),
              );
              const bidLiquidity = quote.bids.reduce(
                (total, level) => total + level.size,
                0,
              );

              return (
                <article
                  className="orderbook-card"
                  key={`${quote.exchange}-${quote.asset}`}
                >
                  <div className="orderbook-card-header">
                    <div>
                      <span
                        className={`exchange-avatar ${quote.exchange.toLowerCase()}`}
                      >
                        {quote.exchange.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{quote.exchange}</strong>
                        <small>{quote.asset}/KRW</small>
                      </div>
                    </div>
                    <div>
                      <span>공개 매수 잔량</span>
                      <strong>
                        {coinFormatter.format(bidLiquidity)} {quote.asset}
                      </strong>
                    </div>
                  </div>
                  <div className="orderbook-column-labels">
                    <span>가격(KRW)</span>
                    <span>수량({quote.asset})</span>
                  </div>
                  <div className="orderbook-levels">
                    {asks.map((level, index) => (
                      <div
                        className="orderbook-level ask"
                        key={`ask-${level.price}-${index}`}
                      >
                        <span
                          className="depth-bar"
                          style={{ width: `${(level.size / maxSize) * 100}%` }}
                        />
                        <strong>{krwFormatter.format(level.price)}</strong>
                        <span>{coinFormatter.format(level.size)}</span>
                      </div>
                    ))}
                    <div className="orderbook-spread">
                      <span>스프레드</span>
                      <strong>
                        {krwFormatter.format(Math.max(0, quote.ask - quote.bid))}
                        원
                      </strong>
                    </div>
                    {bids.map((level, index) => (
                      <div
                        className="orderbook-level bid"
                        key={`bid-${level.price}-${index}`}
                      >
                        <span
                          className="depth-bar"
                          style={{ width: `${(level.size / maxSize) * 100}%` }}
                        />
                        <strong>{krwFormatter.format(level.price)}</strong>
                        <span>{coinFormatter.format(level.size)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
        </div>
        )}
      </section>

      <section className="ranking-section">
        <div className="section-heading ranking-heading">
          <div>
            <p className="eyebrow">ALL ROUTES</p>
            <h2>전체 경로 순위</h2>
          </div>
          <p>
            해외 교환 호가, 체인 수수료, 국내 매매호가를 모두 반영합니다.
            두 호가창에서 전량 체결 가능한 경로가 먼저 표시됩니다.
          </p>
        </div>

        {routes.some((route) => !route.fullyFillable) && (
          <div className="liquidity-notice">
            <span>!</span>
            <p>
              해외 교환 또는 국내 매매 수량이 공개 호가 범위를 넘는 경로는
              ‘호가 부족’으로 표시되며 최적 경로 선정에서 제외됩니다.
            </p>
          </div>
        )}

        <div className="route-table-wrap">
          <table className="route-table">
            <thead>
              <tr>
                <th>순위</th>
                <th>경로</th>
                <th>전송 자산</th>
                <th>출금 수수료</th>
                <th>호가 체결</th>
                <th>예상 도착</th>
              </tr>
            </thead>
            <tbody>
              {visibleRoutes.map((route, index) => (
                <tr
                  key={route.id}
                  className={
                    route.id === best?.id
                      ? "winner"
                      : route.fullyFillable
                        ? ""
                        : "partial"
                  }
                >
                  <td>
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                  </td>
                  <td>
                    <strong>
                      {route.direction === "toKrw" ? (
                        <>
                          {route.exchange} <span>→</span>{" "}
                          {CHAIN_LABELS[route.chain]} <span>→</span>{" "}
                          {route.domestic}
                        </>
                      ) : (
                        <>
                          {route.domestic} <span>→</span>{" "}
                          {CHAIN_LABELS[route.chain]} <span>→</span>{" "}
                          {route.exchange}
                        </>
                      )}
                    </strong>
                    <small>
                      {route.direction === "toKrw"
                        ? route.converted
                          ? `${route.startAsset}를 ${route.transferAsset}로 환전 후 전송`
                          : `${route.startAsset} 그대로 전송`
                        : route.converted
                          ? `${route.startAsset} 매수·전송 후 ${route.transferAsset} 환전`
                          : `${route.startAsset} 매수 후 그대로 전송`}
                    </small>
                  </td>
                  <td>
                    <span
                      className={`asset-pill ${
                        route.direction === "toKrw"
                          ? route.transferAsset.toLowerCase()
                          : route.startAsset.toLowerCase()
                      }`}
                    >
                      {route.direction === "toKrw"
                        ? route.transferAsset
                        : route.startAsset}
                    </span>
                    <small>
                      {route.direction === "toKrw"
                        ? `${coinFormatter.format(route.netQuantity)} 국내 도착`
                        : `${coinFormatter.format(route.outputAmount)} ${route.transferAsset} 해외 도착`}
                    </small>
                  </td>
                  <td>
                    <strong>{route.totalWithdrawalFee}</strong>
                    <small>
                      {route.direction === "toKrw"
                        ? route.transferAsset
                        : route.startAsset}
                      {route.transferCount > 1
                        ? ` · ${route.withdrawalFee} × ${route.transferCount}회`
                        : " · 1회"}
                    </small>
                  </td>
                  <td>
                    <strong>
                      국내 평균 {route.direction === "toKrw" ? "매도" : "매수"}{" "}
                      {krwFormatter.format(route.averageDomesticPrice)}원
                    </strong>
                    <small>
                      {route.converted
                        ? `해외 ${route.foreignLevelsUsed}단계 (-${route.foreignSlippageBps.toFixed(1)}bp) · `
                        : ""}
                      국내 {route.domesticLevelsUsed}단계 (-
                      {route.domesticSlippageBps.toFixed(1)}bp)
                    </small>
                  </td>
                  <td>
                    <strong className="krw-result">
                      {route.fullyFillable
                        ? route.direction === "toKrw"
                          ? `${krwFormatter.format(route.outputAmount)}원`
                          : `${coinFormatter.format(route.outputAmount)} ${route.transferAsset}`
                        : route.direction === "toKrw"
                          ? `호가 내 ${krwFormatter.format(route.outputAmount)}원`
                          : `호가 내 ${coinFormatter.format(route.outputAmount)} ${route.transferAsset}`}
                    </strong>
                    <small
                      className={
                        route.fullyFillable ? route.source : "liquidity-short"
                      }
                    >
                      {route.fullyFillable
                        ? route.source === "live"
                          ? "실시간 호가 전량 체결"
                          : `${feeSourceLabel(route.feeSource)} · 실시간 호가 체결`
                        : !route.foreignFullyFillable
                          ? `해외 교환 호가 부족 · ${(route.foreignFillRatio * 100).toFixed(1)}% 체결`
                          : `국내 ${route.direction === "toKrw" ? "매수" : "매도"}호가 부족 · ${(route.fillRatio * 100).toFixed(1)}% 체결`}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {routes.length > 8 && (
            <button
              type="button"
              className="more-routes"
              onClick={() => setExpandedRows((current) => !current)}
            >
              {expandedRows ? "상위 8개만 보기" : `나머지 ${routes.length - 8}개 경로 보기`}
              <span>{expandedRows ? "↑" : "↓"}</span>
            </button>
          )}
        </div>
      </section>

      <section className="chain-section">
        <div>
          <p className="eyebrow">SUPPORTED DEPOSIT CHAINS</p>
          <h2>비교 대상 입금 체인</h2>
        </div>
        <div className="chain-group">
          <span className="asset-pill usdt">USDT</span>
          {CHAINS.USDT.map((chain) => (
            <strong key={chain}>{CHAIN_LABELS[chain]}</strong>
          ))}
        </div>
        <div className="chain-group">
          <span className="asset-pill usdc">USDC</span>
          {CHAINS.USDC.map((chain) => (
            <strong key={chain}>{CHAIN_LABELS[chain]}</strong>
          ))}
        </div>
      </section>

      <section className="method-section">
        <div className="method-heading">
          <p className="eyebrow">CALCULATION METHOD</p>
          <h2>이 순서로 예상 도착값을 계산합니다.</h2>
        </div>
        <ol className="method-grid">
          <li>
            <span>01</span>
            <strong>방향·자산 선택</strong>
            <p>
              해외→국내 또는 국내→해외 방향과 전송 전후의 스테이블 코인을
              선택합니다.
            </p>
          </li>
          <li>
            <span>02</span>
            <strong>체인 수수료 차감</strong>
            <p>
              선택한 거래소·자산·체인의 출금 수수료에 전송 횟수를 곱해 코인
              수량에서 뺍니다.
            </p>
          </li>
          <li>
            <span>03</span>
            <strong>매매호가 순차 체결</strong>
            <p>
              계산 방향에 따라 국내 매수 또는 매도호가 잔량을 순차 소진해
              평균 체결가를 구합니다.
            </p>
          </li>
          <li>
            <span>04</span>
            <strong>실수령 결과 비교</strong>
            <p>거래 수수료를 차감하고 전량 체결 가능한 경로끼리 비교합니다.</p>
          </li>
        </ol>
        <div className="formula-line">
          <span>예상 도착</span>
          <strong>
            {direction === "toKrw"
              ? "[해외 호가별 교환 − 출금 수수료] × 국내 매수호가 체결 × (1 − 국내 거래 수수료)"
              : "[원화 × (1 − 국내 거래 수수료)] ÷ 국내 매도호가 체결 − 출금 수수료 → 해외 호가별 교환"}
          </strong>
        </div>
      </section>

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark">S</span>
          <span>STABLEPATH</span>
        </div>
        <p>
          본 서비스의 결과는 예상치이며 투자 권유가 아닙니다. 실제 전송 전
          거래소의 입출금 상태, 수수료, 최소 금액, 트래블룰 조건을 반드시
          확인하세요.
        </p>
        <span>© 2026 STABLEPATH</span>
      </footer>

      {activeFeePanel === "withdrawal" && (
        <div
          className="fee-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setActiveFeePanel(null);
          }}
        >
          <section
            className="fee-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fee-title"
          >
            <div className="fee-panel-header">
              <div>
                <p className="eyebrow">WITHDRAWAL FEES</p>
                <h2 id="fee-title">출금 수수료 편집</h2>
                <p>
                  거래소 출금 화면에 표시된 현재 수수료를 반영하세요.
                  변경값은 이 기기에 저장됩니다.
                </p>
              </div>
              <div className="fee-panel-header-actions">
                <span className="fee-unit-label">단위 : USDT 또는 USDC</span>
                <button
                  className="close-button"
                  type="button"
                  onClick={() => setActiveFeePanel(null)}
                  aria-label="닫기"
                >
                ×
              </button>
              </div>
            </div>

            <div className="fee-table-wrap">
              {FEE_EXCHANGES.map((exchange) => (
                <div className="fee-exchange" key={exchange}>
                  <div className="fee-exchange-title">
                    <span className={`exchange-avatar ${exchange.toLowerCase()}`}>
                      {exchange.slice(0, 1)}
                    </span>
                    <strong>{exchange}</strong>
                  </div>
                  {ASSETS.map((feeAsset) => (
                    <div className="fee-asset-row" key={feeAsset}>
                      <div className="fee-asset-label">
                        <span className={`asset-pill ${feeAsset.toLowerCase()}`}>
                          {feeAsset}
                        </span>
                      </div>
                      <div>
                        {CHAINS[feeAsset].map((chain) => {
                          const feeValue = fees[exchange][feeAsset][chain];
                          return (
                            <label key={chain}>
                              <span>{CHAIN_LABELS[chain]}</span>
                              {feeValue === undefined ? (
                                <b className="unsupported-chain">
                                  지원되지 않음
                                </b>
                              ) : (
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={feeValue}
                                  onChange={(event) =>
                                    updateFee(
                                      exchange,
                                      feeAsset,
                                      chain,
                                      event.target.value,
                                    )
                                  }
                                />
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="fee-panel-footer">
              <div className="fee-panel-notes">
                <p className="fee-caution">
                  출금 수수료는 변경될 수 있습니다. 실제 값과 차이가 있을 수
                  있으므로, 거래 전 본인이 반드시 확인해야 합니다.
                </p>
              </div>
              <div>
                <button type="button" className="text-button" onClick={resetFees}>
                  기본값 복원
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setActiveFeePanel(null)}
                >
                  계산에 적용
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {activeFeePanel === "trading" && (
        <div
          className="fee-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setActiveFeePanel(null);
          }}
        >
          <section
            className="fee-panel trading-fee-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trading-fee-title"
          >
            <div className="fee-panel-header">
              <div>
                <p className="eyebrow">TRADING FEES</p>
                <h2 id="trading-fee-title">거래 수수료 편집</h2>
                <p>
                  거래소별 수수료율을 퍼센트(%)로 입력하세요. 해외 수수료는
                  USDT↔USDC 환전이 발생하는 경로에만 적용되고, 국내 수수료는
                  원화 매매 체결금액에 적용됩니다. 무료 이벤트 적용 시 0을
                  입력할 수 있습니다.
                </p>
              </div>
              <button
                className="close-button"
                type="button"
                onClick={() => setActiveFeePanel(null)}
                aria-label="닫기"
              >
                ×
              </button>
            </div>

            <div className="trading-fee-grid">
              <section className="trading-fee-group">
                <div className="trading-fee-group-heading">
                  <div>
                    <p className="eyebrow">OVERSEAS SPOT</p>
                    <h3>해외 스테이블 코인 환전</h3>
                  </div>
                  <span>USDT ↔ USDC 환전 시에만 적용</span>
                </div>
                <div className="trading-fee-list">
                  {EXCHANGES.map((exchange) => (
                    <label key={exchange}>
                      <span>
                        <i
                          className={`exchange-avatar ${exchange.toLowerCase()}`}
                        >
                          {exchange.slice(0, 1)}
                        </i>
                        <strong>{exchange}</strong>
                      </span>
                      <span className="percentage-input">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={Number(
                            (tradingFees.foreign[exchange] * 100).toFixed(4),
                          )}
                          onChange={(event) =>
                            updateTradingFee(
                              "foreign",
                              exchange,
                              event.target.value,
                            )
                          }
                        />
                        <b>%</b>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="trading-fee-group">
                <div className="trading-fee-group-heading">
                  <div>
                    <p className="eyebrow">DOMESTIC SPOT</p>
                    <h3>국내 원화 매매</h3>
                  </div>
                  <span>기본값: 업비트 0.05% · 빗썸 0.04%</span>
                </div>
                <div className="trading-fee-list domestic-fee-list">
                  {DOMESTIC_EXCHANGES.map((exchange) => (
                    <label key={exchange}>
                      <span>
                        <i
                          className={`exchange-avatar ${exchange.toLowerCase()}`}
                        >
                          {exchange.slice(0, 1)}
                        </i>
                        <strong>
                          {exchange === "Upbit" ? "업비트" : "빗썸"}
                        </strong>
                      </span>
                      <span className="percentage-input">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={Number(
                            (tradingFees.domestic[exchange] * 100).toFixed(4),
                          )}
                          onChange={(event) =>
                            updateTradingFee(
                              "domestic",
                              exchange,
                              event.target.value,
                            )
                          }
                        />
                        <b>%</b>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            </div>

            <div className="fee-panel-footer">
              <div className="fee-panel-notes">
                <p>
                  해외 0.10%는 일반 사용자·시장가 체결을 가정한 기본 테이커
                  수수료입니다. VIP 등급, 수수료 할인, 지역 및 프로모션에
                  따라 실제 적용률이 달라질 수 있습니다.
                </p>
                <p className="fee-caution">
                  실제 값과 차이가 있을 수 있으므로, 거래 전 본인이 반드시
                  확인해야 합니다.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  className="text-button"
                  onClick={resetTradingFees}
                >
                  기본값 복원
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setActiveFeePanel(null)}
                >
                  계산에 적용
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

