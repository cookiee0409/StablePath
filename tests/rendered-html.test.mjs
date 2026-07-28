import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://stablepath.test${path}`, {
      headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the StablePath product page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /StablePath/);
  assert.match(html, /원화 효율 계산기/);
  assert.match(html, /원화 효율/);
  assert.match(html, /전체 경로 순위/);
  assert.match(html, /\/og-v2\.png/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("market API returns auditable market and fee states", async () => {
  const response = await render("/api/market");
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.foreign.length, 4);
  assert.equal(payload.domestic.length, 4);
  for (const quote of [...payload.foreign, ...payload.domestic]) {
    assert.ok(["live", "stale", "unavailable"].includes(quote.source));
    assert.ok(Number.isFinite(Date.parse(quote.checkedAt)));
  }
  for (const quote of [...payload.foreign, ...payload.domestic]) {
    assert.ok(quote.bids.length > 0);
    assert.ok(quote.asks.length > 0);
    assert.ok(quote.bids[0].price > 0);
    assert.ok(quote.bids[0].size > 0);
  }
  for (const asset of ["USDT", "USDC"]) {
    const result = payload.liveFees.Bitget[asset];
    assert.ok(result);
    assert.equal(typeof result.fees, "object");
    assert.ok(Array.isArray(result.supportedChains));
    assert.ok(["live", "stale", "unavailable"].includes(result.source));
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  }
  assert.ok(["live", "partial"].includes(payload.quality.quotes));
  assert.ok(["live", "partial"].includes(payload.quality.fees));
});

test("ships the finished product assets and removes starter markers", async () => {
  const [page, marketRoute, layout, packageJson, lockfile] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /BEST ROUTE/);
  assert.match(page, /WITHDRAWAL FEES/);
  assert.match(page, /TRADING FEES/);
  assert.match(page, /FOREIGN STABLE ORDERBOOK DEPTH/);
  assert.match(page, /해외 스테이블 교환 호가창/);
  assert.match(page, /DOMESTIC ORDERBOOK DEPTH/);
  assert.match(page, /국내 호가창 현황/);
  assert.match(page, /CALCULATION METHOD/);
  assert.match(page, /executeMarketSell/);
  assert.match(page, /executeForeignSwap/);
  assert.match(page, /보유 자산/);
  assert.match(page, /전송할 자산/);
  assert.match(page, /totalWithdrawalFee = withdrawalFee \* transferCount/);
  assert.match(page, /Bithumb: 0\.0004/);
  assert.match(
    page,
    /USDT: \{ Tron: 1\.5, Ethereum: 0\.4, Kaia: 0\.02, Aptos: 0\.1 \}/,
  );
  assert.match(page, /USDC: \{ Ethereum: 0\.6, Solana: 0\.3 \}/);
  assert.match(
    page,
    /USDT: \{ Tron: 1, Ethereum: 0\.8, Kaia: 0\.1, Aptos: 0 \}/,
  );
  assert.match(
    page,
    /USDT: \{ Tron: 1\.5, Ethereum: 0\.63, Aptos: 0\.0014 \}/,
  );
  assert.match(page, /USDC: \{\}/);
  assert.match(page, /출금 수수료 단위/);
  assert.match(page, /1 USDT, USDC 항목의 1은 1 USDC/);
  assert.match(
    page,
    /실제 값과 차이가 있을 수 있으므로, 거래 전 본인이 반드시/,
  );
  assert.match(page, /slippageBps/);
  assert.match(marketRoute, /bid_size/);
  assert.match(marketRoute, /ask_size/);
  assert.match(marketRoute, /count=30/);
  assert.match(marketRoute, /createLimiter\(4\)/);
  assert.match(marketRoute, /data-api\.binance\.vision/);
  assert.match(marketRoute, /api\.bytick\.com/);
  assert.match(marketRoute, /api\/v3\/depth\?symbol=USDCUSDT/);
  assert.match(marketRoute, /v5\/market\/orderbook/);
  assert.match(marketRoute, /market\/books\?instId=USDC-USDT/);
  assert.match(marketRoute, /supportedChains/);
  assert.match(marketRoute, /market upstream request failed/);
  assert.match(page, /foreignExecution\.foreignFullyFillable/);
  assert.match(page, /domesticQuote\.source !== "live"/);
  assert.match(page, /bitget\.USDT\.fees/);
  assert.match(page, /recoverBrowserMarket/);
  assert.match(page, /data-api\.binance\.vision/);
  assert.match(page, /BROWSER_RECOVERY_FAILED/);
  assert.doesNotMatch(
    page,
    /\.\.\.current\.Bitget\.USDT,\s*\.\.\.\(bitget\.USDT/s,
  );
  assert.match(page, /Tron.*Ethereum.*Kaia.*Aptos/s);
  assert.match(page, /Ethereum.*Solana/s);
  assert.match(layout, /generateMetadata/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(lockfile, /react-loading-skeleton/);
  await access(new URL("../public/og-v2.png", import.meta.url));
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});

