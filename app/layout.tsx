import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "StablePath — 원화 효율 계산기";
const description =
  "스테이블 코인과 국내거래소 원화 사이의 가장 유리한 양방향 전송 경로를 체인별 출금 수수료와 매매호가를 반영해 계산합니다.";

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
