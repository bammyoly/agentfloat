// ---------------------------------------------------------------------------
// Operate — your budget first, protocol controls second.
//
// THE MISREADING THIS PAGE USED TO CAUSE
//   It was entirely owner-only, so a user who had just created an agent wallet
//   with their email found every control disabled and concluded the product was
//   not for them. But "how much may my agent spend per call, and per day" is
//   precisely the decision that belongs to the person who owns the wallet. So
//   that is now zone one, available to every signed-in user, and the owner-only
//   machinery is zone two behind a divider that says whose it is.
//
// WHY A USER'S WALLET CANNOT SIMPLY CALL THE CONTRACT
//   setAgentLimits() is onlyOwner, and that is deliberate rather than an
//   oversight. An agent that can raise its own ceiling is not budget-controlled:
//   a prompt-injected or buggy agent would lift its own limit and the "hard cap"
//   would become a suggestion. The authority stays with the funder.
//
// SO THE USER AUTHORIZES, THE PROTOCOL APPLIES
//   1. the gateway issues a nonce AND the exact message, with the requested
//      values already inside it;
//   2. the user signs it with their own agent wallet (Privy prompt — the key
//      never leaves the TEE);
//   3. the gateway recovers the signer, refuses on mismatch, and only then calls
//      setAgentLimits() with the owner key — inside a published ceiling, rate
//      limited, because every change costs the operator real gas.
//   Same shape as a bank letting you set your own card limits up to a product
//   maximum: you choose the number, the institution enforces the envelope, and
//   neither can forge the other. The values applied are the values that were
//   signed — nothing in the second request is trusted.
//
/**
 * The explanation for a locked gateway, used whether the lock was predicted from
 * /api/health or reported by a 403. Written once so the two paths cannot drift
 * into two different stories about the same button.
 */
const ADMIN_LOCKED_DETAIL =
  "This gateway is deployed with GATEWAY_ADMIN_TOKEN set, so owner-only commands need it. " +
  "That token is a deployment secret and deliberately not something this browser bundle " +
  "carries: any VITE_-prefixed value is inlined into the shipped JavaScript, so publishing " +
  "it here would hand the pause switch to every visitor. Pause on chain instead — the " +
  "treasury's pause() needs the owner wallet and is the authority that survives a restart.";

// Two pause layers in zone two, deliberately:
//   gateway pause  instant, stops signing, needs no tx and no gas
//   on-chain pause authoritative, needs an owner tx
// `emergencyStop` does the on-chain pause AND sweeps the agent's float back.
// ---------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import { Gauge, Landmark, Lock, Pause, Play } from "lucide-react";
import { ethers } from "ethers";
import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { useAgentStatus } from "../lib/agent-status.jsx";
import {
  AddressLink, Badge, Button, Card, Dot, Field, Note, PageHeader, Stat, TxLink,
} from "../components/ui.jsx";
import { TREASURY_ADDRESS, TREASURY_ABI, MUSD_ADDRESS, ERC20_ABI, CHAIN, TREASURY_OWNER } from "../contracts/index.js";
import { sendTx, fmtMusd, short } from "../lib/chain.js";
import {
  pauseGateway, unpauseGateway, limitsConfig, limitsChallenge, limitsApply, limitsHistory,
  ADMIN_TOKEN_CONFIGURED, isAdminLocked,
} from "../lib/gateway.js";

export default function Operate() {
  const { health, refresh } = useAppData();
  const session = useSession();

  return (
    <div className="animate-fade space-y-8 pb-10">
      <PageHeader
        icon={Gauge}
        eyebrow="your agent"
        title="Budget & controls"
        sub="Set what your own agent may spend, then — if you are the treasury owner — the protocol-wide controls below."
      />

      <YourBudget session={session} onChanged={refresh} />

      <div className="relative flex items-center py-2">
        <div className="flex-grow border-t border-line-soft" />
        <span className="mx-4 flex-shrink-0 rounded-full border border-line-soft bg-ink-soft px-3 py-1 text-[11.5px] font-semibold uppercase tracking-widest text-dim">
          Protocol controls · treasury owner only
        </span>
        <div className="flex-grow border-t border-line-soft" />
      </div>

      <OwnerControls session={session} health={health} refresh={refresh} />
    </div>
  );
}

// ===========================================================================
// Zone one — every signed-in user
// ===========================================================================

function YourBudget({ session, onChanged }) {
  // Remounting the status reader forces an immediate re-read after a change,
  // instead of waiting for the next 10s poll.
  const [reloadKey, setReloadKey] = useState(0);

  if (!session.configured || !session.user) {
    return (
      <Card title="Your agent budget" aside={<Badge tone="neutral">sign-in required</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Sign in with Google or email and Privy creates your agent wallet. Its spending limits — how much a single
          payment may take, and how much may go out in a day — are yours to set here.
        </p>
        {session.configured && (
          <div className="mt-4">
            <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
              {session.authenticating ? "Opening…" : "Sign in"}
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return <BudgetCard key={reloadKey} session={session} onChanged={() => { setReloadKey((k) => k + 1); onChanged?.(); }} />;
}

function BudgetCard({ session, onChanged }) {
  const address = session.agentAddress;
  const mine = useAgentStatus(address);

  const [ceilings, setCeilings] = useState(null);
  const [available, setAvailable] = useState(null);
  const [perCall, setPerCall] = useState("");
  const [daily, setDaily] = useState("");
  const [busy, setBusy] = useState(null);
  const [stage, setStage] = useState(null);
  const [msg, setMsg] = useState(null);
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [history, setHistory] = useState([]);

  // Seed the inputs from the chain, not from defaults: the point of the page is
  // that these are YOUR current caps. ONCE per mount, though — the status polls
  // every 10s, and re-seeding an empty field would fight whoever is typing in it.
  // A successful change remounts this card (key={reloadKey}), so the new caps
  // still get read back.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !mine.status) return;
    seeded.current = true;
    setPerCall(Number(ethers.formatUnits(mine.status.perCallMax, 18)).toString());
    setDaily(Number(ethers.formatUnits(mine.status.dailyCap, 18)).toString());
  }, [mine.status]);

  useEffect(() => {
    limitsConfig().then((r) => {
      if (r.ok) { setCeilings(r.ceilings); setAvailable(r.available); }
      else setAvailable(false);
    });
  }, []);

  useEffect(() => {
    if (!address) return;
    limitsHistory(address).then((r) => { if (r.ok) setHistory(r.changes || []); });
  }, [address]);

  const maxPerCall = Number(ceilings?.perCallMaxMusd || 5);
  const maxDaily = Number(ceilings?.dailyCapMusd || 50);
  const minPerCall = Number(ceilings?.minPerCallMusd || 0.001);

  const currentPerCall = mine.status ? Number(ethers.formatUnits(mine.status.perCallMax, 18)) : null;
  const currentDaily = mine.status ? Number(ethers.formatUnits(mine.status.dailyCap, 18)) : null;
  const active = mine.status?.active;

  const changed =
    currentPerCall !== null &&
    (Number(perCall) !== currentPerCall || Number(daily) !== currentDaily);

  // Same rules the gateway enforces, checked here first: a refusal explained
  // before the wallet prompt is worth more than a 400 after it.
  const invalid =
    !perCall || !daily ||
    Number(perCall) < minPerCall || Number(perCall) > maxPerCall ||
    Number(daily) < Number(perCall) || Number(daily) > maxDaily;

  /** challenge → sign in the wallet → gateway applies with the owner key. */
  async function apply(action, values = {}) {
    setBusy(action); setMsg(null); setStage("asking the gateway for a challenge…");
    try {
      const ch = await limitsChallenge({ address, action, ...values });
      if (!ch.ok) throw new Error(ch.error || "the gateway refused to issue a challenge");
      if (ch.hint) throw new Error(ch.hint);

      setStage("waiting for your signature — check the wallet prompt…");
      const signature = await session.signMessage(ch.message);

      setStage("applying on chain with the owner key…");
      const r = await limitsApply({ nonce: ch.nonce, signature });
      if (!r.ok) throw new Error(r.error || "the gateway refused the change");

      setMsg({
        ok: true,
        label: action === "limits" ? "Budget updated" : action === "freeze" ? "Agent frozen" : "Agent re-enabled",
        hash: r.txHash,
        confirmed: r.confirmed,
        detail: action === "limits"
          ? `per-call ${r.perCallMaxMusd} MUSD · daily ${r.dailyCapMusd} MUSD`
          : null,
      });
      limitsHistory(address).then((h) => { if (h.ok) setHistory(h.changes || []); });
      onChanged?.();
    } catch (e) {
      const text = String(e?.shortMessage || e?.message || e);
      setMsg({
        ok: false,
        label: action === "limits" ? "Budget change" : action,
        error: /user (rejected|denied)|4001/i.test(text)
          ? "You declined the signature, so nothing was changed. Ask again when ready."
          : text,
      });
    } finally {
      setBusy(null); setStage(null); setConfirmFreeze(false);
    }
  }

  if (!address) {
    return (
      <Card title="Your agent budget" aside={<Badge tone="warn"><Dot tone="warn" pulse /> creating wallet</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Privy is provisioning your agent wallet. Your budget controls appear the moment it exists.
        </p>
      </Card>
    );
  }

  if (mine.registered === false) {
    return (
      <Card title="Your agent budget" aside={<Badge tone="warn">unfunded</Badge>}>
        <Note tone="warn">
          Your wallet exists but is not registered in the treasury yet, so there are no caps to change. Claim from the
          faucet — it registers the wallet with a 5 MUSD per-call max and a 50 MUSD daily cap, and you can reshape both
          from this page afterwards.
        </Note>
      </Card>
    );
  }

  return (
    <Card
      title="Your agent budget"
      aside={
        active === false
          ? <Badge tone="bad"><Dot tone="bad" /> frozen</Badge>
          : mine.status
            ? <Badge tone="ok"><Dot tone="ok" /> enforced on chain</Badge>
            : <Badge tone="warn"><Dot tone="warn" pulse /> reading chain</Badge>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="rounded border border-line-soft bg-ink-dim px-2.5 py-1 font-mono text-[13.5px] text-muted">
          <AddressLink address={address} chars={8} />
        </div>
        <span className="text-[12.5px] text-dim">
          {session.agentWallet?.walletClientType === "privy" ? "your embedded EOA" : "your connected wallet"}
        </span>
      </div>

      {/* what the chain says right now */}
      <div className="mt-5 grid grid-cols-2 gap-4 rounded-xl border border-line-soft bg-ink-dim/50 p-4 sm:grid-cols-4">
        <Stat label="Per-call max" value={currentPerCall === null ? "…" : currentPerCall} unit="MUSD" />
        <Stat label="Daily cap" value={currentDaily === null ? "…" : currentDaily} unit="MUSD" hint="resets 00:00 UTC" />
        <Stat label="Funding left today" value={mine.status ? fmtMusd(mine.status.remainingToday, 2) : "…"} unit="MUSD"
              hint="float the treasury may still release today — not a spend budget" />
        <Stat label="Float" value={mine.status ? fmtMusd(mine.status.walletBalance, 4) : "…"} unit="MUSD" />
      </div>

      {/* the change itself */}
      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <div>
          <Field
            label={`Per-call max (MUSD) — ceiling ${maxPerCall}`}
            hint="The most any single payment can take. Below a seller's price, the treasury refuses it before anything is signed."
          >
            <input
              className="input"
              value={perCall}
              inputMode="decimal"
              onChange={(e) => setPerCall(e.target.value)}
              disabled={busy !== null}
            />
            <input
              type="range"
              className="mt-2 w-full accent-btc"
              min={minPerCall}
              max={maxPerCall}
              step={0.1}
              value={Number(perCall) || minPerCall}
              onChange={(e) => setPerCall(e.target.value)}
              disabled={busy !== null}
            />
          </Field>
        </div>
        <div>
          <Field
            label={`Daily cap (MUSD) — ceiling ${maxDaily}`}
            hint="Everything that can leave this wallet in one UTC day, across all sellers."
          >
            <input
              className="input"
              value={daily}
              inputMode="decimal"
              onChange={(e) => setDaily(e.target.value)}
              disabled={busy !== null}
            />
            <input
              type="range"
              className="mt-2 w-full accent-btc"
              min={minPerCall}
              max={maxDaily}
              step={1}
              value={Number(daily) || minPerCall}
              onChange={(e) => setDaily(e.target.value)}
              disabled={busy !== null}
            />
          </Field>
        </div>
      </div>

      {invalid && (
        <Note tone="warn" className="mt-4">
          Per-call max must be between {minPerCall} and {maxPerCall} MUSD, the daily cap between the per-call max and{" "}
          {maxDaily} MUSD. The gateway refuses anything outside that envelope, and so does the contract.
        </Note>
      )}

      {available === false && (
        <Note tone="warn" className="mt-4">
          Self-service budget changes are unavailable: this gateway has no treasury-owner key
          (<span className="code">GATEWAY_SIGNER_PRIVATE_KEY</span> in <span className="code">server/.env</span>).
          Nothing is faked here — set that key and restart the gateway, or ask the operator to change your caps from
          the protocol controls below.
        </Note>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Button
          variant="primary"
          onClick={() => apply("limits", { perCallMax: perCall, dailyCap: daily })}
          disabled={busy !== null || available === false || !changed || invalid}
          title={
            invalid ? "Those values are outside the allowed range"
            : !changed ? "Nothing to change — these are already your on-chain caps"
            : "Sign to authorize; the gateway applies it on chain"
          }
        >
          {busy === "limits" ? stage || "working…" : "Apply change"}
        </Button>
        {changed && (
          <span className="text-[12.5px] text-dim">
            {currentPerCall !== null && <>per-call {currentPerCall} → <b className="text-text">{Number(perCall) || 0}</b> · </>}
            {currentDaily !== null && <>daily {currentDaily} → <b className="text-text">{Number(daily) || 0}</b></>}
          </span>
        )}
        {!changed && mine.status && (
          <span className="text-[12.5px] text-dim">matches your on-chain caps</span>
        )}
      </div>

      {/* freeze: the user's own kill switch */}
      <div className="mt-5 border-t border-line-soft pt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          {active === false ? (
            <Button onClick={() => apply("unfreeze")} disabled={busy !== null || available === false}>
              {busy === "unfreeze" ? stage || "working…" : "Unfreeze my agent"}
            </Button>
          ) : confirmFreeze ? (
            <Button variant="danger" onClick={() => apply("freeze")} disabled={busy !== null || available === false}>
              {busy === "freeze" ? stage || "working…" : "Confirm freeze"}
            </Button>
          ) : (
            <Button variant="danger" onClick={() => setConfirmFreeze(true)} disabled={busy !== null || available === false}>
              Freeze my agent
            </Button>
          )}
          <span className="text-[12.5px] leading-relaxed text-dim">
            {active === false
              ? "Frozen: the treasury refuses this agent's payments until you unfreeze it."
              : "Your own kill switch — setAgentActive(false) on chain. Float stays in the wallet; nothing can be spent."}
          </span>
          {confirmFreeze && active !== false && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmFreeze(false)}>cancel</Button>
          )}
        </div>
      </div>

      <Note className="mt-5">
        <b className="text-text">Why you sign instead of sending a transaction.</b>{" "}
        <span className="code">setAgentLimits</span> is <span className="code">onlyOwner</span> on purpose: an agent
        that could raise its own ceiling would not be budget-controlled, and a prompt-injected agent would simply lift
        its own limit. So you authorize a specific change with a signature from this wallet, and the gateway applies it
        with the owner key — never above {maxPerCall} MUSD per call or {maxDaily} MUSD a day, and never a value you did
        not sign.
      </Note>

      {msg && (
        <Note tone={msg.ok ? "ok" : "bad"} className="mt-4">
          {msg.ok ? (
            <>
              <b>{msg.label}</b>{msg.detail && <> — {msg.detail}</>}.
              {msg.hash && <> Tx: <TxLink hash={msg.hash} /></>}
              {msg.confirmed === false && (
                <span className="text-dim"> · broadcast, confirmation not observed within 25s — the Mezo testnet RPC
                often reports receipts late, so trust the explorer link.</span>
              )}
            </>
          ) : (
            <><b>{msg.label} failed.</b> {msg.error}</>
          )}
        </Note>
      )}

      {history.length > 0 && (
        <div className="mt-5 border-t border-line-soft pt-4">
          <div className="mb-2 text-[12.5px] uppercase tracking-[0.14em] text-dim">your changes</div>
          <ul className="space-y-1.5">
            {history.slice(0, 5).map((h) => (
              <li key={h.txHash || h.at} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-dim">
                <span className="tnum">{new Date(h.at).toLocaleString()}</span>
                <Badge tone={h.action === "limits" ? "info" : h.action === "freeze" ? "bad" : "ok"}>
                  {h.action === "limits" ? `per-call ${h.perCallMaxMusd} · daily ${h.dailyCapMusd}` : h.action}
                </Badge>
                {h.txHash && <TxLink hash={h.txHash} chars={5} />}
                <span>self-service · signed by you</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ===========================================================================
// Zone two — the treasury owner
// ===========================================================================

function OwnerControls({ session, health, refresh }) {
  const { operator, connectLegacy, busy: connecting } = useAppData();

  const [target, setTarget] = useState("gateway");
  const [customAgent, setCustomAgent] = useState("");
  const [amount, setAmount] = useState("2");
  const [perCall, setPerCall] = useState("2");
  const [daily, setDaily] = useState("20");
  const [depositAmt, setDepositAmt] = useState("50");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const chainPaused = health?.treasury?.paused;
  const gwPaused = health?.paused;
  /**
   * A gateway deployed with GATEWAY_ADMIN_TOKEN refuses owner commands from any
   * caller that cannot present it — which is this browser, unless the build was
   * deliberately given VITE_GATEWAY_ADMIN_TOKEN (and it should not be: that value
   * ships in the bundle, so publishing it there hands the pause switch to every
   * visitor).
   *
   * Surfaced up front rather than discovered on click, because a button that
   * always answers 403 is indistinguishable from a broken one. The on-chain
   * pause stays available to whoever holds the owner key: that is the authority
   * that survives a gateway restart, and it is the remedy the gateway's own 403
   * detail recommends.
   */
  const gwLocked = Boolean(health?.deployment?.adminLocked) && !ADMIN_TOKEN_CONFIGURED;
  const canWrite = Boolean(operator.signer) && operator.isOwner !== false;

  const agentAddress =
    target === "gateway" ? health?.agentWallet || null
    : target === "own" ? session.agentAddress
    : target === "custom" ? (ethers.isAddress(customAgent) ? ethers.getAddress(customAgent) : null)
    : null;

  function treasuryWithSigner() {
    return new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operator.signer);
  }

  async function run(label, fn) {
    if (!canWrite) { setMsg({ ok: false, error: "Connect the treasury owner wallet first." }); return; }
    setBusy(label); setMsg(null);
    const r = await sendTx(label, fn);
    setMsg(r.ok && r.reverted
      ? { ...r, ok: false, error: `The transaction reverted on chain (tx ${short(r.hash, 8)}). The most likely cause is a policy rule: check the amount against the agent's per-call max and remaining daily cap.` }
      : r);
    setBusy(null);
    refresh();
  }

  const fund = () => run("fundAgent", async () => {
    if (!agentAddress) throw new Error("No target agent selected.");
    return treasuryWithSigner().fundAgent(agentAddress, ethers.parseUnits(amount || "0", 18));
  });

  const setLimits = () => run("setAgentLimits", async () => {
    if (!agentAddress) throw new Error("No target agent selected.");
    return treasuryWithSigner().setAgentLimits(
      agentAddress,
      ethers.parseUnits(perCall || "0", 18),
      ethers.parseUnits(daily || "0", 18)
    );
  });

  const pause = () => run("pause", async () => treasuryWithSigner().pause());
  const unpause = () => run("unpause", async () => treasuryWithSigner().unpause());
  const stop = () => run("emergencyStop", async () => {
    if (!agentAddress) throw new Error("No target agent selected.");
    return treasuryWithSigner().emergencyStop(agentAddress);
  });

  const deposit = () => run("deposit MUSD", async () => {
    const musd = new ethers.Contract(MUSD_ADDRESS, ERC20_ABI, operator.signer);
    const amt = ethers.parseUnits(depositAmt || "0", 18);
    const addr = await operator.signer.getAddress();
    const allowed = await musd.allowance(addr, TREASURY_ADDRESS);
    if (allowed < amt) {
      const ap = await musd.approve(TREASURY_ADDRESS, amt);
      await ap.wait().catch(() => null);
    }
    return treasuryWithSigner().deposit(amt);
  });

  /**
   * Owner commands, with the locked case answered before the round trip.
   *
   * Both still go through the request when the gateway reports itself unlocked,
   * because health can be stale — a token could have been added since the last
   * poll — and a 403 arriving from the wire is handled identically to one
   * predicted locally. One code path, two triggers.
   */
  const ownerCommand = async (label, call) => {
    setBusy(label); setMsg(null);
    if (gwLocked) {
      setMsg({ ok: false, label, locked: true, error: ADMIN_LOCKED_DETAIL });
      setBusy(null);
      return;
    }
    const r = await call();
    if (isAdminLocked(r)) {
      // The gateway said it out loud: use its own explanation rather than a
      // paraphrase, and name the code so it can be found in the docs.
      setMsg({ ok: false, label, locked: true, code: "admin_locked", error: r.detail || ADMIN_LOCKED_DETAIL });
    } else {
      setMsg(r.ok ? { ok: true, label } : { ok: false, label, error: r.error || `HTTP ${r.status ?? "?"}` });
    }
    setBusy(null); refresh();
  };
  const gwPause = () => ownerCommand("gateway pause", () => pauseGateway("paused from the dashboard"));
  const gwUnpause = () => ownerCommand("gateway resume", () => unpauseGateway());

  // A non-owner sees an explanation, not a wall of disabled buttons: disabled
  // controls with no reason read as a broken page.
  if (!operator.signer) {
    return (
      <Card
        title="Protocol controls"
        aside={<Badge tone="neutral"><Dot tone="warn" /> owner not connected</Badge>}
      >
        <p className="text-[14px] leading-relaxed text-muted">
          Everything below this line acts on the treasury itself — releasing float, depositing MUSD, pausing, and
          sweeping an agent's balance back. Those calls are{" "}
          <span className="code">onlyOwner</span>, so they need the wallet that owns the treasury:{" "}
          <AddressLink address={TREASURY_OWNER} chars={6} />.
        </p>
        <Note className="mt-4">
          <b className="text-text">Not the owner?</b> That is the normal case, and nothing above is blocked by it. Your
          own budget, your float and your payments all work without these controls — they exist for whoever funded the
          treasury. Ask the operator, or connect their wallet:
          <div className="mt-3 flex flex-wrap gap-2">
            {!session.configured && (
              <Button variant="primary" onClick={connectLegacy} disabled={connecting}>
                {connecting ? "…" : "Connect injected wallet"}
              </Button>
            )}
            {session.configured && !session.user && (
              <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
                {session.authenticating ? "Opening…" : "Sign in"}
              </Button>
            )}
            {session.configured && session.user && (
              <span className="text-[13.5px] text-dim">
                Sign in again and choose <b className="text-muted">continue with wallet</b>, then connect the owner
                address in MetaMask. The session compares it to{" "}
                <span className="code">treasury.owner()</span> on chain before enabling anything here.
              </span>
            )}
          </div>
        </Note>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {operator.isOwner === false && (
        <Note tone="bad">
          Connected, but this is not the treasury owner ({short(TREASURY_OWNER, 6)}). Writes will revert with{" "}
          <span className="code">NotOwner</span>.
        </Note>
      )}

      <Card
        title="Protocol controls"
        aside={
          <Badge tone={canWrite ? "ok" : "bad"}>
            <Dot tone={canWrite ? "ok" : "bad"} />
            {canWrite ? "owner connected" : "wrong wallet"}
          </Badge>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-muted">
          Real on-chain transactions on {CHAIN.name}, paid in {CHAIN.nativeCurrency.symbol}. No agent key is used here,
          and none ever reaches the browser. These controls have <b className="text-text">no ceiling</b> — unlike the
          self-service budget above, the owner may set any cap on any agent.
        </p>

        {/* target agent */}
        <div className="mt-5 rounded-xl border border-line-soft bg-ink-dim/50 p-4">
          <div className="mb-2.5 text-[12.5px] uppercase tracking-[0.14em] text-dim">Target agent</div>
          <div className="flex flex-wrap gap-2">
            <TargetButton active={target === "gateway"} onClick={() => setTarget("gateway")} disabled={!health?.agentWallet}>
              Gateway demo agent
              {health?.agentWallet && <span className="ml-1.5 font-mono text-[12px] opacity-70">{short(health.agentWallet, 3)}</span>}
            </TargetButton>
            <TargetButton active={target === "own"} onClick={() => setTarget("own")} disabled={!session.agentAddress}>
              Your wallet
              {session.agentAddress && <span className="ml-1.5 font-mono text-[12px] opacity-70">{short(session.agentAddress, 3)}</span>}
            </TargetButton>
            <TargetButton active={target === "custom"} onClick={() => setTarget("custom")}>
              Another address
            </TargetButton>
          </div>

          {target === "custom" && (
            <div className="mt-3 max-w-md">
              <Field label="Agent address">
                <input className="input" value={customAgent} placeholder="0x…"
                       onChange={(e) => setCustomAgent(e.target.value)} spellCheck={false} />
              </Field>
            </div>
          )}

          <div className="mt-3 text-[13.5px] text-muted">
            {agentAddress
              ? <>Acting on <AddressLink address={agentAddress} /></>
              : <span className="text-warn">No valid target selected — the actions below are disabled.</span>}
          </div>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {/* release float */}
          <Card title="Release float" aside={<Badge tone="neutral">fundAgent</Badge>}>
            <Field label="Amount (MUSD)" hint="Rejected on chain if it exceeds the agent's per-call max or its remaining daily cap.">
              <div className="flex gap-2">
                <input className="input" value={amount} inputMode="decimal"
                       onChange={(e) => setAmount(e.target.value)} />
                <Button onClick={fund} disabled={!canWrite || !agentAddress || busy !== null}>
                  {busy === "fundAgent" ? "…" : "release"}
                </Button>
              </div>
            </Field>
            <Note className="mt-3">
              Treasury holds <b className="tnum text-text">{fmtMusd(health?.treasury?.balance, 2)}</b> MUSD. This is the
              on-chain cap: an agent can never spend more than has been released to it.
            </Note>
          </Card>

          {/* limits */}
          <Card title="Spending limits" aside={<Badge tone="neutral">setAgentLimits</Badge>}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Per-call max (MUSD)">
                <input className="input" value={perCall} inputMode="decimal"
                       onChange={(e) => setPerCall(e.target.value)} />
              </Field>
              <Field label="Daily cap (MUSD)">
                <input className="input" value={daily} inputMode="decimal"
                       onChange={(e) => setDaily(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Button onClick={setLimits} disabled={!canWrite || !agentAddress || busy !== null}>
                {busy === "setAgentLimits" ? "…" : "apply limits"}
              </Button>
            </div>
            <Note className="mt-3">
              Lower the per-call max below a seller's price and the treasury refuses the payment before anything is
              signed — that refusal is written to the ledger as a denial.
            </Note>
          </Card>

          {/* deposit */}
          <Card title="Deposit MUSD" aside={<Badge tone="neutral">approve + deposit</Badge>}>
            <Field label="Amount (MUSD)" hint="Approves the treasury first if the allowance is short, then deposits.">
              <div className="flex gap-2">
                <input className="input" value={depositAmt} inputMode="decimal"
                       onChange={(e) => setDepositAmt(e.target.value)} />
                <Button onClick={deposit} disabled={!canWrite || busy !== null}>
                  {busy === "deposit MUSD" ? "…" : "deposit"}
                </Button>
              </div>
            </Field>
          </Card>

          {/* pause */}
          <Card
            title="Pause"
            aside={
              <Badge tone={chainPaused || gwPaused ? "bad" : "ok"}>
                <Dot tone={chainPaused || gwPaused ? "bad" : "ok"} />
                {chainPaused ? "paused on chain" : gwPaused ? "gateway paused" : "running"}
              </Badge>
            }
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {gwPaused
                  ? <Button onClick={gwUnpause} icon={Play} disabled={gwLocked || busy !== null}
                            title={gwLocked ? "Locked: this gateway needs GATEWAY_ADMIN_TOKEN, which this bundle does not carry" : "Resume gateway signing immediately"}>
                      {busy === "gateway resume" ? "…" : "resume gateway"}
                    </Button>
                  : <Button onClick={gwPause} icon={Pause} disabled={gwLocked || busy !== null}
                            title={gwLocked ? "Locked: this gateway needs GATEWAY_ADMIN_TOKEN, which this bundle does not carry" : "Stop gateway signing immediately — no transaction, no gas"}>
                      {busy === "gateway pause" ? "…" : "pause gateway"}
                    </Button>}
                <span className="text-[13px] text-dim">instant · no tx · no gas · stops signing</span>
                {gwLocked && <Badge tone="warn" icon={Lock}>locked — token required</Badge>}
              </div>
              {gwLocked && (
                <Note tone="warn" icon={Lock} title="The gateway pause is locked on this deployment">
                  {ADMIN_LOCKED_DETAIL}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" className="border border-line-soft" icon={Landmark}
                            onClick={pause} disabled={!canWrite || busy !== null}
                            title={canWrite ? "Pause the treasury on chain — authoritative, needs the owner wallet" : "Connect the owner wallet to pause on chain"}>
                      Pause on chain instead
                    </Button>
                  </div>
                </Note>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {chainPaused
                  ? <Button onClick={unpause} disabled={!canWrite || busy !== null}>{busy === "unpause" ? "…" : "unpause on chain"}</Button>
                  : <Button onClick={pause} disabled={!canWrite || busy !== null}>{busy === "pause" ? "…" : "pause on chain"}</Button>}
                <span className="text-[12.5px] text-dim">authoritative · owner tx</span>
              </div>
            </div>
            <Note tone="bad" className="mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="danger" onClick={stop} disabled={!canWrite || !agentAddress || busy !== null}>
                  {busy === "emergencyStop" ? "…" : "EMERGENCY STOP"}
                </Button>
                <span className="text-[12.5px]">pauses the treasury and sweeps the agent's float back</span>
              </div>
              <p className="mt-2.5">
                Pausing alone stops <i>further</i> releases — an agent already holding float can still spend it. The
                sweep is what actually stops it, and it needs the agent's recall allowance.
              </p>
            </Note>
          </Card>
        </div>
      </Card>

      {msg && (
        <Note tone={msg.ok ? "ok" : msg.locked ? "warn" : "bad"}
              icon={msg.locked ? Lock : undefined}
              title={msg.locked ? "That control is locked on this deployment" : undefined}>
          {msg.ok ? (
            <>
              <b>{msg.label}</b> succeeded.
              {msg.hash && <> Tx: <TxLink hash={msg.hash} /></>}
              {msg.confirmed === false && (
                <span className="text-dim"> · broadcast, confirmation not observed within 25s — the Mezo testnet RPC
                often reports receipts late, so check the explorer link.</span>
              )}
            </>
          ) : (
            <>
              <b>{msg.label ? `${msg.label} failed` : "Failed"}.</b> {msg.error}
              {msg.code && <> <span className="code">{msg.code}</span></>}
              {msg.data && <> <span className="font-mono text-[12.5px]">({msg.data.join(", ")})</span></>}
            </>
          )}
        </Note>
      )}
    </div>
  );
}

function TargetButton({ active, children, ...rest }) {
  return (
    <button className={`btn ${active ? "btn-primary" : ""}`} aria-pressed={active} {...rest}>
      {children}
    </button>
  );
}
