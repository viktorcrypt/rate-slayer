import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WagmiProvider, useAccount, useConnect, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sendCalls, getCapabilities, readContract } from "@wagmi/core";
import { parseAbi, encodeFunctionData } from "viem";
import { useComposeCast, useMiniKit } from "@coinbase/onchainkit/minikit";
import powellImg from "./assets/powell.png";
import "./app.css";

const CONTRACT_ADDRESS =
  import.meta.env?.VITE_CONTRACT_ADDRESS?.trim() ||
  "0xeC6AF3c5934F383972bb9980A51EC976099270b8";
const CHAIN_ID = base.id;

const PAYMASTER_URL = import.meta.env?.VITE_PAYMASTER_URL?.trim() || null;

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
  "function timeUntilNextPress(address user) view returns (uint256)",
  "function getCurrentRate() view returns (uint256)",
  "function press()",
  "function RATE_INCREASE_PER_HOUR() view returns (uint256)",
  "function DECREASE_PER_PRESS() view returns (uint256)",
  "function MAX_RATE() view returns (uint256)",
]);

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

  const context = miniKit?.context;
  const setFrameReady = miniKit?.setFrameReady;
  const isFrameReady = miniKit?.isFrameReady;

  const profile = context?.user ?? {};
  const displayName =
    profile.displayName ||
    profile.username ||
    "Base Player";
  const avatarUrl = profile.pfpUrl || null;
  const hasSocialIdentity = Boolean(
    profile?.fid || profile?.username || profile?.displayName
  );

  const [rate, setRate] = useState(null);
  const [currentRate, setCurrentRate] = useState(null);
  const [presses, setPresses] = useState(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [toast, setToast] = useState("");
  const [lastAction, setLastAction] = useState(null);

  const [rateIncrease, setRateIncrease] = useState(5);
  const [rateDecrease, setRateDecrease] = useState(1);
  const [maxRate, setMaxRate] = useState(375);

  const toastTimerRef = useRef(null);
  const connectAttemptedRef = useRef(false);

  const connected = Boolean(address);

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

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof setFrameReady !== "function" || isFrameReady) return;
    setFrameReady();
  }, [isFrameReady, setFrameReady]);

  useEffect(() => {
    if (connected || isPending || connectAttemptedRef.current) return;
    const connector = getPreferredConnector();
    if (!connector) return;

    connectAttemptedRef.current = true;
    connect({ connector }).catch(() => {
      setStatusMessage("Connect your Base Account to start playing.");
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

  const handlePress = useCallback(async () => {
    try {
      if (!connected || !address) {
        setStatusMessage("Open in Base App or connect your Base Account first.");
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
          ? "Hit successful (gas sponsored)."
          : "Hit successful."
      );

      setLastAction({
        sponsored: supportsPaymaster,
        at: Date.now(),
      });

      await loadData();
    } catch (e) {
      setStatusMessage(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [address, connected, cooldownSec, loadData, showToast]);

  const handleShare = useCallback(async () => {
    if (!lastAction) return;

    if (!hasSocialIdentity) {
      showToast("Share skipped for wallet-only agent accounts.");
      return;
    }

    const rateLabel =
      currentRate != null ? `${currentRate.toFixed(2)}%` : "live rate";
    const shareText = `I just hit Powell on Base. Current Fed rate: ${rateLabel}.`;

    try {
      if (composeCast) {
        await composeCast({
          text: shareText,
          embeds: [APP_URL],
        });
        showToast("Shared to feed.");
        return;
      }

      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({
          text: shareText,
          url: APP_URL,
        });
        return;
      }

      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${shareText}\n${APP_URL}`);
        showToast("Result copied. Share it anywhere.");
        return;
      }

      showToast("Sharing is unavailable in this client.");
    } catch {
      showToast("Share failed. Try again.");
    }
  }, [APP_URL, composeCast, currentRate, hasSocialIdentity, lastAction, showToast]);

  const canShare = useMemo(() => {
    if (!lastAction || !hasSocialIdentity) return false;
    const hasNativeShare =
      typeof navigator !== "undefined" &&
      Boolean(navigator.share || navigator.clipboard?.writeText);
    return Boolean(composeCast || hasNativeShare);
  }, [composeCast, hasSocialIdentity, lastAction]);

  const progressWidth =
    rate != null ? Math.max(0, Math.min(100, (rate / maxRate) * 100)) : 0;
  const canPress = connected && cooldownSec === 0;

  return (
    <div className="app">
      <h1 className="title">Beat Powell</h1>
      <p className="subtitle">Lower the Fed rate onchain with Base Account</p>
      <BattleNarrative />

      <WalletPanel
        connected={connected}
        displayName={displayName}
        avatarUrl={avatarUrl}
        address={address}
        isPending={isPending}
        onConnect={connectWallet}
      />

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
          <div className="rate-hint">Rate recovering... (stored: {rate?.toFixed(2)}%)</div>
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
            {!connected ? "Connect first" : cooldownSec > 0 ? formatTime(cooldownSec) : "Ready"}
          </div>
        </div>
      </div>

      <div className="info-box compact">
        <p className="info-line">
          <span className="info-emoji">-</span>
          <span>
            Each hit: <b>-{rateDecrease}%</b>
          </span>
        </p>
        <p className="info-line">
          <span className="info-emoji">+</span>
          <span>
            Powell recovers: <b>+{rateIncrease}%/hour</b>
          </span>
        </p>
      </div>

      <div className="action-row">
        <button
          className={`press-btn ${loading ? "loading" : ""} ${!canPress ? "disabled" : ""}`}
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

        {canShare && (
          <button className="share-btn" type="button" onClick={handleShare}>
            Share Result
          </button>
        )}
      </div>

      {statusMessage && <p className="msg error">{statusMessage}</p>}

      <div className="footer-note">The printer goes BRRR</div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function WalletPanel({
  connected,
  displayName,
  avatarUrl,
  address,
  isPending,
  onConnect,
}) {
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected";

  return (
    <div className="wallet-card">
      <div className="wallet-row">
        <div className="wallet-profile">
          {avatarUrl ? (
            <img src={avatarUrl} alt={displayName} className="wallet-avatar" />
          ) : (
            <div className="wallet-avatar wallet-avatar-fallback">{displayName.slice(0, 1)}</div>
          )}
          <div>
            <div className="wallet-name">{displayName}</div>
            <div className="wallet-address">{shortAddress}</div>
          </div>
        </div>
        <span className={`wallet-status ${connected ? "on" : "off"}`}>
          {connected ? "Ready" : "Disconnected"}
        </span>
      </div>

      {!connected && (
        <button className="connect-btn" onClick={onConnect} disabled={isPending} type="button">
          {isPending ? "Connecting..." : "Connect Base Account"}
        </button>
      )}
    </div>
  );
}

function BattleNarrative() {
  return (
    <section className="battle-note">
      <div className="battle-note-header">LIVE BASE ARENA</div>
      <p className="battle-note-text">
        Human players and agent wallets both push the same onchain rate battle.
        Each confirmed hit is a visible signal on Base.
      </p>
      <div className="battle-note-tags">
        <span className="battle-tag">People</span>
        <span className="battle-tag">Agent Wallets</span>
        <span className="battle-tag">Shared Outcome</span>
      </div>
    </section>
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