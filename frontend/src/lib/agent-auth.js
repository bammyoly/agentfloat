// ---------------------------------------------------------------------------
// Server-side agent wallet authentication.
//
// After the user connects their primary wallet via Reown, this module:
//   1. Requests a challenge from the gateway
//   2. Asks the user to sign it with their primary wallet
//   3. Sends the signature to the gateway
//   4. Receives a session token + agent wallet address
//
// The agent wallet is a server-side EOA that signs x402 payments. The primary
// wallet is only used for authentication — it never signs payments.
// ---------------------------------------------------------------------------

import { setSessionToken, clearSessionToken } from "./session-token.js";

/**
 * Authenticate with the gateway and get/create the agent wallet.
 *
 * @param {string} primaryAddress - the connected wallet address
 * @param {function} signMessageFn - async (message) => signature
 * @returns {{ agentAddress: string, isNew: boolean, sessionToken: string }}
 */
export async function authenticateAgent(primaryAddress, signMessageFn) {
  // 1. Get challenge
  const challengeRes = await fetch(
    `/api/session/challenge?address=${encodeURIComponent(primaryAddress)}`
  );
  const challenge = await challengeRes.json();
  if (!challenge.ok) {
    throw new Error(challenge.error || "failed to get auth challenge");
  }

  // 2. Sign with primary wallet
  const signature = await signMessageFn(challenge.message);

  // 3. Login
  const loginRes = await fetch("/api/session/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: primaryAddress,
      signature,
      message: challenge.message,
    }),
  });
  const login = await loginRes.json();
  if (!login.ok) {
    throw new Error(login.error || "agent wallet authentication failed");
  }

  // 4. Store the session token
  setSessionToken(login.sessionToken);

  return {
    agentAddress: login.agentAddress,
    isNew: login.isNewAgent,
    sessionToken: login.sessionToken,
  };
}

/**
 * Logout: clear the session token and tell the server.
 */
export async function logoutAgent() {
  const token = (await import("./session-token.js")).getSessionToken();
  clearSessionToken();
  if (token) {
    await fetch("/api/session/logout", {
      method: "POST",
      headers: { "X-Session-Token": token },
    }).catch(() => {});
  }
}