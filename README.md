# StablePath

해외거래소의 USDT·USDC를 업비트 또는 빗썸으로 전송하고 원화로 매도할 때,
예상 원화 도착액이 가장 큰 경로를 비교하는 웹 애플리케이션입니다.

## 주요 기능

- Binance, Bitget, Bybit, OKX의 USDC/USDT 최우선 호가 비교
- Upbit, Bithumb의 USDT·USDC 원화 매수호가 비교
- USDT 직접 전송 또는 USDC 전환 후 전송 동시 계산
- USDT: TRON, Ethereum, Kaia, Aptos 지원
- USDC: Ethereum, Solana 지원
- 체인별 출금 수수료 직접 수정 및 브라우저 저장
- 전체 경로 예상 원화 도착액 순위 제공

## 실행

```bash
npm install
npm run dev
npm run build
npm test
```

실제 전송 전에는 각 거래소의 입출금 상태, 수수료, 최소 입금액, 주소와 체인,
트래블룰 조건을 반드시 다시 확인해야 합니다.

