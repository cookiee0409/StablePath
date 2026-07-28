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

type Source = "live" | "fallback";
type OrderLevel = {
  price: number;
  size: number;
};
type ForeignQuote = {
  exchange: keyof typeof FOREIGN_FALLBACK;
  bid: number;
  ask: number;
  last: number;
  source: Source;
};
type DomesticQuote = {
  exchange: keyof typeof DOMESTIC_FALLBACK;
  asset: "USDT" | "USDC";
  bid: number;
  ask: number;
  bids: OrderLevel[];
  asks: OrderLevel[];
  source: Source;
};

let cachedPayload: unknown;
let cachedAt = 0;

function numeric(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildFallbackBook(
  bid: number,
  ask: number,
  asset: "USDT" | "USDC",
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

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "StablePath/1.0",
      },
      signal: controller.signal,
      cf: { cacheTtl: 8, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadForeignQuotes(): Promise<ForeignQuote[]> {
  const loaders: Record<
    keyof typeof FOREIGN_FALLBACK,
    () => Promise<{ bid: number; ask: number; last: number }>
  > = {
    Binance: async () => {
      const data = (await fetchJson(
        "https://api.binance.com/api/v3/ticker/bookTicker?symbol=USDCUSDT",
      )) as Record<string, unknown>;
      return {
        bid: numeric(data.bidPrice, 0),
        ask: numeric(data.askPrice, 0),
        last: (numeric(data.bidPrice, 0) + numeric(data.askPrice, 0)) / 2,
      };
    },
    Bitget: async () => {
      const response = (await fetchJson(
        "https://api.bitget.com/api/v2/spot/market/tickers?symbol=USDCUSDT",
      )) as { data?: Array<Record<string, unknown>> };
      const data = response.data?.[0] ?? {};
      return {
        bid: numeric(data.bidPr, 0),
        ask: numeric(data.askPr, 0),
        last: numeric(data.lastPr, 0),
      };
    },
    Bybit: async () => {
      const response = (await fetchJson(
        "https://api.bybit.com/v5/market/tickers?category=spot&symbol=USDCUSDT",
      )) as { result?: { list?: Array<Record<string, unknown>> } };
      const data = response.result?.list?.[0] ?? {};
      return {
        bid: numeric(data.bid1Price, 0),
        ask: numeric(data.ask1Price, 0),
        last: numeric(data.lastPrice, 0),
      };
    },
    OKX: async () => {
      const response = (await fetchJson(
        "https://www.okx.com/api/v5/market/ticker?instId=USDC-USDT",
      )) as { data?: Array<Record<string, unknown>> };
      const data = response.data?.[0] ?? {};
      return {
        bid: numeric(data.bidPx, 0),
        ask: numeric(data.askPx, 0),
        last: numeric(data.last, 0),
      };
    },
  };

  return Promise.all(
    (Object.keys(loaders) as Array<keyof typeof loaders>).map(
      async (exchange) => {
        const fallback = FOREIGN_FALLBACK[exchange];
        try {
          const live = await loaders[exchange]();
          if (!live.bid || !live.ask || !live.last) throw new Error("No quote");
          return { exchange, ...live, source: "live" as const };
        } catch {
          return { exchange, ...fallback, source: "fallback" as const };
        }
      },
    ),
  );
}

async function loadDomesticQuote(
  exchange: keyof typeof DOMESTIC_FALLBACK,
  asset: "USDT" | "USDC",
): Promise<DomesticQuote> {
  const fallback = DOMESTIC_FALLBACK[exchange][asset];
  const base =
    exchange === "Upbit"
      ? "https://api.upbit.com"
      : "https://api.bithumb.com";

  try {
    const response = (await fetchJson(
      `${base}/v1/orderbook?markets=KRW-${asset}&count=30`,
    )) as Array<{
      orderbook_units?: Array<{
        bid_price?: number;
        bid_size?: number;
        ask_price?: number;
        ask_size?: number;
      }>;
    }>;
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
    return { exchange, asset, bid, ask, bids, asks, source: "live" };
  } catch {
    return {
      exchange,
      asset,
      ...fallback,
      ...buildFallbackBook(fallback.bid, fallback.ask, asset),
      source: "fallback",
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

async function loadBitgetFees() {
  const assets = ["USDT", "USDC"] as const;
  const entries = await Promise.all(
    assets.map(async (asset) => {
      try {
        const response = (await fetchJson(
          `https://api.bitget.com/api/v2/spot/public/coins?coin=${asset}`,
        )) as {
          data?: Array<{
            chains?: Array<{
              chain?: string;
              chainType?: string;
              withdrawFee?: string;
              withdrawable?: string;
              rechargeable?: string;
            }>;
          }>;
        };
        const fees: Record<string, number> = {};
        for (const item of response.data?.[0]?.chains ?? []) {
          const chain = normalizeChain(item.chainType ?? item.chain);
          const fee = Number(item.withdrawFee);
          if (
            chain &&
            Number.isFinite(fee) &&
            fee >= 0 &&
            item.withdrawable !== "false" &&
            item.rechargeable !== "false"
          ) {
            fees[chain] = fee;
          }
        }
        return [asset, fees] as const;
      } catch {
        return [asset, {}] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export async function GET() {
  const now = Date.now();
  if (cachedPayload && now - cachedAt < 12_000) {
    return Response.json(cachedPayload, {
      headers: { "cache-control": "public, max-age=6" },
    });
  }

  const [foreign, domestic, bitgetFees] = await Promise.all([
    loadForeignQuotes(),
    Promise.all(
      (["Upbit", "Bithumb"] as const).flatMap((exchange) =>
        (["USDT", "USDC"] as const).map((asset) =>
          loadDomesticQuote(exchange, asset),
        ),
      ),
    ),
    loadBitgetFees(),
  ]);

  const payload = {
    foreign,
    domestic,
    liveFees: { Bitget: bitgetFees },
    updatedAt: new Date().toISOString(),
    hasFallback:
      foreign.some((quote) => quote.source === "fallback") ||
      domestic.some((quote) => quote.source === "fallback"),
  };

  cachedPayload = payload;
  cachedAt = now;

  return Response.json(payload, {
    headers: { "cache-control": "public, max-age=6" },
  });
}
