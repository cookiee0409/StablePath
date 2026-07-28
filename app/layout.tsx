import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "StablePath — 원화 효율 계산기";
const description =
  "해외거래소의 스테이블 코인을 어떤 자산과 체인으로 보내야 가장 효율이 좋은지 체인별 출금 수수료와 국내 매수호가 잔량을 반영해 계산합니다.";

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
          url: `${origin}/og-v2.png`,
          width: 1736,
          height: 909,
          alt: "StablePath — 원화 효율 계산기",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og-v2.png`],
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
