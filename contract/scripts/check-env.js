// ---------------------------------------------------------------------------
// AgentFloat — pre-flight environment check
//
//   ./node_modules/.bin/hardhat run scripts/check-env.js --network mezoTestnet
//
// Confirms the deployer can actually pay for a deploy BEFORE you try one, and
// re-verifies the Mezo facts this project depends on. Run this first.
// ---------------------------------------------------------------------------

const { ethers } = require("hardhat");

const MUSD_EXPECTED = {
  31611: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  31612: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
};
const MUSD_IMPOSTOR = "0xf9bbccc0f1b68ea07c86de6f88c76b3d8e2dd0af";
const FACILITATOR = "https://facilitator.vativ.io/supported";

let pass = 0, fail = 0, warn = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };
const note = (m) => { console.log(`  ⚠️  ${m}`); warn++; };
const info = (m) => console.log(`  ·  ${m}`);
const fmt = (wei, dp = 6) => Number(ethers.formatUnits(wei, 18)).toFixed(dp);

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const [signer] = await ethers.getSigners();

  console.log(`\n== Chain ================================================================`);
  if (chainId === 31611) ok(`chainId 31611 — Mezo Testnet`);
  else if (chainId === 31612) ok(`chainId 31612 — Mezo Mainnet`);
  else if (chainId === 31337) info(`chainId 31337 — local Hardhat (checks below are skipped)`);
  else bad(`unexpected chainId ${chainId}`);
  info(`latest block ${await ethers.provider.getBlockNumber()}`);

  if (chainId === 31337) {
    console.log(`\n== Local run: nothing else to verify. Use --network mezoTestnet. ======\n`);
    return;
  }

  console.log(`\n== Deployer =============================================================`);
  if (!signer) { bad(`no signer — set DEPLOYER_PRIVATE_KEY in contract/.env`); }
  else {
    info(`address ${signer.address}`);
    const gas = await ethers.provider.getBalance(signer.address);
    if (gas === 0n) {
      bad(`zero BTC for gas — nothing will deploy. Faucet: https://faucet.test.mezo.org`);
    } else if (gas < ethers.parseUnits("0.00002", 18)) {
      note(`only ${fmt(gas, 8)} BTC for gas — enough to try, but top up if a tx fails`);
    } else {
      ok(`${fmt(gas, 8)} BTC available for gas`);
    }

    const musdAddr = MUSD_EXPECTED[chainId];
    const musd = await ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)", "function name() view returns (string)",
       "function symbol() view returns (string)", "function decimals() view returns (uint8)"],
      musdAddr
    );
    const bal = await musd.balanceOf(signer.address);
    if (bal === 0n) {
      note(`deployer holds 0 MUSD — you can deploy, but the treasury will be empty.\n` +
           `     MUSD is minted, not fauceted: borrow against testnet BTC at\n` +
           `     https://mezo.org/feature/borrow with the wallet on Mezo Testnet.`);
    } else {
      ok(`deployer holds ${fmt(bal, 2)} MUSD`);
    }
  }

  console.log(`\n== MUSD token identity (the two-MUSD trap) =============================`);
  const musdAddr = MUSD_EXPECTED[chainId];
  const musd = await ethers.getContractAt(
    ["function name() view returns (string)", "function symbol() view returns (string)",
     "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"],
    musdAddr
  );
  const [name, symbol, decimals, supply] = await Promise.all([
    musd.name(), musd.symbol(), musd.decimals(), musd.totalSupply(),
  ]);
  info(`${musdAddr}`);
  info(`name="${name}" symbol="${symbol}" decimals=${decimals} supply=${fmt(supply, 2)}`);
  if (name === "Mezo USD" && symbol === "MUSD" && Number(decimals) === 18) {
    ok(`metadata matches the x402-settleable MUSD`);
  } else {
    bad(`metadata mismatch — do not deploy against this token`);
  }

  // Is the impostor still out there?
  try {
    const imp = await ethers.getContractAt(["function symbol() view returns (string)"], MUSD_IMPOSTOR);
    const s = await imp.symbol();
    note(`a SECOND token also reporting symbol="${s}" exists at ${MUSD_IMPOSTOR}\n` +
         `     Never bind the treasury to it — x402 will not settle in it.`);
  } catch {
    info(`impostor MUSD not present on this chain`);
  }

  console.log(`\n== x402 facilitator ====================================================`);
  try {
    const res = await fetch(FACILITATOR);
    const d = await res.json();
    const kinds = d.kinds || [];
    const mine = kinds.find((k) => k.network === `eip155:${chainId}`);
    if (!mine) bad(`facilitator does not serve eip155:${chainId}`);
    else {
      ok(`facilitator serves eip155:${chainId} (scheme "${mine.scheme}", x402 v${mine.x402Version})`);
      const asset = (mine.extra?.assets || []).find((a) => a.symbol === "MUSD");
      if (!asset) bad(`facilitator lists no MUSD asset for this network`);
      else if (asset.address.toLowerCase() !== musdAddr.toLowerCase()) {
        bad(`facilitator's MUSD ${asset.address} != expected ${musdAddr}`);
      } else {
        ok(`facilitator's MUSD matches: ${asset.address}`);
        info(`EIP-712 domain name="${asset.eip712?.name}" version="${asset.eip712?.version}"`);
        if (asset.eip712?.name !== "Mezo USD") bad(`EIP-712 domain name is not "Mezo USD" — signatures will fail`);
        info(`transfer method ${asset.assetTransferMethod}, EIP-2612 ${asset.supportsEip2612}`);
      }
    }
    const ext = d.extensions || [];
    if (ext.includes("eip2612GasSponsoring")) {
      ok(`gas sponsoring active — the agent wallet needs NO BTC to make x402 payments`);
    } else {
      note(`eip2612GasSponsoring not advertised — buyers may need gas`);
    }
    info(`signers rotate between calls: ${JSON.stringify(d.signers)}\n` +
         `     Never hardcode these. Verify receipts via the MUSD Transfer log.`);
  } catch (e) {
    bad(`could not reach facilitator: ${e.message}`);
  }

  console.log(`\n== Savings vault (Track 1 / yield) =====================================`);
  const VAULT = "0xb4D498029af77680cD1eF828b967f010d06C51CC";
  const code = await ethers.provider.getCode(VAULT);
  const bytes = code === "0x" ? 0 : code.length / 2 - 1;
  if (chainId === 31611) {
    if (bytes === 0) ok(`vault absent on testnet as expected — the sMUSD feature is mainnet-only`);
    else note(`unexpected: vault code (${bytes} bytes) found on testnet — re-check the brief`);
    info(`The UI will render the yield panel as unavailable. Do not mock it.`);
  } else {
    if (bytes > 0) ok(`vault present on mainnet (${bytes}-byte proxy)`);
    else bad(`vault missing on mainnet — unexpected`);
  }

  console.log(`\n== RESULT: ${pass} passed, ${warn} warnings, ${fail} failed ==============\n`);
  if (fail > 0) {
    console.log(`Fix the failures above before deploying.\n`);
    process.exitCode = 1;
  } else {
    console.log(`Clear to deploy:  ./node_modules/.bin/hardhat run scripts/deploy.js --network mezoTestnet\n`);
  }
}

main().catch((err) => { console.error("\n❌", err.message || err); process.exitCode = 1; });
