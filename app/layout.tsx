import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "StablePath — 스테이블코인 원화 전송 경로 비교";
const description =
  "바이낸스·비트겟·바이빗·OKX에서 업비트·빗썸으로 USDT와 USDC를 전송해 원화로 바꾸는 최적 경로를 비교합니다.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      locale: "ko_KR",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1736,
          height: 909,
          alt: "StablePath — 원화로 닿는 가장 좋은 길",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
