// server/lib/permit2-agent.js
import { ethers } from "ethers";
import { getAgentPrivateKey } from "./wallet-factory.js";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MUSD =
  process.env.MUSD_ADDRESS || "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const RPC = process.env.MEZO_RPC_URL || "https://rpc.test.mezo.org";
const MAX_UINT = 2n ** 256n - 1n;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

/**
 * @param {import('express').Router} router
 * @param {{ requireSession: Function, log?: Function }} opts
 */
export function mountPermit2AgentRoutes(router, { requireSession, log = console.log }) {
  // POST /api/agent/approve-permit2
  router.post("/api/agent/approve-permit2", requireSession, async (req, res) => {
    try {
      const agentAddress = req.session.agentAddress;
      if (!agentAddress) {
        return res.status(401).json({ ok: false, error: "No agent in session" });
      }

      const pk = await getAgentPrivateKey(agentAddress);
      const provider = new ethers.JsonRpcProvider(RPC, 31611);
      const wallet = new ethers.Wallet(pk, provider);
      const musd = new ethers.Contract(MUSD, ERC20_ABI, wallet);

      const gasBal = await provider.getBalance(agentAddress);
      if (gasBal === 0n) {
        return res.status(400).json({
          ok: false,
          error:
            "Agent has 0 BTC for gas. On Earn, use “Send gas to agent” from your connected wallet first.",
          agentAddress,
        });
      }

      let amount = MAX_UINT;
      if (req.body?.amount) {
        amount = ethers.parseUnits(String(req.body.amount), 18);
      }

      const tx = await musd.approve(PERMIT2, amount);
      await Promise.race([
        tx.wait().catch(() => null),
        new Promise((r) => setTimeout(r, 45_000)),
      ]);

      const allowance = await musd.allowance(agentAddress, PERMIT2);
      log(`  [permit2] ${agentAddress.slice(0, 10)}… approved Permit2 tx=${tx.hash}`);

      return res.json({
        ok: true,
        txHash: tx.hash,
        allowance: allowance.toString(),
        agentAddress,
      });
    } catch (e) {
      log(`  [permit2] approve failed: ${e.shortMessage || e.message}`);
      return res.status(500).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // GET /api/agent/permit2-status
  router.get("/api/agent/permit2-status", requireSession, async (req, res) => {
    try {
      const agentAddress = req.session.agentAddress;
      if (!agentAddress) {
        return res.status(401).json({ ok: false, error: "No agent in session" });
      }
      const provider = new ethers.JsonRpcProvider(RPC, 31611);
      const musd = new ethers.Contract(MUSD, ERC20_ABI, provider);
      const allowance = await musd.allowance(agentAddress, PERMIT2);
      return res.json({
        ok: true,
        agentAddress,
        allowance: allowance.toString(),
        ready: allowance > 0n,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}