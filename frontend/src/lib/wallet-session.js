import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider } from "ethers";

import { MEZO_TESTNET_ID, describeChainError, ensureChain, parseChainId, sameChainId } from "./evm-network.js";
import { TREASURY_ADDRESS, IS_DEPLOYED } from "../contracts/index.js";
import { authenticateAgent, logoutAgent } from "./agent-auth.js";
import { setSessionToken, clearSessionToken } from "./session-token.js";

/* ── fetch with hard timeout ── */
function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    fetch(url, options)
      .then((res) => { clearTimeout(timer); resolve(res); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

export function makeWalletShim(address, getEip1193, kind) {
  return {
    address,
    walletClientType: kind,
    getEthereumProvider: async () => getEip1193(),
  };
}

export function rawEip1193(ethersProvider) {
  if (ethersProvider && typeof ethersProvider.provider?.request === "function") return ethersProvider.provider;
  if (ethersProvider && typeof ethersProvider.request === "function") return ethersProvider;
  if (typeof window !== "undefined" && window.ethereum) return window.ethereum;
  return null;
}

export function toBrowserProvider(raw) {
  if (!raw) return null;
  if (raw instanceof BrowserProvider) return raw;
  try { return new BrowserProvider(raw, "any"); } catch { return null; }
}

export function useWalletSession({ kind, address, raw, openConnect, disconnect }) {
  const [authenticating, setAuthenticating] = useState(false);
  const [agentAuthenticating, setAgentAuthenticating] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [chainOk, setChainOk] = useState(null);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [operatorSigner, setOperatorSigner] = useState(null);

  // Agent wallet state (server-side)
  const [agentAddress, setAgentAddress] = useState(null);
  const agentAuthRef = useRef(false);
  const loginSuccessRef = useRef(false);   // ← belt-and-suspenders: prevents loop after success
  const [forceSignedOut, setForceSignedOut] = useState(false);
  const loginAbortRef = useRef(null);

  // --- network ---------------------------------------------------------------
  const fixNetwork = useCallback(async () => {
    if (!raw) return { wasOnChain: false, switched: false, added: false };
    setNetworkBusy(true);
    try {
      const result = await ensureChain(raw);
      setChainId(result.chainId);
      setChainOk(true);
      setAuthError(null);
      return result;
    } catch (err) {
      setChainOk(false);
      setAuthError({
        code: `network_${String(err?.code ?? "error")}`,
        hint: describeChainError(err),
        at: Date.now(),
      });
      throw err;
    } finally {
      setNetworkBusy(false);
    }
  }, [raw]);

  useEffect(() => {
    if (!raw || !address) { setChainId(null); setChainOk(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const current = await raw.request({ method: "eth_chainId" });
        if (cancelled) return;
        setChainId(parseChainId(current));
        if (sameChainId(current, MEZO_TESTNET_ID)) { setChainOk(true); return; }
        await fixNetwork();
      } catch {
        if (!cancelled) setChainOk(null);
      }
    })();
    return () => { cancelled = true; };
  }, [raw, address, fixNetwork]);

  useEffect(() => {
    if (!raw?.on) return;
    const onChain = (value) => {
      setChainId(parseChainId(value));
      setChainOk(sameChainId(value, MEZO_TESTNET_ID));
    };
    raw.on("chainChanged", onChain);
    return () => { raw.removeListener?.("chainChanged", onChain); };
  }, [raw]);

  // --- agent wallet auth (server-side) ---------------------------------------
  useEffect(() => {
    if (!address || forceSignedOut || agentAddress || loginSuccessRef.current) return;

    // cancel any previous in-flight login
    if (loginAbortRef.current) loginAbortRef.current.abort();
    const controller = new AbortController();
    loginAbortRef.current = controller;

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;

    (async () => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (controller.signal.aborted || loginSuccessRef.current) return;

        try {
          setAuthenticating(true);
          setAuthError(
            attempt > 1
              ? { code: "agent_login", hint: `Retrying agent login… (${attempt}/${MAX_RETRIES})`, at: Date.now() }
              : null
          );

          /* ① challenge */
          const chalRes = await fetchWithTimeout(
            `/api/session/challenge?address=${encodeURIComponent(address)}`,
            { signal: controller.signal },
            10000
          );
          if (!chalRes.ok) throw new Error(`Challenge ${chalRes.status}`);
          const chal = await chalRes.json();
          if (typeof chal.message !== "string" || !chal.message || !chal.nonce) {
            throw new Error(`Bad challenge response: ${JSON.stringify(chal)}`);
          }
          if (controller.signal.aborted) return;

          /* ② sign the message text */
          const signature = await raw.request({
            method: "personal_sign",
            params: [chal.message, address],
          });
          if (controller.signal.aborted) return;

          /* ③ login */
          const loginRes = await fetchWithTimeout(
            "/api/session/login",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                address,
                signature,
                message: chal.message,
                nonce: chal.nonce,
              }),
              signal: controller.signal,
            },
            15000
          );

          if (!loginRes.ok) {
            const body = await loginRes.json().catch(() => ({}));
            throw new Error(body.error || `Login ${loginRes.status}`);
          }
          const data = await loginRes.json();
          if (controller.signal.aborted) return;

          /* ✅ success — mark BEFORE any state updates so the ref guard
               catches re-entrant effect runs immediately */
          loginSuccessRef.current = true;
          agentAuthRef.current = true;

          setSessionToken(data.sessionToken);          // ← FIXED: was storeSessionToken
          setAgentAddress(data.agentAddress);
          setAuthenticating(false);
          setAuthError(null);
          return;

        } catch (err) {
          if (controller.signal.aborted || loginSuccessRef.current) return;
          console.warn(
            `Agent login attempt ${attempt}/${MAX_RETRIES} failed:`,
            err.message
          );

          if (attempt >= MAX_RETRIES) {
            setAuthenticating(false);
            setAuthError({
              code: "agent_login_failed",
              hint: `Could not load agent wallet after ${MAX_RETRIES} attempts. Refresh to retry.`,
              at: Date.now(),
            });
            return;
          }

          const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, attempt - 1),
            16000
          );
          setAuthError({
            code: "agent_login",
            hint: `Agent login failed — retrying in ${delay / 1000}s… (${attempt}/${MAX_RETRIES})`,
            at: Date.now(),
          });

          // interruptible sleep
          await new Promise((resolve) => {
            const t = setTimeout(resolve, delay);
            controller.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, forceSignedOut]);

  // --- operator detection ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (!address || !IS_DEPLOYED || !TREASURY_ADDRESS) {
        if (!cancelled) setOperatorSigner(null);
        return;
      }
      try {
        const bp = toBrowserProvider(raw);
        const signer = bp ? await bp.getSigner() : null;
        const addr = signer ? await signer.getAddress() : null;
        const { treasuryRead } = await import("./chain.js");
        const t = treasuryRead();
        const owner = t ? await t.owner() : null;
        if (!cancelled) setOperatorSigner(owner && addr && owner.toLowerCase() === addr.toLowerCase() ? signer : null);
      } catch {
        if (!cancelled) setOperatorSigner(null);
      }
    }
    resolve();
    return () => { cancelled = true; };
  }, [address, raw]);

  const signMessage = useCallback(async (message) => {
    if (!raw || !address) throw new Error("No wallet connected — sign in first.");
    return raw.request({ method: "personal_sign", params: [message, address] });
  }, [raw, address]);

  const login = useCallback(async () => {
    setForceSignedOut(false);
    setAuthError(null);
    setAuthenticating(true);
    try {
      await openConnect();
    } catch (err) {
      setAuthError({
        code: String(err?.code ?? err?.name ?? "connect_failed"),
        hint:
          err?.code === 4001
            ? "The connection request was rejected in the wallet. Click Sign in again when ready."
            : `The wallet could not connect: ${String(err?.message || err).slice(0, 200)}`,
        at: Date.now(),
      });
    } finally {
      setAuthenticating(false);
    }
  }, [openConnect]);

  const logout = useCallback(async () => {
    setForceSignedOut(true);
    setOperatorSigner(null);
    setAgentAddress(null);
    setAuthError(null);
    agentAuthRef.current = false;
    loginSuccessRef.current = false;       // ← reset so next login can run
    clearSessionToken();

    try { await logoutAgent(); } catch { /* server may be unreachable */ }
  }, []);

  // The primary wallet shim
  const primaryWallet = useMemo(
    () => (address ? makeWalletShim(address, () => raw, kind) : null),
    [address, raw, kind]
  );

  // The agent wallet shim
  const agentWallet = useMemo(
    () => (agentAddress ? { address: agentAddress, walletClientType: "server-agent" } : null),
    [agentAddress]
  );

  const value = useMemo(() => ({
    configured: true,
    ready: true,
    authenticating: authenticating || agentAuthenticating,
    user: (address && !forceSignedOut) ? { id: `eip155:${address}`, connectedWallet: true } : null,
    primaryAddress: address || null,
    primaryWallet,
    agentWallet,
    agentAddress: agentAddress || null,
    canSignX402: Boolean(agentAddress) && chainOk === true,
    isOperator: Boolean(operatorSigner),
    operatorSigner,
    externalWallets: primaryWallet ? [primaryWallet] : [],
    login,
    logout,
    signMessage,
    getAccessToken: async () => null,
    authError,
    clearAuthError: () => setAuthError(null),
    chainId,
    chainOk,
    networkBusy,
    fixNetwork,
    providerKind: kind,
  }), [authenticating, agentAuthenticating, address, agentAddress, primaryWallet, agentWallet,
       chainOk, chainId, networkBusy, operatorSigner, login, logout, signMessage, authError, fixNetwork, kind, forceSignedOut]);

  return value;
}

