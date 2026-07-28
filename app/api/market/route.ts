const FOREIGN_FALLBACK = {
  Binance: { bid: 0.9997, ask: 1.0003, last: 1 },
  Bitget: { bid: 0.9996, ask: 1.0004, last: 1 },
  Bybit: { bid: 0.9997, ask: 1.0003, last: 1 },
  OKX: { bid: 0.9997, ask: 1.0004, last: 1 },
} as const;

const DOMESTIC_FALLBACK = {
  Upbit: {
    USDT: { bid: 1_385, ask: 1_386 },
    USDC: { bid: 1_384, ask: 1_386 },
  },
  Bithumb: {
    USDT: { bid: 1_384, ask: 1_386 },
    USDC: { bid: 1_383, ask: 1_385 },
  },
} as const;

type MarketSource = "live" | "stale" | "unavailable";
type Asset = "USDT" | "USDC";
type Chain = "Tron" | "Ethereum" | "Kaia" | "Aptos" | "Solana";
type OrderLevel = {
  price: number;
  size: number;
};
type ForeignQuote = {
  exchange: keyof typeof FOREIGN_FALLBACK;
  bid: number;
  ask: number;
  last: number;
  source: MarketSource;
  checkedAt: string;
  endpoint?: string;
  latencyMs?: number;
  reason?: string;
  statusCode?: number;
};
type DomesticQuote = {
  exchange: keyof typeof DOMESTIC_FALLBACK;
  asset: Asset;
  bid: number;
  ask: number;
  bids: OrderLevel[];
  asks: OrderLevel[];
  source: MarketSource;
  checkedAt: string;
  endpoint?: string;
  latencyMs?: number;
  reason?: string;
  statusCode?: number;
};

let cachedPayload: unknown;
let cachedAt = 0;
const STALE_QUOTE_MS = 60_000;
const STALE_FEE_MS = 5 * 60_000;
const lastForeign = new Map<
  keyof typeof FOREIGN_FALLBACK,
  { value: ForeignQuote; at: number }
>();
const lastDomestic = new Map<
  string,
  { value: DomesticQuote; at: number }
>();

type FeeAssetResult = {
  fees: Partial<Record<Chain, number>>;
  supportedChains: Chain[];
  source: MarketSource;
  checkedAt: string;
  endpoint?: string;
  latencyMs?: number;
  reason?: string;
  statusCode?: number;
};

const lastBitgetFees = new Map<Asset, { value: FeeAssetResult; at: number }>();

class UpstreamError extends Error {
  code: string;
  statusCode?: number;
  endpoint: string;

  constructor(
    code: string,
    endpoint: string,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.endpoint = endpoint;
    this.statusCode = statusCode;
  }
}

type EndpointSpec<T> = {
  url: string;
  parse: (data: unknown) => T;
};

type UpstreamResult<T> = {
  value: T;
  endpoint: string;
  latencyMs: number;
};

function createLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function failureDetails(error: unknown) {
  if (error instanceof UpstreamError) {
    return {
      reason: error.code,
      statusCode: error.statusCode,
      endpoint: new URL(error.endpoint).host,
    };
  }
  return { reason: "UNKNOWN" };
}

function shouldRetry(error: UpstreamError) {
  return (
    error.code === "TIMEOUT" ||
    error.code === "NETWORK" ||
    error.statusCode === 429 ||
    (error.statusCode !== undefined && error.statusCode >= 500)
  );
}

function createUpstreamClient() {
  // A Worker can wait on at most six outbound response headers at once.
  // Four leaves room for framework/runtime subrequests and starts timeouts only
  // after a request obtains a real execution slot.
  const runLimited = createLimiter(4);

  async function fetchJson(url: string) {
    return runLimited(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          headers: {
            accept: "application/json",
            "user-agent": "StablePath/1.0",
          },
          signal: controller.signal,
          cf: { cacheTtl: 8, cacheEverything: true },
        } as RequestInit);
        const text = await response.text();
        if (!response.ok) {
          throw new UpstreamError(
            `HTTP_${response.status}`,
            url,
            `Upstream returned HTTP ${response.status}`,
            response.status,
          );
        }
        try {
          return {
            data: JSON.parse(text) as unknown,
            latencyMs: Date.now() - startedAt,
          };
        } catch {
          throw new UpstreamError(
            "INVALID_JSON",
            url,
            "Upstream returned invalid JSON",
          );
        }
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        if (controller.signal.aborted) {
          throw new UpstreamError(
            "TIMEOUT",
            url,
            "Upstream request exceeded 8 seconds",
          );
        }
        throw new UpstreamError(
          "NETWORK",
          url,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  return async function loadUpstream<T>(
    provider: string,
    endpoints: EndpointSpec<T>[],
  ): Promise<UpstreamResult<T>> {
    let lastError: UpstreamError | undefined;

    for (const endpoint of endpoints) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await fetchJson(endpoint.url);
          let value: T;
          try {
            value = endpoint.parse(response.data);
          } catch (error) {
            throw new UpstreamError(
              "INVALID_RESPONSE",
              endpoint.url,
              error instanceof Error ? error.message : String(error),
            );
          }
          return {
            value,
            endpoint: new URL(endpoint.url).host,
            latencyMs: response.latencyMs,
          };
        } catch (error) {
          const upstreamError =
            error instanceof UpstreamError
              ? error
              : new UpstreamError(
                  "UNKNOWN",
                  endpoint.url,
                  error instanceof Error ? error.message : String(error),
                );
          lastError = upstreamError;
          console.error(
            JSON.stringify({
              message: "market upstream request failed",
              provider,
              endpoint: new URL(endpoint.url).host,
              code: upstreamError.code,
              statusCode: upstreamError.statusCode,
              attempt,
            }),
          );
          if (attempt === 2 || !shouldRetry(upstreamError)) break;
        }
      }
    }

    throw (
      lastError ??
      new UpstreamError("UNAVAILABLE", endpoints[0]?.url ?? "", provider)
    );
  };
}

function numeric(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildFallbackBook(
  bid: number,
  ask: number,
  asset: Asset,
) {
  const multiplier = asset === "USDT" ? 1 : 0.86;
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

function parseForeignQuote(
  bidValue: unknown,
  askValue: unknown,
  lastValue: unknown,
) {
  const bid = numeric(bidValue, 0);
  const ask = numeric(askValue, 0);
  const last = numeric(lastValue, (bid + ask) / 2);
  if (!bid || !ask || !last) throw new Error("No usable quote");
  return { bid, ask, last };
}

async function loadForeignQuote(
  exchange: keyof typeof FOREIGN_FALLBACK,
  loadUpstream: ReturnType<typeof createUpstreamClient>,
): Promise<ForeignQuote> {
  const specs: Record<
    keyof typeof FOREIGN_FALLBACK,
    EndpointSpec<{ bid: number; ask: number; last: number }>[]
  > = {
    Binance: [
      {
        url: "https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDCUSDT",
        parse: (raw) => {
          const data = raw as Record<string, unknown>;
          return parseForeignQuote(data.bidPrice, data.askPrice, undefined);
        },
      },
      {
        url: "https://api.binance.com/api/v3/ticker/bookTicker?symbol=USDCUSDT",
        parse: (raw) => {
          const data = raw as Record<string, unknown>;
          return parseForeignQuote(data.bidPrice, data.askPrice, undefined);
        },
      },
    ],
    Bitget: [
      {
        url: "https://api.bitget.com/api/v3/market/tickers?category=SPOT&symbol=USDCUSDT",
        parse: (raw) => {
          const response = raw as {
            data?: Array<Record<string, unknown>>;
          };
          const data = response.data?.[0] ?? {};
          return parseForeignQuote(
            data.bid1Price,
            data.ask1Price,
            data.lastPrice,
          );
        },
      },
      {
        url: "https://api.bitget.com/api/v2/spot/market/tickers?symbol=USDCUSDT",
        parse: (raw) => {
          const response = raw as {
            data?: Array<Record<string, unknown>>;
          };
          const data = response.data?.[0] ?? {};
          return parseForeignQuote(data.bidPr, data.askPr, data.lastPr);
        },
      },
    ],
    Bybit: [
      "https://api.bybit.com/v5/market/tickers?category=spot&symbol=USDCUSDT",
      "https://api.bytick.com/v5/market/tickers?category=spot&symbol=USDCUSDT",
    ].map((url) => ({
      url,
      parse: (raw: unknown) => {
        const response = raw as {
          result?: { list?: Array<Record<string, unknown>> };
        };
        const data = response.result?.list?.[0] ?? {};
        return parseForeignQuote(
          data.bid1Price,
          data.ask1Price,
          data.lastPrice,
        );
      },
    })),
    OKX: [
      {
        url: "https://www.okx.com/api/v5/market/ticker?instId=USDC-USDT",
        parse: (raw) => {
          const response = raw as {
            data?: Array<Record<string, unknown>>;
          };
          const data = response.data?.[0] ?? {};
          return parseForeignQuote(data.bidPx, data.askPx, data.last);
        },
      },
    ],
  };

  const checkedAt = new Date().toISOString();
  try {
    const result = await loadUpstream(exchange, specs[exchange]);
    const quote: ForeignQuote = {
      exchange,
      ...result.value,
      source: "live",
      checkedAt,
      endpoint: result.endpoint,
      latencyMs: result.latencyMs,
    };
    lastForeign.set(exchange, { value: quote, at: Date.now() });
    return quote;
  } catch (error) {
    const failure = failureDetails(error);
    const stale = lastForeign.get(exchange);
    if (stale && Date.now() - stale.at <= STALE_QUOTE_MS) {
      return {
        ...stale.value,
        source: "stale",
        checkedAt,
        ...failure,
      };
    }
    return {
      exchange,
      ...FOREIGN_FALLBACK[exchange],
      source: "unavailable",
      checkedAt,
      ...failure,
    };
  }
}

async function loadDomesticQuote(
  exchange: keyof typeof DOMESTIC_FALLBACK,
  asset: Asset,
  loadUpstream: ReturnType<typeof createUpstreamClient>,
): Promise<DomesticQuote> {
  const fallback = DOMESTIC_FALLBACK[exchange][asset];
  const base =
    exchange === "Upbit"
      ? "https://api.upbit.com"
      : "https://api.bithumb.com";

  const url = `${base}/v1/orderbook?markets=KRW-${asset}&count=30`;
  const checkedAt = new Date().toISOString();
  try {
    const result = await loadUpstream(`${exchange}-${asset}`, [
      {
        url,
        parse: (raw) =>
          raw as Array<{
            orderbook_units?: Array<{
              bid_price?: number;
              bid_size?: number;
              ask_price?: number;
              ask_size?: number;
            }>;
          }>,
      },
    ]);
    const response = result.value;
    const units = response?.[0]?.orderbook_units ?? [];
    const bids = units
      .map((unit) => ({
        price: numeric(unit.bid_price, 0),
        size: numeric(unit.bid_size, 0),
      }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((a, b) => b.price - a.price);
    const asks = units
      .map((unit) => ({
        price: numeric(unit.ask_price, 0),
        size: numeric(unit.ask_size, 0),
      }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((a, b) => a.price - b.price);
    const bid = bids[0]?.price ?? 0;
    const ask = asks[0]?.price ?? 0;
    if (!bid || !ask) throw new Error("No orderbook");
    const quote: DomesticQuote = {
      exchange,
      asset,
      bid,
      ask,
      bids,
      asks,
      source: "live",
      checkedAt,
      endpoint: result.endpoint,
      latencyMs: result.latencyMs,
    };
    lastDomestic.set(`${exchange}-${asset}`, {
      value: quote,
      at: Date.now(),
    });
    return quote;
  } catch (error) {
    const failure = failureDetails(error);
    const stale = lastDomestic.get(`${exchange}-${asset}`);
    if (stale && Date.now() - stale.at <= STALE_QUOTE_MS) {
      return {
        ...stale.value,
        source: "stale",
        checkedAt,
        ...failure,
      };
    }
    return {
      exchange,
      asset,
      ...fallback,
      ...buildFallbackBook(fallback.bid, fallback.ask, asset),
      source: "unavailable",
      checkedAt,
      ...failure,
    };
  }
}

function normalizeChain(value: unknown) {
  const chain = String(value ?? "").toUpperCase();
  if (chain.includes("TRC") || chain.includes("TRON")) return "Tron";
  if (chain.includes("ERC") || chain === "ETH" || chain.includes("ETHEREUM"))
    return "Ethereum";
  if (chain.includes("KAIA") || chain.includes("KLAY")) return "Kaia";
  if (chain.includes("APT")) return "Aptos";
  if (chain.includes("SOL") || chain.includes("SPL")) return "Solana";
  return null;
}

const DOMESTIC_CHAINS: Record<Asset, Chain[]> = {
  USDT: ["Tron", "Ethereum", "Kaia", "Aptos"],
  USDC: ["Ethereum", "Solana"],
};

function enabled(value: unknown) {
  return value === undefined || String(value).toLowerCase() === "true";
}

async function loadBitgetFee(
  asset: Asset,
  loadUpstream: ReturnType<typeof createUpstreamClient>,
): Promise<FeeAssetResult> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await loadUpstream(`Bitget-${asset}-fees`, [
      {
        url: `https://api.bitget.com/api/v2/spot/public/coins?coin=${asset}`,
        parse: (raw) => {
          const response = raw as {
            data?: Array<{
              chains?: Array<{
                chain?: string;
                chainType?: string;
                withdrawFee?: string;
                withdrawable?: string | boolean;
                rechargeable?: string | boolean;
              }>;
            }>;
          };
          const fees: Partial<Record<Chain, number>> = {};
          for (const item of response.data?.[0]?.chains ?? []) {
            const chain = normalizeChain(item.chainType ?? item.chain);
            const fee = Number(item.withdrawFee);
            if (
              chain &&
              DOMESTIC_CHAINS[asset].includes(chain) &&
              Number.isFinite(fee) &&
              fee >= 0 &&
              enabled(item.withdrawable) &&
              enabled(item.rechargeable)
            ) {
              fees[chain] = fee;
            }
          }
          if (Object.keys(fees).length === 0) {
            throw new Error("No compatible withdrawable chains");
          }
          return fees;
        },
      },
    ]);
    const value: FeeAssetResult = {
      fees: result.value,
      supportedChains: Object.keys(result.value) as Chain[],
      source: "live",
      checkedAt,
      endpoint: result.endpoint,
      latencyMs: result.latencyMs,
    };
    lastBitgetFees.set(asset, { value, at: Date.now() });
    return value;
  } catch (error) {
    const failure = failureDetails(error);
    const stale = lastBitgetFees.get(asset);
    if (stale && Date.now() - stale.at <= STALE_FEE_MS) {
      return {
        ...stale.value,
        source: "stale",
        checkedAt,
        ...failure,
      };
    }
    return {
      fees: {},
      supportedChains: [],
      source: "unavailable",
      checkedAt,
      ...failure,
    };
  }
}

export async function GET() {
  const now = Date.now();
  if (cachedPayload && now - cachedAt < 12_000) {
    return Response.json(cachedPayload, {
      headers: { "cache-control": "public, max-age=6" },
    });
  }

  const loadUpstream = createUpstreamClient();
  const [foreign, domestic, bitgetFeeEntries] = await Promise.all([
    Promise.all(
      (Object.keys(FOREIGN_FALLBACK) as Array<
        keyof typeof FOREIGN_FALLBACK
      >).map((exchange) => loadForeignQuote(exchange, loadUpstream)),
    ),
    Promise.all(
      (["Upbit", "Bithumb"] as const).flatMap((exchange) =>
        (["USDT", "USDC"] as const).map((asset) =>
          loadDomesticQuote(exchange, asset, loadUpstream),
        ),
      ),
    ),
    Promise.all(
      (["USDT", "USDC"] as const).map(async (asset) => [
        asset,
        await loadBitgetFee(asset, loadUpstream),
      ] as const),
    ),
  ]);
  const bitgetFees = Object.fromEntries(bitgetFeeEntries) as Record<
    Asset,
    FeeAssetResult
  >;

  const payload = {
    foreign,
    domestic,
    liveFees: { Bitget: bitgetFees },
    updatedAt: new Date().toISOString(),
    quality: {
      quotes:
        foreign.every((quote) => quote.source === "live") &&
        domestic.every((quote) => quote.source === "live")
          ? "live"
          : "partial",
      fees: Object.values(bitgetFees).every(
        (result) => result.source === "live",
      )
        ? "live"
        : "partial",
    },
    hasFallback:
      foreign.some((quote) => quote.source !== "live") ||
      domestic.some((quote) => quote.source !== "live") ||
      Object.values(bitgetFees).some((result) => result.source !== "live"),
  };

  cachedPayload = payload;
  cachedAt = now;

  return Response.json(payload, {
    headers: { "cache-control": "public, max-age=6" },
  });
}

