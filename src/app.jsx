import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WagmiProvider, useAccount, useConnect, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sendCalls, getCapabilities, getPublicClient, readContract } from "@wagmi/core";
import { parseAbi, parseAbiItem, encodeFunctionData } from "viem";
import { useComposeCast, useMiniKit } from "@coinbase/onchainkit/minikit";
import powellImg from "./assets/powell.png";
import "./app.css";

const CONTRACT_ADDRESS =
  import.meta.env?.VITE_CONTRACT_ADDRESS?.trim() ||
  "0xeC6AF3c5934F383972bb9980A51EC976099270b8";
const CHAIN_ID = base.id;
const DEFAULT_LOG_LOOKBACK_BLOCKS = 300000n;
const LOG_CHUNK_SIZE = 50000n;

const PAYMASTER_URL = import.meta.env?.VITE_PAYMASTER_URL?.trim() || null;
const LOCAL_HITS_KEY_PREFIX = "beatpowell:hits:";
const CONTRACT_DEPLOY_BLOCK = (() => {
  const raw = String(import.meta.env?.VITE_CONTRACT_DEPLOY_BLOCK ?? "").trim();
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
})();

const runtimeOrigin =
  typeof globalThis !== "undefined" && globalThis.location?.origin
    ? globalThis.location.origin
    : "https://rate-slayer.vercel.app";
const APP_URL =
  (import.meta.env?.VITE_APP_URL && String(import.meta.env.VITE_APP_URL).trim()) ||
  runtimeOrigin;
const APP_LOGO_URL = `${APP_URL.replace(/\/$/, "")}/icon.png`;

const CONTRACT_ABI = parseAbi([
  "function rateBps() view returns (uint256)",
  "function totalPresses() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function lastPressTime(address user) view returns (uint256)",
  "function timeUntilNextPress(address user) view returns (uint256)",
  "function getCurrentRate() view returns (uint256)",
  "function press()",
  "function RATE_INCREASE_PER_HOUR() view returns (uint256)",
  "function DECREASE_PER_PRESS() view returns (uint256)",
  "function MAX_RATE() view returns (uint256)",
]);

const PRESSED_EVENT = parseAbiItem(
  "event Pressed(address indexed user, uint256 newRate, uint256 totalPresses)"
);

const config = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(),
  },
  connectors: [
    baseAccount({
      appName: "Beat Powell",
      appLogoUrl: APP_LOGO_URL,
    }),
    farcasterMiniApp(),
  ],
});

const queryClient = new QueryClient();

class MiniKitErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <MiniKitErrorBoundary fallback={<BeatPowellAppCore />}>
          <BeatPowellAppWithMiniKit />
        </MiniKitErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function BeatPowellAppWithMiniKit() {
  const miniKit = useMiniKit();
  const { composeCast } = useComposeCast();
  return <BeatPowellAppCore miniKit={miniKit} composeCast={composeCast} />;
}

function BeatPowellAppCore({ miniKit = null, composeCast = null }) {
  const { address, chain } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain } = useSwitchChain();

  const contextUser = miniKit?.context?.user ?? {};
  const rawName =
    contextUser?.displayName ||
    contextUser?.username ||
    contextUser?.display_name ||
    contextUser?.userName ||
    "";

  const [rate, setRate] = useState(null);
  const [currentRate, setCurrentRate] = useState(null);
  const [presses, setPresses] = useState(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [toast, setToast] = useState("");
  const [lastAction, setLastAction] = useState(null);
  const [activeTab, setActiveTab] = useState("arena");

  const [rateIncrease, setRateIncrease] = useState(5);
  const [rateDecrease, setRateDecrease] = useState(1);
  const [maxRate, setMaxRate] = useState(375);
  const [userHits, setUserHits] = useState(null);
  const [userHitsSource, setUserHitsSource] = useState("local");
  const [localConfirmedHits, setLocalConfirmedHits] = useState(0);

  const toastTimerRef = useRef(null);
  const connectAttemptedRef = useRef(false);
  const localHitKey = useMemo(
    () => (address ? `${LOCAL_HITS_KEY_PREFIX}${address.toLowerCase()}` : null),
    [address]
  );

  const connected = Boolean(address);

  const displayName = rawName || (connected ? "Wallet User" : "Base Player");
  const avatarUrl = contextUser?.pfpUrl || contextUser?.avatarUrl || null;

  const getPreferredConnector = useCallback(() => {
    return (
      connectors.find((item) => {
        const id = String(item?.id || "").toLowerCase();
        const name = String(item?.name || "").toLowerCase();
        return id.includes("base") || name.includes("base");
      }) || connectors[0]
    );
  }, [connectors]);

  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 3200);
  }, []);

  const resolveUserHitsFromEvents = useCallback(async (walletAddress) => {
    try {
      const publicClient = getPublicClient(config, { chainId: CHAIN_ID });
      if (!publicClient) return null;

      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock =
        CONTRACT_DEPLOY_BLOCK != null
          ? CONTRACT_DEPLOY_BLOCK
          : latestBlock > DEFAULT_LOG_LOOKBACK_BLOCKS
            ? latestBlock - DEFAULT_LOG_LOOKBACK_BLOCKS
            : 0n;

      let total = 0;
      for (let start = fromBlock; start <= latestBlock; start += LOG_CHUNK_SIZE + 1n) {
        const end = start + LOG_CHUNK_SIZE > latestBlock ? latestBlock : start + LOG_CHUNK_SIZE;
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESS,
          event: PRESSED_EVENT,
          args: { user: walletAddress },
          fromBlock: start,
          toBlock: end,
        });
        total += logs.length;
      }

      return total;
    } catch (error) {
      console.warn("resolveUserHitsFromEvents error:", error);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!localHitKey || typeof window === "undefined") {
      setLocalConfirmedHits(0);
      return;
    }
    const raw = window.localStorage.getItem(localHitKey);
    const parsed = Number.parseInt(raw || "0", 10);
    setLocalConfirmedHits(Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
  }, [localHitKey]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof miniKit?.setFrameReady !== "function" || miniKit?.isFrameReady) return;
    miniKit.setFrameReady();
  }, [miniKit]);

  useEffect(() => {
    if (connected || isPending || connectAttemptedRef.current) return;
    const connector = getPreferredConnector();
    if (!connector) return;

    connectAttemptedRef.current = true;
    connect({ connector }).catch(() => {
      setStatusMessage("Connect your Base Account to start.");
    });
  }, [connect, connected, getPreferredConnector, isPending]);

  useEffect(() => {
    if (connected && chain && chain.id !== CHAIN_ID) {
      setStatusMessage("Switching to Base network...");
      switchChain?.({ chainId: CHAIN_ID });
      setTimeout(() => setStatusMessage(""), 3000);
    }
  }, [connected, chain, switchChain]);

  const loadData = useCallback(async () => {
    try {
      const [
        rateBps,
        totalPresses,
        currentRateBps,
        increasePerHour,
        decreasePerPress,
        maxRateBps,
      ] = await Promise.all([
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
      } else {
        setCooldownSec(0);
        setUserHits(null);
        setUserHitsSource("local");
      }
    } catch (e) {
      console.warn("loadData error:", e);
    }
  }, [address]);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, 8000);
    return () => clearInterval(id);
  }, [loadData]);

  const loadUserHits = useCallback(async () => {
    if (!address) {
      setUserHits(null);
      setUserHitsSource("local");
      return;
    }

    const fromEvents = await resolveUserHitsFromEvents(address);
    if (fromEvents != null) {
      setUserHits(fromEvents);
      setUserHitsSource(CONTRACT_DEPLOY_BLOCK != null ? "events" : "events_recent");
      return;
    }

    setUserHits(null);
    setUserHitsSource("local");
  }, [address, resolveUserHitsFromEvents]);

  useEffect(() => {
    loadUserHits();
  }, [loadUserHits, lastAction?.at]);

  const connectWallet = useCallback(async () => {
    try {
      setStatusMessage("");
      const connector = getPreferredConnector();
      if (!connector) {
        setStatusMessage("No wallet connectors available.");
        return;
      }
      await connect({ connector });
    } catch (e) {
      setStatusMessage(humanError(e));
    }
  }, [connect, getPreferredConnector]);

  const handleShareResult = useCallback(async (rateValue = null) => {
    const rateLabel =
      typeof rateValue === "number" && Number.isFinite(rateValue)
        ? `${rateValue.toFixed(2)}%`
        : "live rate";
    const resultLine = `I just hit Powell on Base. Current Fed rate: ${rateLabel}.`;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const shareUrl =
      origin ||
      (typeof window !== "undefined" ? window.location.href : "");

    if (!composeCast) {
      try {
        if (typeof navigator !== "undefined" && navigator.share) {
          await navigator.share({
            text: resultLine,
            url: shareUrl || undefined,
          });
          return;
        }
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(
            shareUrl ? `${resultLine}\n${shareUrl}` : resultLine
          );
          showToast("Result copied. Share it anywhere.");
          return;
        }
      } catch {
        // Intentionally ignored; fallback toast below.
      }

      showToast("Share is unavailable in this client.");
      return;
    }

    try {
      await composeCast({
        text: resultLine,
        embeds: shareUrl ? [shareUrl] : undefined,
      });
    } catch {
      showToast("Share failed. Try again.");
    }
  }, [composeCast, showToast]);

  const handlePress = useCallback(async () => {
    try {
      if (!connected || !address) {
        setStatusMessage("Open in Base App or connect your Base Account first.");
        setActiveTab("wallet");
        return;
      }

      if (cooldownSec > 0) {
        setStatusMessage(`Wait ${formatTime(cooldownSec)} until next press.`);
        return;
      }

      setLoading(true);
      setStatusMessage("");
      setShake(true);
      setTimeout(() => setShake(false), 500);

      const data = encodeFunctionData({
        abi: CONTRACT_ABI,
        functionName: "press",
        args: [],
      });

      const capabilities = await getCapabilities(config, { account: address });
      const baseCapabilities = capabilities?.[CHAIN_ID];
      const supportsPaymaster = Boolean(
        PAYMASTER_URL && baseCapabilities?.paymasterService?.supported
      );

      await sendCalls(config, {
        account: address,
        calls: [{ to: CONTRACT_ADDRESS, data }],
        chainId: CHAIN_ID,
        capabilities: supportsPaymaster
          ? {
              paymasterService: {
                url: PAYMASTER_URL,
              },
            }
          : undefined,
      });

      showToast(
        supportsPaymaster
          ? "Hit confirmed. Gas sponsored."
          : "Hit confirmed."
      );

      setLastAction({
        sponsored: supportsPaymaster,
        at: Date.now(),
      });

      if (typeof window !== "undefined" && address) {
        const key = `${LOCAL_HITS_KEY_PREFIX}${address.toLowerCase()}`;
        const raw = window.localStorage.getItem(key);
        const parsed = Number.parseInt(raw || "0", 10);
        const next = (Number.isFinite(parsed) ? parsed : 0) + 1;
        window.localStorage.setItem(key, String(next));
        setLocalConfirmedHits(next);
      }

      await loadData();

      try {
        const latestRateBps = await readContract(config, {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: "getCurrentRate",
          chainId: CHAIN_ID,
        });
        await handleShareResult(Number(latestRateBps) / 100);
      } catch {
        await handleShareResult(currentRate);
      }
    } catch (e) {
      setStatusMessage(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [address, connected, cooldownSec, currentRate, handleShareResult, loadData, showToast]);

  const progressWidth =
    rate != null ? Math.max(0, Math.min(100, (rate / maxRate) * 100)) : 0;
  const canPress = connected && cooldownSec === 0;
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected";
  const effectiveUserHits = userHits != null ? userHits : localConfirmedHits;
  const safeGlobalHits = presses != null ? Math.max(0, presses) : 0;
  const safeUserHits = Math.max(0, Math.min(effectiveUserHits, safeGlobalHits || effectiveUserHits));
  const othersHits = Math.max(0, safeGlobalHits - safeUserHits);
  const walletSharePct =
    safeGlobalHits > 0 ? Math.round((safeUserHits / safeGlobalHits) * 100) : 0;
  const othersSharePct = safeGlobalHits > 0 ? 100 - walletSharePct : 0;

  return (
    <div className="app-shell">
      <header className="top-header">
        <h1 className="title">BEAT POWELL</h1>
        <div className="ticker-wrap" aria-label="Market ticker">
          <div className="ticker-track">
            <span className="ticker-item">Humans + agents are attacking the Fed rate</span>
            <span className="ticker-item">Money printer heat index: elevated</span>
            <span className="ticker-item">Hit fast before the rate snaps back up</span>
            <span className="ticker-item">Humans + agents are attacking the Fed rate</span>
            <span className="ticker-item">Money printer heat index: elevated</span>
            <span className="ticker-item">Hit fast before the rate snaps back up</span>
          </div>
        </div>
      </header>

      <button
        className="wallet-strip"
        type="button"
        onClick={() => setActiveTab("wallet")}
      >
        <span className="wallet-strip-left">
          {avatarUrl ? (
            <img src={avatarUrl} alt={displayName} className="wallet-avatar" />
          ) : (
            <span className="wallet-avatar wallet-avatar-fallback">{displayName.slice(0, 1)}</span>
          )}
          <span>
            <span className="wallet-name">{displayName}</span>
            <span className="wallet-address">{shortAddress}</span>
          </span>
        </span>
        <span className={`wallet-chip ${connected ? "on" : "off"}`}>
          {connected ? "Connected" : "Connect"}
        </span>
      </button>

      <main className="tab-content">
        {activeTab === "arena" && (
          <section className="tab-panel arena-panel">
            <div className="mission-card">
              <div className="mission-title">Mission</div>
              <div className="mission-text">
                Real players and wallet agents work together to drag the Fed rate down.
                Think of it as jamming Powell&apos;s money printer one hit at a time.
              </div>
            </div>

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
            </div>

            <div className="combat-row">
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-label">Total Hits</div>
                  <div className="stat-value">{presses ?? "..."}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Cooldown</div>
                  <div className="stat-value">
                    {!connected ? "Connect first" : cooldownSec > 0 ? formatTime(cooldownSec) : "Ready"}
                  </div>
                </div>
              </div>
              <button
                className={`press-btn press-btn-side ${loading ? "loading" : ""} ${!canPress ? "disabled" : ""}`}
                onClick={handlePress}
                disabled={loading || !canPress}
                type="button"
              >
                {loading
                  ? "Processing..."
                  : !connected
                    ? "Connect Base Account"
                    : canPress
                      ? "HIT POWELL"
                      : `Wait ${formatTime(cooldownSec)}`}
              </button>
            </div>

            <div className="printer-gif-card" aria-label="Powell money printer cam">
              <img
                src="/powellprint.gif"
                alt="Powell spinning the money printer"
                className="printer-gif"
              />
            </div>
          </section>
        )}

        {activeTab === "wallet" && (
          <section className="tab-panel wallet-panel">
            <div className="wallet-panel-header">
              {avatarUrl ? (
                <img src={avatarUrl} alt={displayName} className="wallet-avatar large" />
              ) : (
                <span className="wallet-avatar wallet-avatar-fallback large">{displayName.slice(0, 1)}</span>
              )}
              <div>
                <div className="wallet-name large">{displayName}</div>
                <div className="wallet-address">{shortAddress}</div>
              </div>
            </div>

            {!connected && (
              <button className="connect-btn" onClick={connectWallet} disabled={isPending} type="button">
                {isPending ? "Connecting..." : "Connect Base Account"}
              </button>
            )}

            <div className="cabinet-grid">
              <div className="stat-card">
                <div className="stat-label">Your Success Hits</div>
                <div className="stat-value">{connected ? safeUserHits : "--"}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Global Hits</div>
                <div className="stat-value">{presses ?? "..."}</div>
              </div>
            </div>

            <div className="info-box compact">
              <p className="info-line">
                <span className="info-key">Source:</span>
                <span>
                  {userHitsSource === "events"
                    ? "Onchain event history (full)."
                    : userHitsSource === "events_recent"
                      ? "Recent onchain events (set VITE_CONTRACT_DEPLOY_BLOCK for full history)."
                      : "Local confirmed hits in this app."}
                </span>
              </p>
              <p className="info-line">
                <span className="info-key">Cooldown:</span>
                <span>
                  {!connected ? "Connect first" : cooldownSec > 0 ? formatTime(cooldownSec) : "Ready now"}
                </span>
              </p>
            </div>

            <div className="agent-diagram" aria-label="Action split between wallets">
              <div className="agent-diagram-title">Action Split (Agents + Humans)</div>
              <div className="agent-row">
                <span className="agent-row-label">Your wallet</span>
                <div className="agent-track">
                  <div className="agent-fill your" style={{ width: `${walletSharePct}%` }} />
                </div>
                <span className="agent-row-value">{connected ? safeUserHits : "--"}</span>
              </div>
              <div className="agent-row">
                <span className="agent-row-label">Other wallets</span>
                <div className="agent-track">
                  <div className="agent-fill others" style={{ width: `${othersSharePct}%` }} />
                </div>
                <span className="agent-row-value">{presses != null ? othersHits : "..."}</span>
              </div>
            </div>
          </section>
        )}

        {activeTab === "briefing" && (
          <section className="tab-panel briefing-panel">
            <div className="mission-card">
              <div className="mission-title">How The Game Works</div>
              <div className="mission-list">
                <div>1. Humans and agents make the same onchain hit.</div>
                <div>2. Each hit lowers the rate by {rateDecrease}%.</div>
                <div>3. Powell recovers +{rateIncrease}% every hour.</div>
                <div>4. Every wallet has a 1-hour cooldown.</div>
                <div>5. Goal: keep pressure on rates and cool the printer.</div>
              </div>
            </div>
          </section>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <button
          type="button"
          className={`nav-btn ${activeTab === "arena" ? "active" : ""}`}
          onClick={() => setActiveTab("arena")}
        >
          Fed Floor
        </button>
        <button
          type="button"
          className={`nav-btn ${activeTab === "wallet" ? "active" : ""}`}
          onClick={() => setActiveTab("wallet")}
        >
          Cabinet
        </button>
        <button
          type="button"
          className={`nav-btn ${activeTab === "briefing" ? "active" : ""}`}
          onClick={() => setActiveTab("briefing")}
        >
          Briefing
        </button>
      </nav>

      {statusMessage && <p className="msg error floating-msg">{statusMessage}</p>}
      {toast && <div className="toast" role="status">{toast}</div>}
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
