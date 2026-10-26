// ---------------------------------------------------------------------------
// Browser-side x402 payer.
//
// The gateway signs with a viem LocalAccount built from a private key. A Privy
// user's key never exists in this process — it lives in Privy's TEE — so instead
// we build a viem wallet client over the EIP-1193 provider Privy exposes and
// hand its account to the x402 client. Signing then routes through Privy, which
// is the whole point: neither the bundle nor our server ever holds the key.
//
// The scheme registration mirrors the gateway exactly (exact scheme, CAIP-2
// network, RPC url) so both paths produce the same permit2 authorization.
//
// WHY THE IMPORTS ARE DYNAMIC
//   @x402/* pulls a heavy Solana transitive tree. Importing it statically put it
//   in the main bundle and made `vite build` run the Node heap out of memory.
//   These functions are only reached when a signed-in user pays from their own
//   wallet, so the SDK is loaded on demand and code-split into its own chunk.
//
// NOTE ON TESTING: this path needs a real VITE_PRIVY_APP_ID and a logged-in user,
// so it cannot be exercised without one. The gateway path (server-side signing)
// is fully verified on testnet; treat this one as unverified until you sign in.
// ---------------------------------------------------------------------------

import { createWalletClient, custom } from "viem";
import { mezoTestnet, CHAIN_JSON } from "./mezo.js";

/**
 * The shape the x402 EVM scheme actually asks for: `{ address, signTypedData }`
 * (its own words — "Base flow only requires `address` + `signTypedData`").
 *
 * WHY THIS FUNCTION EXISTS
 *   Passing an ADDRESS to createWalletClient gives a viem JSON-RPC account:
 *   `{ address, type: "json-rpc" }` — data only, no methods, because signing is
 *   delegated to the transport. Handing that to registerExactEvmScheme() fails at
 *   signing time with
 *
 *       signer.signTypedData is not a function
 *
 *   which is what a real user saw on their first relayed payment: the wallet was
 *   connected, the quote was right, and no prompt ever appeared. The error names a
 *   missing function rather than a cause, so it reads like an SDK bug.
 *
 *   The WALLET CLIENT has the method and routes it through the transport — i.e.
 *   through Privy's provider into the TEE, which is the whole point. So expose it
 *   under the shape the scheme wants. A LocalAccount built from a private key (the
 *   gateway's demo agent) already has these methods, which is why the server path
 *   never hit this.
 *
 * `account` is passed explicitly on every call: for a JSON-RPC account viem needs
 * to know which address to ask the provider to sign for.
 *
 * Deliberately NOT exposed: `readContract` / `getTransactionCount`. The scheme uses
 * those only for its optional EIP-2612 allowance-sponsoring enrichment, and adding
 * a chain read to the signing path would mean a new failure mode between the user
 * and their prompt.
 *
 * WHERE THE PERMIT2 ALLOWANCE COMES FROM
 *   Not from this file, and not from a repo script. `contract/scripts/grant-permit2.js`
 *   exists but it needs a checkout and the wallet's private key — no ordinary user has
 *   either, so pointing them at it is a dead end (one was hit in practice: a wallet
 *   refused with `permit2_not_approved` and the only advice offered was that script).
 *   The allowance is granted in-product: `components/ApprovalModal.jsx` signs
 *   `MUSD.approve(Permit2, amount)` from the user's own provider, with a choice
 *   between this one payment and all future payments, and `server/gas.js` supplies the
 *   native BTC the approval needs. This signing path stays deliberately unaware of
 *   all that — by the time it runs, the allowance is already on chain.
 */
function schemeSigner(walletClient, address) {
  return {
    address,
    type: walletClient.account?.type || "json-rpc",
    signTypedData: (args) => walletClient.signTypedData({ ...args, account: walletClient.account }),
    signMessage: (args) => walletClient.signMessage({ ...args, account: walletClient.account }),
  };
}

/**
 * Build a payer for a signed-in user's wallet.
 * @param wallet an EOA wallet object exposing `address` and
 *   `getEthereumProvider()` — a Privy embedded wallet, or the shim that
 *   lib/wallet-session.js builds around an injected / Reown wallet. Signing
 *   routes through whichever the user connected; none of them ever hand us a key.
 */
export async function makeBrowserPayer(wallet) {
  if (!wallet) throw new Error("No wallet supplied.");

  const [{ x402Client, wrapFetchWithPayment }, { registerExactEvmScheme }] = await Promise.all([
    import("@x402/fetch"),
    import("@x402/evm/exact/client"),
  ]);

  const provider = await wallet.getEthereumProvider();

  // Passing the address (not a LocalAccount) makes viem route signTypedData
  // through the transport, i.e. through Privy, which prompts the TEE to sign.
  const walletClient = createWalletClient({
    account: wallet.address,
    chain: mezoTestnet,
    transport: custom(provider),
  });

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: schemeSigner(walletClient, wallet.address),
    networks: [CHAIN_JSON.caip2],
    schemeOptions: { rpcUrl: CHAIN_JSON.rpcUrl },
  });

  return {
    address: wallet.address,
    walletClient,
    fetchWithPay: wrapFetchWithPayment(fetch, client),
  };
}

/**
 * Decode a seller's 402 without paying, so the UI can show the real price and
 * terms before the user signs anything. Mirrors the gateway's probe.
 */
export async function probeUnpaid(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "agentfloat-browser/1.0" },
  });
  const raw =
    res.headers.get("payment-required") ||
    res.headers.get("PAYMENT-REQUIRED") ||
    res.headers.get("x-payment-required");
  if (!raw) return { requiresPayment: res.status === 402, status: res.status, offer: null };

  let decoded = null;
  try {
    decoded = JSON.parse(atob(raw));
  } catch {
    return { requiresPayment: true, status: res.status, offer: null, parseError: true };
  }

  // v1 carries `paymentRequirements` (an array); v2 carries `accepts`. Reading
  // only the v1 names is how a correct 402 comes back as "no offer found".
  const r = decoded?.requirements?.[0] || decoded?.paymentRequirements?.[0] || decoded?.accepts?.[0] || null;
  return {
    requiresPayment: true,
    status: res.status,
    description: decoded?.resource?.description || decoded?.description || null,
    offer: r
      ? {
          scheme: r.scheme,
          network: r.network,
          asset: r.asset,
          amount: String(r.amount ?? r.maxAmountRequired ?? ""),
          payTo: r.payTo,
          transferMethod: r.extra?.assetTransferMethod || r.assetTransferMethod || r.transferMethod || null,
          eip712Name: r.extra?.name || null,
          maxTimeoutSeconds: r.maxTimeoutSeconds ?? null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Relay signing — the fix for "Failed to fetch".
//
// A browser fetch is subject to CORS, and most x402 sellers send no
// Access-Control-Allow-Origin (Mezo's hosted demo verified not to). So paying
// with your OWN wallet used to fail while the gateway's demo agent worked, which
// left exactly one usable path — the one that needed the operator's key.
//
// The relay splits a payment in half: the gateway does the FETCHING (Node has no
// CORS), this module does the SIGNING, and the two halves meet in one opaque
// header. The key never leaves Privy's TEE, and the gateway cannot forge the
// header because it cannot sign.
//
//   1. POST /api/relay/probe    gateway fetches unpaid, relays the 402 headers
//   2. signProbe()              x402HTTPClient builds the payload and the wallet
//                               signs it — this is where Privy prompts
//   3. POST /api/relay/execute  gateway re-fetches with that header attached
//
// Uses x402HTTPClient rather than wrapFetchWithPayment precisely because the
// wrapped fetch both signs AND fetches, and here those must happen in different
// processes.
// ---------------------------------------------------------------------------

/**
 * Build a signer for the relay path.
 * @param wallet an EOA wallet object exposing `address` and `getEthereumProvider()`
 */
export async function makeRelaySigner(wallet) {
  if (!wallet) throw new Error("No wallet supplied.");

  const [{ x402Client, x402HTTPClient }, { registerExactEvmScheme }] = await Promise.all([
    import("@x402/fetch"),
    import("@x402/evm/exact/client"),
  ]);

  const provider = await wallet.getEthereumProvider();
  const walletClient = createWalletClient({
    account: wallet.address,
    chain: mezoTestnet,
    transport: custom(provider),
  });

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: schemeSigner(walletClient, wallet.address),
    networks: [CHAIN_JSON.caip2],
    schemeOptions: { rpcUrl: CHAIN_JSON.rpcUrl },
  });
  const http = new x402HTTPClient(client);

  const headerGetter = (headers = {}) => (name) => headers[String(name).toLowerCase()] ?? null;

  return {
    address: wallet.address,

    /**
     * Sign a relayed 402 into an X-PAYMENT header.
     * @param probe the /api/relay/probe response: `{ headers, body }` verbatim
     * @returns {{ payment: string, paymentHeaders: object|null, payload: object }}
     */
    async signProbe(probe) {
      const headers = probe?.headers || {};
      let body = probe?.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { /* keep as text */ }
      }

      const paymentRequired = http.getPaymentRequiredResponse(headerGetter(headers), body);
      if (!paymentRequired) {
        throw new Error("The relayed 402 carried no payment requirements the x402 client could read.");
      }

      // The wallet signs HERE, and only here. Everything before was reading.
      const payload = await http.createPaymentPayload(paymentRequired);
      const encoded = http.encodePaymentSignatureHeader(payload);
      // The header NAME is part of the protocol: v1 sends X-PAYMENT, v2 sends
      // PAYMENT-SIGNATURE, and a seller only reads its own. So the map goes to the
      // relay intact — sending the value under a guessed name is how a payment
      // gets silently ignored (the seller answers 402 again and it looks like a
      // settlement failure). `payment` stays for anything that wants the value.
      const paymentHeaders = encoded && typeof encoded === "object" ? encoded : null;
      const payment = typeof encoded === "string" ? encoded : Object.values(encoded || {})[0];
      if (!payment) throw new Error("The x402 client produced no payment header.");
      return { payment, paymentHeaders, payload };
    },

    /** Read a relayed response the same way a direct fetch would be read. */
    parseResult({ status, headers = {}, body } = {}) {
      let parsed = body;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { /* keep as text */ }
      }
      try {
        return http.parsePaymentResult({ status, getHeader: headerGetter(headers), body: parsed });
      } catch {
        return null;
      }
    },
  };
}
