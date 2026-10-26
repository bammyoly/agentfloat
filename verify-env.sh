#!/usr/bin/env bash
# AgentFloat — Mezo environment verification
# Re-checks every fact in DEPLOYMENT-BRIEF.md against live endpoints.
# Usage: bash verify-env.sh        (needs: curl, python3)
set -uo pipefail

TEST_RPC="https://rpc.test.mezo.org"
MAIN_RPC="https://mezo-mainnet.boar.network"
FAC="https://facilitator.vativ.io/supported"

MUSD_TEST="0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503"
MUSD_IMPOSTOR="0xf9BBcCC0F1b68EA07c86de6F88C76b3d8E2dD0af"
BO_TEST="0xCdF7028ceAB81fA0C6971208e83fa7872994beE5"
SETTLE_PROXY="0x402085c248EeA27D92E8b30b2C58ed07f9E20001"
VAULT="0xb4D498029af77680cD1eF828b967f010d06C51CC"
UA="Mozilla/5.0 (AgentFloat-verify)"

jrpc() { # jrpc <url> <method> <params-json>
  curl -s -m 30 -A "$UA" -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1"
}
pass=0; fail=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '  PASS  %-52s %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  FAIL  %-52s expected=%s actual=%s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

echo "=== 1. Testnet chain ==="
cid=$(jrpc "$TEST_RPC" eth_chainId '[]' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result"))')
chk "testnet chainId == 0x7b7b (31611)" "0x7b7b" "$cid"
blk=$(jrpc "$TEST_RPC" eth_blockNumber '[]' | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result","0x0");print(int(r,16))')
printf '  INFO  %-52s %s\n' "latest block" "$blk"

echo
echo "=== 2. x402 facilitator ==="
sup=$(curl -s -m 30 -A "$UA" "$FAC")
tmpf=$(mktemp); printf '%s' "$sup" > "$tmpf"
python3 - "$tmpf" <<'PY'
import sys, json
d = json.load(open(sys.argv[1]))
nets = {k["network"]: k for k in d.get("kinds", [])}
print("  networks served:", sorted(nets))
for n in ("eip155:31611", "eip155:31612"):
    if n not in nets:
        print(f"  FAIL  {n} not served"); continue
    a = {x["symbol"]: x for x in nets[n]["extra"]["assets"]}
    m = a.get("MUSD", {})
    print(f"  {n}: MUSD={m.get('address')} dec={m.get('decimals')} "
          f"eip712={m.get('eip712')} method={m.get('assetTransferMethod')} "
          f"eip2612={m.get('supportsEip2612')}")
print("  extensions:", d.get("extensions"))
print("  signers:", d.get("signers"))
print("  NOTE  signer addresses ROTATE between calls - never hardcode them;")
print("        verify receipts via the MUSD Transfer log + settlement proxy.")
PY
rm -f "$tmpf"
for tok in "eip155:31611" "eip155:31612" "$MUSD_TEST" "eip2612GasSponsoring"; do
  if echo "$sup" | grep -q "$tok"; then chk "facilitator mentions $tok" "yes" "yes"
  else chk "facilitator mentions $tok" "yes" "no"; fi
done
if echo "$sup" | grep -q "$MUSD_IMPOSTOR"; then
  printf '  WARN  facilitator DOES list the impostor MUSD — re-check §3 of the brief\n'
else
  chk "impostor MUSD not in facilitator registry" "absent" "absent"
fi

echo
echo "=== 3. x402 settlement proxy on testnet ==="
code=$(jrpc "$TEST_RPC" eth_getCode "[\"$SETTLE_PROXY\",\"latest\"]" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result","0x");print(len(r)//2-1)')
if [ "$code" -gt 100 ]; then chk "settlement proxy deployed on testnet ($code bytes)" "present" "present"
else chk "settlement proxy deployed on testnet" "present" "absent ($code bytes)"; fi

echo
echo "=== 4. The two testnet MUSD tokens ==="
for pair in "canonical:$MUSD_TEST" "impostor:$MUSD_IMPOSTOR"; do
  label="${pair%%:*}"; addr="${pair##*:}"
  out=$(jrpc "$TEST_RPC" eth_call "[{\"to\":\"$addr\",\"data\":\"0x18160ddd\"},\"latest\"]" \
        | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result");print(f"{int(r,16)/1e18:,.0f}" if r and r!="0x" else "n/a")')
  ml=$(jrpc "$TEST_RPC" eth_call "[{\"to\":\"$addr\",\"data\":\"0xbef432c6000000000000000000000000${BO_TEST:2}\"},\"latest\"]" \
        | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result");print("true" if r and int(r,16)!=0 else "false")')
  printf '  INFO  %-10s %s  totalSupply=%s  mintList(BorrowerOps)=%s\n' "$label" "$addr" "$out" "$ml"
done
musd=$(jrpc "$TEST_RPC" eth_call "[{\"to\":\"$BO_TEST\",\"data\":\"0xcab666d0\"},\"latest\"]" \
        | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result") or "";print("0x"+r[-40:] if r else "n/a")')
chk "BorrowerOperations.musd() == canonical MUSD" "$(echo "$MUSD_TEST" | tr 'A-Z' 'a-z')" "$(echo "$musd" | tr 'A-Z' 'a-z')"

echo
echo "=== 5. Savings vault: MAINNET only ==="
tcode=$(jrpc "$TEST_RPC" eth_getCode "[\"$VAULT\",\"latest\"]" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result","0x");print(len(r)//2-1)')
chk "vault code bytes on TESTNET == 0 (absent)" "0" "$tcode"
mcode=$(jrpc "$MAIN_RPC" eth_getCode "[\"$VAULT\",\"latest\"]" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result","0x");print(len(r)//2-1)')
if [ "$mcode" -gt 100 ]; then chk "vault proxy deployed on MAINNET ($mcode bytes)" "present" "present"
else chk "vault proxy deployed on MAINNET" "present" "absent ($mcode bytes)"; fi
vsym=$(jrpc "$MAIN_RPC" eth_call "[{\"to\":\"$VAULT\",\"data\":\"0x95d89b41\"},\"latest\"]" \
       | python3 -c '
import sys,json
r=json.load(sys.stdin).get("result") or ""
print(bytes.fromhex(r[130:130+int(r[66:130],16)*2]).decode() if len(r)>=130 else "n/a")')
chk "vault symbol() on mainnet == sMUSD" "sMUSD" "$vsym"
# ERC-4626 asset() must revert -> proves it is NOT 4626
a4626=$(jrpc "$MAIN_RPC" eth_call "[{\"to\":\"$VAULT\",\"data\":\"0x38d52e0f\"},\"latest\"]" \
        | python3 -c 'import sys,json;d=json.load(sys.stdin);print("reverts" if d.get("error") else "returns")')
chk "ERC-4626 asset() reverts (vault is NOT 4626)" "reverts" "$a4626"

echo
echo "=== 6. Reachability ==="
# "url:expected_status" — demo.vativ.io is x402-paywalled, so 402 IS the correct answer
for pair in "https://faucet.test.mezo.org:200" "https://testnet.mezo.org:200" \
            "https://demo.vativ.io:402" "https://explorer.test.mezo.org:200" \
            "https://explorer.mezo.org:200" "https://mezo.org/feature/borrow:200"; do
  u2="${pair%:*}"; want="${pair##*:}"
  s=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -L -A "$UA" "$u2")
  chk "HTTP $u2 (want $want)" "$want" "$s"
done

echo
echo "=== 7. SDK versions (npm) ==="
for p in "@x402/fetch" "@x402/evm" "@x402/express" "@x402/core" "@x402/paywall"; do
  v=$(curl -s -m 30 -A "$UA" "https://registry.npmjs.org/$p" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("dist-tags",{}).get("latest","?"))' 2>/dev/null)
  printf '  INFO  %-52s %s\n' "$p latest" "$v"
done
printf '  NOTE  Mezo testnet needs @x402/evm >= 2.10.0; mainnet >= 2.15.0\n'

echo
echo "=== RESULT: $pass passed, $fail failed ==="
[ "$fail" -eq 0 ] && echo "Environment matches DEPLOYMENT-BRIEF.md." || echo "Re-read the brief; something moved."
exit "$fail"
