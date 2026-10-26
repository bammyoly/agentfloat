// ---------------------------------------------------------------------------
// Faucet security test. Not part of the app — a verification harness.
//
//   node faucet-test.js
//
// Exercises the paths that matter for an endpoint that spends real operator
// funds: a legitimate claim (including first-time agent registration), the
// cooldown, a FORGED claim (sign as A, claim for B), and a REPLAYED signature.
// ---------------------------------------------------------------------------

// server/ is "type": "module", so this harness is ESM too.
import { ethers } from "ethers";

const API = "http://127.0.0.1:4022/api";
const RPC = "https://rpc.test.mezo.org";
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const TREASURY = "0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79";

const j = async (path, opts) => {
  const r = await fetch(API + path, opts);
  let b = null;
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};
const post = (path, body) =>
  j(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const musd = new ethers.Contract(MUSD, ["function balanceOf(address) view returns (uint256)"], p);
  const treasury = new ethers.Contract(TREASURY, ["function isRegistered(address) view returns (bool)"], p);

  // A throwaway wallet standing in for a brand-new Privy user.
  const user = ethers.Wallet.createRandom();
  console.log(`\n  throwaway user wallet: ${user.address}`);
  console.log(`  registered before    : ${await treasury.isRegistered(user.address)}`);
  console.log(`  MUSD before          : ${ethers.formatUnits(await musd.balanceOf(user.address), 18)}\n`);

  // --- 1. legitimate claim ------------------------------------------------
  console.log("== 1. legitimate claim (new user) ==");
  const ch = await j(`/faucet/challenge?address=${user.address}`);
  check("challenge issued", ch.status === 200 && ch.body?.ok === true, JSON.stringify(ch.body));
  const message = ch.body.message;
  const signature = await user.signMessage(message);
  const claim = await post("/faucet/request", { address: user.address, signature, message });
  console.log(`  -> HTTP ${claim.status} ${JSON.stringify(claim.body).slice(0, 220)}`);
  check("claim accepted", claim.status === 200 && claim.body?.ok === true, claim.body?.error);
  check("registered the wallet as an agent", claim.body?.registered === true);
  check("returned a transfer tx", Boolean(claim.body?.txHash));

  // Give the RPC a moment, then verify on chain.
  await new Promise((r) => setTimeout(r, 8000));
  const bal = await musd.balanceOf(user.address);
  console.log(`  on-chain MUSD after  : ${ethers.formatUnits(bal, 18)}`);
  check("10 MUSD actually arrived", ethers.formatUnits(bal, 18) === "10.0", ethers.formatUnits(bal, 18));
  check("isRegistered() true on chain", await treasury.isRegistered(user.address));

  // --- 2. cooldown --------------------------------------------------------
  console.log("\n== 2. immediate re-claim (cooldown) ==");
  const st = await j(`/faucet/status?address=${user.address}`);
  check("status says not eligible", st.body?.eligible === false, JSON.stringify(st.body).slice(0, 160));
  check("reason is cooldown", st.body?.reason === "cooldown", st.body?.reason);
  check("nextClaimAt is ~48h out", Boolean(st.body?.nextClaimAt));
  const ch2 = await j(`/faucet/challenge?address=${user.address}`);
  const sig2 = await user.signMessage(ch2.body.message);
  const again = await post("/faucet/request", { address: user.address, signature: sig2, message: ch2.body.message });
  console.log(`  -> HTTP ${again.status} ${again.body?.error || ""}`);
  check("second claim refused with 429", again.status === 429, `got ${again.status}`);
  const bal2 = await musd.balanceOf(user.address);
  check("balance unchanged (still 10)", ethers.formatUnits(bal2, 18) === "10.0", ethers.formatUnits(bal2, 18));

  // --- 3. forged claim ----------------------------------------------------
  console.log("\n== 3. forged claim (sign as A, request for B) ==");
  const victim = "0xF8F56f404DB1cDb9E03b66F37D916183f4f32686";
  const ch3 = await j(`/faucet/challenge?address=${victim}`);
  const forged = await user.signMessage(ch3.body.message); // wrong key signs it
  const r3 = await post("/faucet/request", { address: victim, signature: forged, message: ch3.body.message });
  console.log(`  -> HTTP ${r3.status} ${r3.body?.error || ""}`);
  check("forged claim refused with 403", r3.status === 403, `got ${r3.status}`);
  check("error names the mismatch", /recovers to/i.test(r3.body?.error || ""), r3.body?.error);

  // --- 4. replay ----------------------------------------------------------
  console.log("\n== 4. replayed signature (nonce already consumed) ==");
  const r4 = await post("/faucet/request", { address: user.address, signature, message });
  console.log(`  -> HTTP ${r4.status} ${r4.body?.error || ""}`);
  check("replay refused", r4.status === 403 || r4.status === 429, `got ${r4.status}`);

  // --- 5. tampered message ------------------------------------------------
  console.log("\n== 5. tampered challenge message ==");
  const ch5 = await j(`/faucet/challenge?address=${user.address}`);
  const sig5 = await user.signMessage(ch5.body.message);
  const tampered = ch5.body.message.replace(user.address, victim);
  const r5 = await post("/faucet/request", { address: victim, signature: sig5, message: tampered });
  console.log(`  -> HTTP ${r5.status} ${r5.body?.error || ""}`);
  check("tampered message refused", r5.status === 403 || r5.status === 429, `got ${r5.status}`);

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  console.log(`   throwaway wallet ${user.address} holds 10 MUSD and is a registered agent.`);
  console.log(`   Retire it with: cd ../contract && AGENT_ADDRESS=${user.address} node scripts/retire-agent.js\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
