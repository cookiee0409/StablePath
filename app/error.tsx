"use client";

import { useEffect } from "react";

const FEE_STORAGE_KEYS = [
  "stablepath-fee-overrides-v3",
  "stablepath-fees-v2",
  "stablepath-trading-fees",
];

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const clearSavedSettings = () => {
    try {
      for (const key of FEE_STORAGE_KEYS) localStorage.removeItem(key);
    } catch {
      // Nothing to clear if storage is unavailable.
    }
    reset();
  };

  return (
    <main className="error-page">
      <div className="error-card">
        <p className="eyebrow">SOMETHING WENT WRONG</p>
        <h1>화면을 표시하지 못했습니다.</h1>
        <p>
          저장된 수수료 설정이 손상되었을 때 이 화면이 나타날 수 있습니다.
          다시 시도해도 같은 화면이 보이면 저장된 설정을 지워 주세요. 시세와
          기본 수수료는 다시 불러옵니다.
        </p>
        <div className="error-actions">
          <button type="button" className="primary-button" onClick={reset}>
            다시 시도
          </button>
          <button
            type="button"
            className="text-button"
            onClick={clearSavedSettings}
          >
            저장된 수수료 설정 지우고 다시 시도
          </button>
        </div>
        {error.digest && <small>오류 코드 {error.digest}</small>}
      </div>
    </main>
  );
}
