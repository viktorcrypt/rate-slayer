import { useEffect, useState } from "react";
import { WagmiProvider, useAccount, useConnect } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sendCalls, getCapabilities, readContract } from "@wagmi/core";
import { parseAbi, encodeFunctionData } from "viem";
import powellImg from "./assets/powell.png";
import "./App.css";

// === ADDRESS / CHAIN ===
const CONTRACT_ADDRESS = "0xeC6AF3c5934F383972bb9980A51EC976099270b8";
const CHAIN_ID = base.id; // 8453

// Paymaster (замени на свой URL от Coinbase Developer Platform)
// Пока закомментировано - пользователи платят газ сами
// const PAYMASTER_URL = "YOUR_PAYMASTER_URL";
const PAYMASTER_URL = null; // Отключен - юзеры платят газ

// === ABI ===
const CONTRACT_ABI = parseAbi([
  "function rateBps() view returns (uint256)",
  "function totalPresses() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function timeUntilNextPress(address user) view returns (uint256)",
  "function getCurrentRate() view returns (uint256)",
  "function press()",
  "function RATE_INCREASE_PER_HOUR() view returns (uint256)",
  "function DECREASE_PER_PRESS() view returns (uint256)",
  "function MAX_RATE() view returns (uint256)",
]);

// === WAGMI CONFIG ===
const config = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(),
  },
  connectors: [
    farcasterMiniApp(),
    baseAccount({
      appName: "Beat Powell",
      appLogoUrl: "https://base.org/logo.png",
    }),
  ],
});

const queryClient = new QueryClient();

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BeatPowellApp />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function BeatPowellApp() {
  const { address } = useAccount();
  const { connect, connectors, isPending } = useConnect();

  const [rate, setRate] = useState(null);
  const [currentRate, setCurrentRate] = useState(null);
  const [presses, setPresses] = useState(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [message, setMessage] = useState("");

  // Константы из контракта
  const [rateIncrease, setRateIncrease] = useState(5);
  const [rateDecrease, setRateDecrease] = useState(1);
  const [maxRate, setMaxRate] = useState(375);

  const connected = !!address;

  const loadData = async () => {
    try {
      const [rateBps, totalPresses, currentRateBps, increasePerHour, decreasePerPress, maxRateBps] = await Promise.all([
        readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "rateBps",
          chainId: CHAIN_ID,
        }),
        readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "totalPresses",
          chainId: CHAIN_ID,
        }),
        readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "getCurrentRate",
          chainId: CHAIN_ID,
        }),
        readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "RATE_INCREASE_PER_HOUR",
          chainId: CHAIN_ID,
        }),
        readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "DECREASE_PER_PRESS",
          chainId: CHAIN_ID,
        }),
        readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "MAX_RATE",
          chainId: CHAIN_ID,
        }),
      ]);

      setRate(Number(rateBps) / 100);
      setCurrentRate(Number(currentRateBps) / 100);
      setPresses(Number(totalPresses));
      setRateIncrease(Number(increasePerHour) / 100);
      setRateDecrease(Number(decreasePerPress) / 100);
      setMaxRate(Number(maxRateBps) / 100);

      if (address) {
        const cd = await readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "timeUntilNextPress",
          args: [address],
          chainId: CHAIN_ID,
        });
        setCooldownSec(Number(cd));
      }
    } catch (e) {
      console.warn("loadData error:", e);
    }
  };

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, 8000);
    return () => clearInterval(id);
  }, [address]);

  const connectWallet = async () => {
    try {
      setMessage("");
      const connector = connectors[0];
      if (!connector) return setMessage("No wallet connectors available");
      await connect({ connector });
    } catch (e) {
      console.error(e);
      setMessage(humanError(e));
    }
  };

  const handlePress = async () => {
    try {
      if (!connected || !address) {
        return setMessage("Open inside Base App / connect first");
      }

      setLoading(true);
      setMessage("");
      setShake(true);
      setTimeout(() => setShake(false), 500);

      const account = address;

      // Проверяем cooldown
      if (cooldownSec > 0) {
        setMessage(`Wait ${formatTime(cooldownSec)} until next press`);
        setLoading(false);
        return;
      }

      const data = encodeFunctionData({
        abi: CONTRACT_ABI,
        functionName: "press",
        args: [],
      });

      // getCapabilities для paymaster
      const capabilities = await getCapabilities(config, { account });
      const baseCapabilities = capabilities?.[8453];
      const supportsPaymaster = PAYMASTER_URL && !!baseCapabilities?.paymasterService?.supported;

      await sendCalls(config, {
        account,
        calls: [{ to: CONTRACT_ADDRESS, data }],
        chainId: 8453,
        capabilities: supportsPaymaster
          ? {
              paymasterService: {
                url: PAYMASTER_URL,
              },
            }
          : undefined,
      });

      setMessage(
        supportsPaymaster
          ? "✅ Hit successful (gas sponsored)!"
          : "✅ Hit successful!"
      );

      await loadData();
    } catch (e) {
      console.error(e);
      setMessage(humanError(e));
    } finally {
      setLoading(false);
    }
  };

  const progressWidth = rate != null ? Math.max(0, Math.min(100, (rate / maxRate) * 100)) : 0;
  const canPress = cooldownSec === 0;

  if (!connected) {
    return (
      <div className="app">
        <h1 className="title">💼 Beat Powell</h1>
        <p className="subtitle">Lower the Fed rate onchain with Base Account</p>

        <div className="info-box">
          <p className="info-line">
            <span className="info-emoji">📉</span>
            <span>Each hit lowers rate by <b>{rateDecrease}%</b></span>
          </p>
          <p className="info-line">
            <span className="info-emoji">📈</span>
            <span>Powell recovers <b>+{rateIncrease}%</b> every hour</span>
          </p>
          <p className="info-line">
            <span className="info-emoji">⏰</span>
            <span>1 hit per hour per wallet</span>
          </p>
        </div>

        <button className="connect-btn" onClick={connectWallet} disabled={isPending}>
          {isPending ? "Connecting..." : "Connect Base Account"}
        </button>

        {message && <p className="msg error">{message}</p>}
      </div>
    );
  }

  return (
    <div className="app">
      <h1 className="title">💼 Beat Powell</h1>
      <p className="subtitle">Lower the Fed rate onchain</p>

      <div className={`powell ${shake ? "shake" : ""}`}>
        <div className="powell-glow">
          <img src={powellImg} alt="Powell" className="powell-img" />
        </div>
      </div>

      <div className="rate-box">
        <div className="rate-label">Current Fed Rate</div>
        <div className="rate-value">
          {currentRate != null ? `${currentRate.toFixed(2)}%` : "..."}
        </div>
        <div className="rate-bar">
          <div className="rate-progress" style={{ width: `${progressWidth}%` }} />
        </div>
        {currentRate !== rate && (
          <div className="rate-hint">
            💪 Rate recovering... (stored: {rate?.toFixed(2)}%)
          </div>
        )}
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Hits</div>
          <div className="stat-value">{presses ?? "..."}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Your Cooldown</div>
          <div className="stat-value">
            {cooldownSec > 0 ? formatTime(cooldownSec) : "Ready! 🔥"}
          </div>
        </div>
      </div>

      <div className="info-box compact">
        <p className="info-line">
          <span className="info-emoji">📉</span>
          <span>Each hit: <b>-{rateDecrease}%</b></span>
        </p>
        <p className="info-line">
          <span className="info-emoji">📈</span>
          <span>Powell recovers: <b>+{rateIncrease}%/hour</b></span>
        </p>
      </div>

      <button
        className={`press-btn ${loading ? "loading" : ""} ${!canPress ? "disabled" : ""}`}
        onClick={handlePress}
        disabled={loading || !canPress}
      >
        {loading ? "Processing..." : canPress ? "HIT POWELL 👊" : `Wait ${formatTime(cooldownSec)}`}
      </button>

      {message && <p className="msg">{message}</p>}

      <p className="address">
        {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"}
      </p>

      <div className="footer-note">
        The printer goes BRRR 🖨️💸
      </div>
    </div>
  );
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function humanError(e) {
  return (
    e?.shortMessage ||
    e?.reason ||
    e?.data?.message ||
    e?.message ||
    String(e)
  );
}
