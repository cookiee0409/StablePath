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
  assert.match(html, /스테이블코인 원화 전송 경로 비교/);
  assert.match(html, /원화로 닿는/);
  assert.match(html, /전체 경로 순위/);
  assert.match(html, /\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("market API returns domestic orderbook depth for every KRW market", async () => {
  const response = await render("/api/market");
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.domestic.length, 4);
  for (const quote of payload.domestic) {
    assert.ok(quote.bids.length > 0);
    assert.ok(quote.asks.length > 0);
    assert.ok(quote.bids[0].price > 0);
    assert.ok(quote.bids[0].size > 0);
  }
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
  assert.match(page, /DOMESTIC ORDERBOOK DEPTH/);
  assert.match(page, /CALCULATION METHOD/);
  assert.match(page, /executeMarketSell/);
  assert.match(page, /slippageBps/);
  assert.match(marketRoute, /bid_size/);
  assert.match(marketRoute, /ask_size/);
  assert.match(marketRoute, /count=30/);
  assert.match(page, /Tron.*Ethereum.*Kaia.*Aptos/s);
  assert.match(page, /Ethereum.*Solana/s);
  assert.match(layout, /generateMetadata/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(lockfile, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});
