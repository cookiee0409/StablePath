"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Asset = "USDT" | "USDC";
type Exchange = "Binance" | "Bitget" | "Bybit" | "OKX";
type DomesticExchange = "Upbit" | "Bithumb";
type Chain = "Tron" | "Ethereum" | "Kaia" | "Aptos" | "Solana";
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
  Exchange,
  Record<Asset, Partial<Record<Chain, number>>>
>;
type FeeSourceMatrix = Record<Exchange, Record<Asset, FeeSource>>;
type TradingFeeSettings = {
  foreign: Record<Exchange, number>;
  domestic: Record<DomesticExchange, number>;
};

type RouteResult = {
  id: string;
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
  source: RouteSource;
  feeSource: FeeSource;
  converted: boolean;
};

const EXCHANGES: Exchange[] = ["Binance", "Bitget", "Bybit", "OKX"];
const DOMESTIC_EXCHANGES: DomesticExchange[] = ["Upbit", "Bithumb"];
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
    USDT: { Tron: 1, Ethereum: 4, Kaia: 0.1, Aptos: 0.2 },
    USDC: { Ethereum: 4, Solana: 1 },
  },
  OKX: {
    USDT: { Tron: 1, Ethereum: 4, Kaia: 0.1, Aptos: 0.2 },
    USDC: { Ethereum: 4, Solana: 1 },
  },
};

const FALLBACK_MARKET: MarketPayload = {
  foreign: EXCHANGES.map((exchange) => ({
    exchange,
    bid: 0.9997,
    ask: 1.0003,
    last: 1,
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
    EXCHANGES.map((exchange) => [
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
  if (source === "live") return "실시간 수수료";
  if (source === "stale") return "최근 수수료";
  return "직접 입력 수수료";
}

function browserNumeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseBrowserForeignQuote(
  bidValue: unknown,
  askValue: unknown,
  lastValue?: unknown,
) {
  const bid = browserNumeric(bidValue);
  const ask = browserNumeric(askValue);
  const last = browserNumeric(lastValue) || (bid + ask) / 2;
  if (!bid || !ask || !last) throw new Error("No usable quote");
  return { bid, ask, last };
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
    parse: (raw: unknown) => { bid: number; ask: number; last: number };
  }
> = {
  Binance: {
    url: "https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDCUSDT",
    parse: (raw) => {
      const data = raw as Record<string, unknown>;
      return parseBrowserForeignQuote(data.bidPrice, data.askPrice);
    },
  },
  Bitget: {
    url: "https://api.bitget.com/api/v3/market/tickers?category=SPOT&symbol=USDCUSDT",
    parse: (raw) => {
      const response = raw as { data?: Array<Record<string, unknown>> };
      const data = response.data?.[0] ?? {};
      return parseBrowserForeignQuote(
        data.bid1Price,
        data.ask1Price,
        data.lastPrice,
      );
    },
  },
  Bybit: {
    url: "https://api.bybit.com/v5/market/tickers?category=spot&symbol=USDCUSDT",
    parse: (raw) => {
      const response = raw as {
        result?: { list?: Array<Record<string, unknown>> };
      };
      const data = response.result?.list?.[0] ?? {};
      return parseBrowserForeignQuote(
        data.bid1Price,
        data.ask1Price,
        data.lastPrice,
      );
    },
  },
  OKX: {
    url: "https://www.okx.com/api/v5/market/ticker?instId=USDC-USDT",
    parse: (raw) => {
      const response = raw as { data?: Array<Record<string, unknown>> };
      const data = response.data?.[0] ?? {};
      return parseBrowserForeignQuote(data.bidPx, data.askPx, data.last);
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

export default function Home() {
  const [asset, setAsset] = useState<Asset>("USDT");
  const [amount, setAmount] = useState("10000");
  const [transferCount, setTransferCount] = useState(1);
  const [selectedExchange, setSelectedExchange] = useState<Exchange | "all">(
    "all",
  );
  const [selectedDomesticExchange, setSelectedDomesticExchange] =
    useState<DomesticExchange>("Upbit");
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
    try {
      const stored = localStorage.getItem("stablepath-trading-fees");
      if (stored) {
        const saved = JSON.parse(stored) as Partial<TradingFeeSettings>;
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
      }
    } catch {
      // Invalid local preferences fall back to the maintained defaults.
    }
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

    for (const exchange of activeExchanges) {
      const foreign = market.foreign.find(
        (quote) => quote.exchange === exchange,
      );

      for (const transferAsset of ASSETS) {
        const converted = transferAsset !== asset;
        let quantityAfterSwap = parsedAmount;

        if (converted && foreign?.source !== "live") continue;
        if (asset === "USDT" && transferAsset === "USDC") {
          quantityAfterSwap =
            (parsedAmount / foreign!.ask) *
            (1 - tradingFees.foreign[exchange]);
        } else if (asset === "USDC" && transferAsset === "USDT") {
          quantityAfterSwap =
            parsedAmount *
            foreign!.bid *
            (1 - tradingFees.foreign[exchange]);
        }

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
            const krw =
              execution.grossKrw * (1 - tradingFees.domestic[domestic]);
            const feeSource = feeSources[exchange][transferAsset];
            const source: RouteSource =
              feeSource === "live" ? "live" : "estimate";

            candidates.push({
              id: [
                exchange,
                asset,
                transferAsset,
                chain,
                domestic,
              ].join("-"),
              exchange,
              startAsset: asset,
              transferAsset,
              domestic,
              chain,
              withdrawalFee,
              totalWithdrawalFee,
              transferCount,
              quantityAfterSwap,
              netQuantity,
              ...execution,
              krw,
              source,
              feeSource,
              converted,
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
      return b.krw - a.krw;
    });
  }, [
    amount,
    asset,
    feeSources,
    fees,
    market,
    selectedExchange,
    tradingFees,
    transferCount,
  ]);

  const fullyFillableRoutes = routes.filter((route) => route.fullyFillable);
  const best = fullyFillableRoutes[0];
  const runnerUp = fullyFillableRoutes[1];
  const numericAmount = Number(amount.replaceAll(",", "")) || 0;
  const visibleRoutes = expandedRows ? routes : routes.slice(0, 8);

  const updateFee = (
    exchange: Exchange,
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
          <p className="eyebrow">OVERSEAS → KRW ROUTE FINDER</p>
          <h1>
            원화 효율
            <br />
            <span>계산기.</span>
          </h1>
          <p className="hero-description">
            해외거래소의 스테이블 코인을 어떤 자산과 체인으로 보내야 가장
            효율이 좋은지 계산
            <br />
            체인별 출금 수수료와 국내 매수호가 잔량을 반영
          </p>
        </div>

        <div className="calculator-card" aria-label="경로 계산 조건">
          <div className="card-topline">
            <span>보유 자산</span>
            <span className="market-time">
              시세 기준 {displayTime(market.updatedAt)}
            </span>
          </div>

          <div className="asset-switch" role="group" aria-label="보유 자산 선택">
            {ASSETS.map((item) => (
              <button
                type="button"
                key={item}
                className={asset === item ? "active" : ""}
                onClick={() => setAsset(item)}
                aria-pressed={asset === item}
              >
                <span className={`coin-dot ${item.toLowerCase()}`}>$</span>
                {item}
              </button>
            ))}
          </div>

          <label className="amount-label" htmlFor="amount">
            <span>수량</span>
            <span>{asset}</span>
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
            전송 전 해외거래소에 보유한 수량을 입력하세요.
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
              테스트 전송 후 나머지를 보내거나 여러 번 나눠 보낼 때의 총
              출금 수수료를 계산합니다.
            </p>
          </div>

          <div className="exchange-label">
            <span>보유 거래소</span>
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
                onClick={() => setSelectedExchange(exchange)}
              >
                {exchange}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="best-section" aria-live="polite">
        <div className="best-card">
          <div className="best-heading">
            <div>
              <p className="eyebrow lime">BEST ROUTE</p>
              <h2>예상 원화 도착액</h2>
            </div>
            {best && (
              <span className={`quote-badge ${best.source}`}>
                {best.source === "live"
                  ? "LIVE"
                  : best.feeSource === "stale"
                    ? "STALE FEE"
                    : "MANUAL FEE"}
              </span>
            )}
          </div>

          {best ? (
            <>
              <p className="arrival-value">
                {krwFormatter.format(best.krw)}
                <span>원</span>
              </p>
              <div className="best-meta">
                <span>
                  1 {asset}당{" "}
                  <strong>
                    {krwFormatter.format(best.krw / numericAmount)}원
                  </strong>
                </span>
                {runnerUp && (
                  <span>
                    다음 경로보다{" "}
                    <strong>
                      +{krwFormatter.format(best.krw - runnerUp.krw)}원
                    </strong>
                  </span>
                )}
                <span>
                  평균 매도가{" "}
                  <strong>
                    {krwFormatter.format(best.averageSellPrice)}원
                  </strong>
                </span>
                <span>
                  호가 슬리피지{" "}
                  <strong>-{best.slippageBps.toFixed(1)}bp</strong>
                </span>
              </div>

              <div className="route-flow">
                <div className="route-node">
                  <span className="node-icon">{best.exchange.slice(0, 1)}</span>
                  <span className="node-kicker">출발</span>
                  <strong>{best.exchange}</strong>
                  <small>
                    {coinFormatter.format(numericAmount)} {best.startAsset}
                  </small>
                </div>
                {best.converted && (
                  <>
                    <span className="route-arrow">→</span>
                    <div className="route-node">
                      <span className="node-icon swap">↔</span>
                      <span className="node-kicker">환전</span>
                      <strong>
                        {best.startAsset} → {best.transferAsset}
                      </strong>
                      <small>현물 수수료 반영</small>
                    </div>
                  </>
                )}
                <span className="route-arrow">→</span>
                <div className="route-node">
                  <span className="node-icon chain">⌁</span>
                  <span className="node-kicker">전송</span>
                  <strong>{CHAIN_LABELS[best.chain]}</strong>
                  <small>
                    -{best.totalWithdrawalFee} {best.transferAsset}
                    {best.transferCount > 1 &&
                      ` (${best.withdrawalFee} × ${best.transferCount}회)`}
                  </small>
                </div>
                <span className="route-arrow">→</span>
                <div className="route-node">
                  <span className="node-icon domestic">
                    {best.domestic.slice(0, 1)}
                  </span>
                  <span className="node-kicker">판매</span>
                  <strong>{best.domestic}</strong>
                  <small>
                    {best.levelsUsed}개 매수호가 · 평균{" "}
                    {krwFormatter.format(best.averageSellPrice)}원
                  </small>
                </div>
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
                  ? "수량을 줄이거나 아래 경로별 호가 충족률을 확인하세요."
                  : "0보다 큰 보유 수량이 필요합니다."}
              </span>
            </div>
          )}
        </div>

        <aside className="check-card">
          <div className="check-number">01</div>
          <p className="eyebrow">BEFORE TRANSFER</p>
          <h3>체인 이름이 같아도, 입금 화면에서 한 번 더 확인하세요.</h3>
          <ul>
            <li>국내거래소 입금 일시중단 여부</li>
            <li>본인 명의·트래블룰 조건</li>
            <li>최소 입금액과 주소·메모</li>
          </ul>
          <button
            type="button"
            onClick={() => setActiveFeePanel("withdrawal")}
          >
            현재 출금 수수료 확인·수정 <span>↗</span>
          </button>
        </aside>
      </section>

      <section className="market-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MARKET SNAPSHOT</p>
            <h2>지금 비교에 쓰인 가격</h2>
          </div>
          <p>
            전송 후 수량을 최우선 매수호가부터 순서대로 체결해 평균 매도가와
            슬리피지를 계산합니다.
          </p>
        </div>

        <div className="quote-grid">
          <article className="quote-panel">
            <div className="panel-title">
              <span>해외 · USDC/USDT</span>
              <small>매수 / 매도</small>
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
              <span>국내 · KRW 매수호가</span>
              <small>USDT / USDC</small>
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
                        : `${krwFormatter.format(usdt?.bid ?? 0)}원`}
                    </span>
                    <strong>
                      {usdc?.source === "unavailable"
                        ? "—"
                        : `${krwFormatter.format(usdc?.bid ?? 0)}원`}
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
            <p className="eyebrow">DOMESTIC ORDERBOOK DEPTH</p>
            <h3>국내 호가창 현황</h3>
          </div>
          <div className="orderbook-toolbar">
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
      </section>

      <section className="ranking-section">
        <div className="section-heading ranking-heading">
          <div>
            <p className="eyebrow">ALL ROUTES</p>
            <h2>전체 경로 순위</h2>
          </div>
          <p>
            체인 수수료 차감 후 국내 매수호가를 순차 소진합니다. 전량 체결
            가능한 경로가 먼저 표시됩니다.
          </p>
        </div>

        {routes.some((route) => !route.fullyFillable) && (
          <div className="liquidity-notice">
            <span>!</span>
            <p>
              공개 호가 범위보다 매도 수량이 큰 경로는 ‘호가 부족’으로
              표시되며 최적 경로 선정에서 제외됩니다.
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
                <th>예상 도착액</th>
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
                      {route.exchange} <span>→</span>{" "}
                      {CHAIN_LABELS[route.chain]} <span>→</span>{" "}
                      {route.domestic}
                    </strong>
                    <small>
                      {route.converted
                        ? `${route.startAsset}를 ${route.transferAsset}로 환전 후 전송`
                        : `${route.startAsset} 그대로 전송`}
                    </small>
                  </td>
                  <td>
                    <span className={`asset-pill ${route.transferAsset.toLowerCase()}`}>
                      {route.transferAsset}
                    </span>
                    <small>{coinFormatter.format(route.netQuantity)} 도착</small>
                  </td>
                  <td>
                    <strong>{route.totalWithdrawalFee}</strong>
                    <small>
                      {route.transferAsset}
                      {route.transferCount > 1
                        ? ` · ${route.withdrawalFee} × ${route.transferCount}회`
                        : " · 1회"}
                    </small>
                  </td>
                  <td>
                    <strong>
                      평균 {krwFormatter.format(route.averageSellPrice)}원
                    </strong>
                    <small>
                      {route.levelsUsed}개 호가 · -{route.slippageBps.toFixed(1)}bp
                    </small>
                  </td>
                  <td>
                    <strong className="krw-result">
                      {route.fullyFillable
                        ? `${krwFormatter.format(route.krw)}원`
                        : `호가 내 ${krwFormatter.format(route.krw)}원`}
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
                        : `호가 부족 · ${(route.fillRatio * 100).toFixed(1)}% 체결`}
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
          <h2>이 순서로 원화 도착액을 계산합니다.</h2>
        </div>
        <ol className="method-grid">
          <li>
            <span>01</span>
            <strong>전송 자산 결정</strong>
            <p>보유 자산 그대로 전송하거나 해외 호가로 USDT↔USDC를 환전합니다.</p>
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
            <strong>매수호가 순차 체결</strong>
            <p>국내 최우선 매수호가부터 잔량만큼 소진해 평균 매도가를 구합니다.</p>
          </li>
          <li>
            <span>04</span>
            <strong>실수령 원화 비교</strong>
            <p>국내 매도 수수료를 차감하고 전량 체결 가능한 경로끼리 비교합니다.</p>
          </li>
        </ol>
        <div className="formula-line">
          <span>예상 원화</span>
          <strong>
            [환전 후 수량 − (회당 출금 수수료 × 전송 횟수)]을 호가별 체결 ×
            (1 − 국내 매도 수수료)
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
                  거래소 출금 화면에 표시된 현재 수수료를 자산 단위로
                  입력하세요. 미지원·일시중단 체인은 값을 비워 두면 경로에서
                  제외되며, 변경값은 이 기기에 저장됩니다.
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

            <div className="fee-table-wrap">
              {EXCHANGES.map((exchange) => (
                <div className="fee-exchange" key={exchange}>
                  <div className="fee-exchange-title">
                    <span className={`exchange-avatar ${exchange.toLowerCase()}`}>
                      {exchange.slice(0, 1)}
                    </span>
                    <strong>{exchange}</strong>
                    {exchange === "Bitget" && (
                      <small>공개 API 값 우선 반영</small>
                    )}
                  </div>
                  {ASSETS.map((feeAsset) => (
                    <div className="fee-asset-row" key={feeAsset}>
                      <div className="fee-asset-label">
                        <span className={`asset-pill ${feeAsset.toLowerCase()}`}>
                          {feeAsset}
                        </span>
                        <small className={feeSources[exchange][feeAsset]}>
                          {feeSourceLabel(feeSources[exchange][feeAsset])}
                        </small>
                      </div>
                      <div>
                        {CHAINS[feeAsset].map((chain) => (
                          <label key={chain}>
                            <span>{CHAIN_LABELS[chain]}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={fees[exchange][feeAsset][chain] ?? ""}
                              onChange={(event) =>
                                updateFee(
                                  exchange,
                                  feeAsset,
                                  chain,
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="withdrawal-fee-unit">
              <strong>출금 수수료 단위</strong>
              <p>
                각 입력값은 출금하는 스테이블코인 수량입니다. USDT 항목의 1은
                1 USDT, USDC 항목의 1은 1 USDC이며, 원화 또는 TRX·ETH·SOL
                같은 네트워크 가스 토큰 단위가 아닙니다.
              </p>
            </div>

            <div className="fee-panel-footer">
              <div className="fee-panel-notes">
                <p>
                  입력한 회당 출금 수수료에 선택한 전송 횟수를 곱해
                  계산합니다.
                </p>
                <p className="fee-caution">
                  실제 값과 차이가 있을 수 있으므로, 거래 전 본인이 반드시
                  확인해야 합니다.
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
                  원화 매도 체결금액에 적용됩니다. 무료 이벤트 적용 시 0을
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
                    <p className="eyebrow">DOMESTIC SELL</p>
                    <h3>국내 원화 매도</h3>
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
                  기존의 환전 수수료 0.10%는 해외거래소에서 스테이블 코인을
                  서로 바꿀 때 적용한 현물 거래 수수료입니다.
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

