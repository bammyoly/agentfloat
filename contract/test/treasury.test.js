const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// AgentFloatTreasury policy tests.
//
// These run against MockMUSD on the local Hardhat chain. They exist to prove the
// budget controls actually hold BEFORE any testnet BTC is spent on gas — the
// whole point of the contract is enforcement, so enforcement is what we test.
// ---------------------------------------------------------------------------

const ONE = ethers.parseUnits("1", 18);

async function deployFixture() {
  const [owner, gateway, agentWallet, merchant, stranger, newOwner] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockMUSD");
  const musd = await Mock.deploy();

  const Treasury = await ethers.getContractFactory("AgentFloatTreasury");
  const treasury = await Treasury.deploy(await musd.getAddress(), owner.address);

  // Operator funds themselves, then deposits into the treasury.
  await musd.faucet(owner.address, 10_000n * ONE);
  await musd.connect(owner).approve(await treasury.getAddress(), 10_000n * ONE);
  await treasury.deposit(1_000n * ONE);

  // Default policy: 5 MUSD per release, 50 MUSD per UTC day.
  const perCallMax = 5n * ONE;
  const dailyCap = 50n * ONE;
  await treasury.registerAgent(agentWallet.address, gateway.address, perCallMax, dailyCap);

  return { musd, treasury, owner, gateway, agentWallet, merchant, stranger, newOwner, perCallMax, dailyCap };
}

describe("AgentFloatTreasury", function () {
  describe("deployment", function () {
    it("sets MUSD, owner, and starts unpaused", async function () {
      const { treasury, musd, owner } = await deployFixture();
      expect(await treasury.musd()).to.equal(await musd.getAddress());
      expect(await treasury.owner()).to.equal(owner.address);
      expect(await treasury.paused()).to.equal(false);
      expect(await treasury.VERSION()).to.equal("1.0.0");
    });

    it("rejects zero addresses in the constructor", async function () {
      const { musd, owner } = await deployFixture();
      const Treasury = await ethers.getContractFactory("AgentFloatTreasury");
      await expect(Treasury.deploy(ethers.ZeroAddress, owner.address))
        .to.be.revertedWithCustomError(Treasury, "ZeroAddress");
      await expect(Treasury.deploy(await musd.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Treasury, "ZeroAddress");
    });
  });

  describe("custody", function () {
    it("tracks deposits and treasury balance", async function () {
      const { treasury } = await deployFixture();
      expect(await treasury.treasuryBalance()).to.equal(1_000n * ONE);
      expect(await treasury.totalDeposited()).to.equal(1_000n * ONE);
    });

    it("rejects a deposit larger than the allowance", async function () {
      const { treasury, stranger, musd } = await deployFixture();
      // stranger holds MUSD but has approved nothing.
      await musd.faucet(stranger.address, 100n * ONE);
      await expect(treasury.connect(stranger).deposit(100n * ONE))
        .to.be.revertedWithCustomError(treasury, "InsufficientAllowance");

      // A partial allowance must not cover a larger deposit either.
      await musd.connect(stranger).approve(await treasury.getAddress(), 10n * ONE);
      await expect(treasury.connect(stranger).deposit(100n * ONE))
        .to.be.revertedWithCustomError(treasury, "InsufficientAllowance");
    });

    it("rejects a zero deposit", async function () {
      const { treasury } = await deployFixture();
      await expect(treasury.deposit(0)).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("lets the owner withdraw, and keeps that working while paused", async function () {
      const { treasury, owner } = await deployFixture();
      await treasury.pause();
      await treasury.withdrawTo(owner.address, 200n * ONE);
      expect(await treasury.treasuryBalance()).to.equal(800n * ONE);
      expect(await treasury.totalWithdrawn()).to.equal(200n * ONE);
    });

    it("blocks a non-owner withdrawal", async function () {
      const { treasury, stranger } = await deployFixture();
      await expect(treasury.connect(stranger).withdrawTo(stranger.address, ONE))
        .to.be.revertedWithCustomError(treasury, "NotOwner");
    });
  });

  describe("agent registration", function () {
    it("registers an agent and lists it", async function () {
      const { treasury, agentWallet, gateway, perCallMax, dailyCap } = await deployFixture();
      expect(await treasury.agentCount()).to.equal(1);
      expect(await treasury.isRegistered(agentWallet.address)).to.equal(true);
      const a = await treasury.agents(agentWallet.address);
      expect(a.active).to.equal(true);
      expect(a.gateway).to.equal(gateway.address);
      expect(a.perCallMax).to.equal(perCallMax);
      expect(a.dailyCap).to.equal(dailyCap);
    });

    it("rejects duplicate registration", async function () {
      const { treasury, agentWallet, gateway, perCallMax, dailyCap } = await deployFixture();
      await expect(treasury.registerAgent(agentWallet.address, gateway.address, perCallMax, dailyCap))
        .to.be.revertedWithCustomError(treasury, "AlreadyRegistered");
    });

    it("rejects a daily cap below the per-call max", async function () {
      const { treasury, stranger, gateway } = await deployFixture();
      await expect(treasury.registerAgent(stranger.address, gateway.address, 10n * ONE, 5n * ONE))
        .to.be.revertedWithCustomError(treasury, "ExceedsDailyCap");
    });

    it("only the owner can register", async function () {
      const { treasury, stranger, gateway } = await deployFixture();
      await expect(treasury.connect(stranger).registerAgent(stranger.address, gateway.address, ONE, ONE))
        .to.be.revertedWithCustomError(treasury, "NotOwner");
    });
  });

  describe("fundAgent — the hard cap", function () {
    it("releases MUSD to the agent wallet within policy", async function () {
      const { treasury, musd, agentWallet } = await deployFixture();
      await expect(treasury.fundAgent(agentWallet.address, 3n * ONE))
        .to.emit(treasury, "AgentFunded");
      expect(await musd.balanceOf(agentWallet.address)).to.equal(3n * ONE);
      expect(await treasury.treasuryBalance()).to.equal(997n * ONE);
    });

    it("enforces the per-call max", async function () {
      const { treasury, agentWallet, perCallMax } = await deployFixture();
      await expect(treasury.fundAgent(agentWallet.address, perCallMax + 1n))
        .to.be.revertedWithCustomError(treasury, "ExceedsPerCallMax");
    });

    it("enforces the daily cap across multiple releases", async function () {
      const { treasury, agentWallet } = await deployFixture();
      // 50/day at 5/call => 10 releases, the 11th must fail.
      for (let i = 0; i < 10; i++) {
        await treasury.fundAgent(agentWallet.address, 5n * ONE);
      }
      expect(await treasury.treasuryBalance()).to.equal(950n * ONE);
      await expect(treasury.fundAgent(agentWallet.address, 1n))
        .to.be.revertedWithCustomError(treasury, "ExceedsDailyCap");
    });

    it("resets the daily cap after a UTC day rolls over", async function () {
      const { treasury, agentWallet } = await deployFixture();
      for (let i = 0; i < 10; i++) {
        await treasury.fundAgent(agentWallet.address, 5n * ONE);
      }
      await expect(treasury.fundAgent(agentWallet.address, 5n * ONE))
        .to.be.revertedWithCustomError(treasury, "ExceedsDailyCap");

      // Advance one full UTC day.
      await ethers.provider.send("evm_increaseTime", [86_400]);
      await ethers.provider.send("evm_mine");

      await treasury.fundAgent(agentWallet.address, 5n * ONE); // now allowed
      const s = await treasury.agentStatus(agentWallet.address);
      expect(s.dayFunded).to.equal(5n * ONE);
    });

    it("blocks funding while paused", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await treasury.pause();
      await expect(treasury.fundAgent(agentWallet.address, ONE))
        .to.be.revertedWithCustomError(treasury, "EnforcedPause");
      await treasury.unpause();
      await treasury.fundAgent(agentWallet.address, ONE); // ok again
    });

    it("blocks funding a disabled agent", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await treasury.setAgentActive(agentWallet.address, false);
      await expect(treasury.fundAgent(agentWallet.address, ONE))
        .to.be.revertedWithCustomError(treasury, "AgentInactive");
    });

    it("blocks funding an unregistered address", async function () {
      const { treasury, stranger } = await deployFixture();
      await expect(treasury.fundAgent(stranger.address, ONE))
        .to.be.revertedWithCustomError(treasury, "NotRegistered");
    });

    it("fails when the treasury cannot cover the release", async function () {
      const { treasury, owner, agentWallet } = await deployFixture();
      await treasury.withdrawTo(owner.address, 1_000n * ONE); // drain
      await expect(treasury.fundAgent(agentWallet.address, ONE))
        .to.be.revertedWithCustomError(treasury, "InsufficientTreasuryBalance");
    });

    it("cannot be called by a stranger", async function () {
      const { treasury, stranger, agentWallet } = await deployFixture();
      await expect(treasury.connect(stranger).fundAgent(agentWallet.address, ONE))
        .to.be.revertedWithCustomError(treasury, "NotOwner");
    });

    it("accumulates lifetime funded totals", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await treasury.fundAgent(agentWallet.address, 2n * ONE);
      await treasury.fundAgent(agentWallet.address, 3n * ONE);
      expect(await treasury.totalFunded()).to.equal(5n * ONE);
      const s = await treasury.agentStatus(agentWallet.address);
      expect(s.lifetimeFunded).to.equal(5n * ONE);
      expect(s.dayFunded).to.equal(5n * ONE);
      expect(s.remainingToday).to.equal(45n * ONE);
    });
  });

  describe("limits updates", function () {
    it("tightens limits immediately, even below today's spend", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await treasury.fundAgent(agentWallet.address, 5n * ONE);
      // Drop the daily cap to 4 — already spent 5, so nothing more may be released.
      await treasury.setAgentLimits(agentWallet.address, 1n * ONE, 4n * ONE);
      await expect(treasury.fundAgent(agentWallet.address, 1n))
        .to.be.revertedWithCustomError(treasury, "ExceedsDailyCap");
    });

    it("rejects perCallMax above dailyCap on update", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await expect(treasury.setAgentLimits(agentWallet.address, 10n * ONE, 5n * ONE))
        .to.be.revertedWithCustomError(treasury, "ExceedsDailyCap");
    });

    // Regression: lowering dailyCap below what has already been released today
    // used to underflow (panic 0x11) in both fundAgent and agentStatus.
    it("clamps remaining budget to zero when the cap drops below today's spend", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await treasury.fundAgent(agentWallet.address, 5n * ONE); // spent 5 today
      await treasury.setAgentLimits(agentWallet.address, 1n * ONE, 4n * ONE); // cap now 4 < 5

      // The view must not revert, and must report zero remaining.
      const s = await treasury.agentStatus(agentWallet.address);
      expect(s.remainingToday).to.equal(0n);
      expect(s.dayFunded).to.equal(5n * ONE);
      expect(s.dailyCap).to.equal(4n * ONE);

      // Funding must fail with a clean domain error, not an arithmetic panic.
      await expect(treasury.fundAgent(agentWallet.address, 1n))
        .to.be.revertedWithCustomError(treasury, "ExceedsDailyCap");

      // Raising the cap again restores headroom.
      await treasury.setAgentLimits(agentWallet.address, 1n * ONE, 10n * ONE);
      await treasury.fundAgent(agentWallet.address, 1n * ONE);
      expect((await treasury.agentStatus(agentWallet.address)).dayFunded).to.equal(6n * ONE);
    });

    it("allows the gateway to be reassigned", async function () {
      const { treasury, agentWallet, stranger } = await deployFixture();
      await treasury.setGateway(agentWallet.address, stranger.address);
      const a = await treasury.agents(agentWallet.address);
      expect(a.gateway).to.equal(stranger.address);
    });
  });

  describe("recall + emergency stop", function () {
    async function grantAllowance(ctx, amount) {
      await ctx.musd.connect(ctx.agentWallet).approve(await ctx.treasury.getAddress(), amount);
    }

    it("recalls unspent float once the agent has granted an allowance", async function () {
      const ctx = await deployFixture();
      const { treasury, musd, agentWallet } = ctx;
      await treasury.fundAgent(agentWallet.address, 5n * ONE);
      await grantAllowance(ctx, 5n * ONE);

      await treasury.recallFromAgent(agentWallet.address, 2n * ONE);
      expect(await musd.balanceOf(agentWallet.address)).to.equal(3n * ONE);
      expect(await treasury.treasuryBalance()).to.equal(997n * ONE);
    });

    it("refuses to recall without an allowance", async function () {
      const { treasury, agentWallet } = await deployFixture();
      await treasury.fundAgent(agentWallet.address, 5n * ONE);
      await expect(treasury.recallFromAgent(agentWallet.address, ONE))
        .to.be.revertedWithCustomError(treasury, "InsufficientAllowance");
    });

    it("caps the recall at what the agent actually holds", async function () {
      const ctx = await deployFixture();
      const { treasury, musd, agentWallet } = ctx;
      await treasury.fundAgent(agentWallet.address, 5n * ONE);
      await grantAllowance(ctx, 1_000n * ONE); // generous allowance
      await treasury.recallFromAgent(agentWallet.address, 999n * ONE);
      expect(await musd.balanceOf(agentWallet.address)).to.equal(0);
    });

    it("emergencyStop pauses AND sweeps the agent wallet", async function () {
      const ctx = await deployFixture();
      const { treasury, musd, agentWallet } = ctx;
      await treasury.fundAgent(agentWallet.address, 5n * ONE);
      await grantAllowance(ctx, 5n * ONE);

      await expect(treasury.emergencyStop(agentWallet.address))
        .to.emit(treasury, "Paused")
        .and.to.emit(treasury, "EmergencyStop");

      expect(await treasury.paused()).to.equal(true);
      expect(await musd.balanceOf(agentWallet.address)).to.equal(0);
      expect(await treasury.treasuryBalance()).to.equal(1_000n * ONE);
    });

    it("emergencyStop still pauses when the agent granted no allowance", async function () {
      const { treasury, musd, agentWallet } = await deployFixture();
      await treasury.fundAgent(agentWallet.address, 5n * ONE);
      // No approval. The pause must still land; the sweep is skipped, not reverted.
      await treasury.emergencyStop(agentWallet.address);
      expect(await treasury.paused()).to.equal(true);
      expect(await musd.balanceOf(agentWallet.address)).to.equal(5n * ONE);
    });

    it("only the owner can trigger an emergency stop", async function () {
      const { treasury, stranger, agentWallet } = await deployFixture();
      await expect(treasury.connect(stranger).emergencyStop(agentWallet.address))
        .to.be.revertedWithCustomError(treasury, "NotOwner");
    });
  });

  describe("receipts and denials", function () {
    it("accepts a payment receipt from the registered gateway", async function () {
      const { treasury, gateway, agentWallet, merchant } = await deployFixture();
      const tx = ethers.encodeBytes32String("0xsettlementhash");
      await expect(
        treasury.connect(gateway).recordPayment(agentWallet.address, merchant.address, ONE, tx, "https://api.example.com/v1/data")
      ).to.emit(treasury, "PaymentRecorded");

      expect(await treasury.paymentCount()).to.equal(1);
      const [p] = await treasury.recentPayments(10);
      expect(p.agent).to.equal(agentWallet.address);
      expect(p.payee).to.equal(merchant.address);
      expect(p.amount).to.equal(ONE);
      expect(p.endpoint).to.equal("https://api.example.com/v1/data");
    });

    it("rejects receipts from anyone but the gateway", async function () {
      const { treasury, stranger, agentWallet, merchant } = await deployFixture();
      await expect(
        treasury.connect(stranger).recordPayment(agentWallet.address, merchant.address, ONE, ethers.ZeroHash, "x")
      ).to.be.revertedWithCustomError(treasury, "NotGateway");
    });

    it("records a policy denial", async function () {
      const { treasury, gateway, agentWallet } = await deployFixture();
      await treasury.connect(gateway).recordDenial(agentWallet.address, 99n * ONE, "https://api.example.com", "per_call_max");
      expect(await treasury.denialCount()).to.equal(1);
      const [d] = await treasury.recentDenials(10);
      expect(d.reason).to.equal("per_call_max");
      expect(d.attempted).to.equal(99n * ONE);
    });

    it("pages payments newest-first and bounds the result", async function () {
      const { treasury, gateway, agentWallet, merchant } = await deployFixture();
      for (let i = 0; i < 5; i++) {
        await treasury.connect(gateway).recordPayment(
          agentWallet.address, merchant.address, BigInt(i + 1) * ONE, ethers.ZeroHash, `https://api.example.com/${i}`
        );
      }
      const recent = await treasury.recentPayments(3);
      expect(recent.length).to.equal(3);
      expect(recent[0].endpoint).to.equal("https://api.example.com/4");
      expect(recent[2].endpoint).to.equal("https://api.example.com/2");
      // Asking for more than exists must not revert.
      const all = await treasury.recentPayments(100);
      expect(all.length).to.equal(5);
    });

    it("filters receipts per agent", async function () {
      const { treasury, gateway, agentWallet, merchant, owner, stranger } = await deployFixture();
      await treasury.registerAgent(stranger.address, gateway.address, ONE, 10n * ONE);
      await treasury.connect(gateway).recordPayment(agentWallet.address, merchant.address, ONE, ethers.ZeroHash, "a");
      await treasury.connect(gateway).recordPayment(stranger.address, merchant.address, ONE, ethers.ZeroHash, "b");

      const forAgent = await treasury.paymentsByAgent(agentWallet.address, 10);
      expect(forAgent.length).to.equal(1);
      expect(forAgent[0].endpoint).to.equal("a");
    });
  });

  describe("agentStatus view", function () {
    it("reports live wallet balance and remaining budget", async function () {
      const ctx = await deployFixture();
      const { treasury, agentWallet } = ctx;
      await treasury.fundAgent(agentWallet.address, 5n * ONE);

      const s = await treasury.agentStatus(agentWallet.address);
      expect(s.active).to.equal(true);
      expect(s.walletBalance).to.equal(5n * ONE);
      expect(s.dayFunded).to.equal(5n * ONE);
      expect(s.remainingToday).to.equal(45n * ONE);
      expect(s.recallAllowance).to.equal(0n);

      await ctx.musd.connect(agentWallet).approve(await treasury.getAddress(), 5n * ONE);
      const s2 = await treasury.agentStatus(agentWallet.address);
      expect(s2.recallAllowance).to.equal(5n * ONE);
    });

    it("reverts for an unknown agent", async function () {
      const { treasury, stranger } = await deployFixture();
      await expect(treasury.agentStatus(stranger.address))
        .to.be.revertedWithCustomError(treasury, "NotRegistered");
    });
  });

  describe("ownership", function () {
    it("uses a two-step transfer", async function () {
      const { treasury, owner, newOwner } = await deployFixture();
      await treasury.transferOwnership(newOwner.address);
      expect(await treasury.owner()).to.equal(owner.address);       // not yet
      expect(await treasury.pendingOwner()).to.equal(newOwner.address);

      await treasury.connect(newOwner).acceptOwnership();
      expect(await treasury.owner()).to.equal(newOwner.address);
      expect(await treasury.pendingOwner()).to.equal(ethers.ZeroAddress);

      // Old owner is now locked out.
      await expect(treasury.pause()).to.be.revertedWithCustomError(treasury, "NotOwner");
    });

    it("rejects acceptance by the wrong account", async function () {
      const { treasury, stranger, newOwner } = await deployFixture();
      await treasury.transferOwnership(newOwner.address);
      await expect(treasury.connect(stranger).acceptOwnership())
        .to.be.revertedWithCustomError(treasury, "NotPendingOwner");
    });
  });
});
