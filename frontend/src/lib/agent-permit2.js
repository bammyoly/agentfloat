// frontend/src/lib/agent-permit2.js
import { getSessionToken } from "./session-token.js";

function authHeaders() {
  const token = getSessionToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Session-Token": token } : {}),
  };
}

/**
 * Ask the gateway to MUSD.approve(Permit2) FROM THE AGENT EOA.
 * Primary wallet never signs this — only the server-held agent key can.
 */
export async function approveAgentPermit2(amount /* optional human MUSD string */) {
  const res = await fetch("/api/agent/approve-permit2", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(amount ? { amount: String(amount) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Approve failed (HTTP ${res.status})`);
  }
  return data; // { ok, txHash, allowance, agentAddress }
}

/** Read Permit2 allowance for the session agent (server-side view). */
export async function getAgentPermit2Status() {
  const res = await fetch("/api/agent/permit2-status", {
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Status failed (HTTP ${res.status})`);
  }
  return data; // { ok, agentAddress, allowance, ready }
}


