#!/usr/bin/env python3
"""P3 evidence manifest: build evidence/stagenet/manifest.json and live-section.md from the
public evidence files of the 2026-09-23 stagenet run (Python standard library only).

usage: python3 scripts/p3/manifest.py [<evidence/stagenet dir>]

Everything read here is public (addresses, hashes, raw transaction bytes, events, logs
with public identifiers). Event names are kept as hex; nothing is decoded to ASCII.
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

E = Path(sys.argv[1] if len(sys.argv) > 1 else "evidence/stagenet")
SPECK_PER_DUST = 10**15
NODE = "https://rpc.stagenet.shielded.tools"
INDEXER = "https://indexer.stagenet.shielded.tools/api/v4/graphql"
EMITTER = "6240fbd956523c6f9a2feb78c0e72e63fba53a03486c5deac8c346ce51d23436"
CONSUMER = "cf12a32260fd443d0c1d6fce6316bd420fe850a278076e872834e35016c8d7ef"


def load(path):
    return json.loads((E / path).read_text())


def dust(speck):
    speck = int(speck)
    return f"{speck // SPECK_PER_DUST}.{speck % SPECK_PER_DUST:015d}"


def ts(text):
    return datetime.strptime(text[:23] + "Z", "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def log_marks(path):
    """First timestamp of each CLI progress line (host clock)."""
    marks = {}
    for line in (E / path).read_text().splitlines():
        match = re.match(r"^(\d{4}-\d\d-\d\dT[\d:.]+Z) (\S.*)$", line)
        if not match:
            continue
        stamp, text = match.groups()
        key = text.split("  ")[0].strip()
        marks.setdefault(key, stamp)
    return marks


def seconds(marks, start, end):
    if start in marks and end in marks:
        return round((ts(marks[end]) - ts(marks[start])).total_seconds(), 1)
    return None


def proofs(marks):
    """/prove request durations (proof-server log) that ended between build and finalize."""
    if "built" not in marks or "finalized" not in marks:
        return []
    start, end = ts(marks["built"]), ts(marks["finalized"])
    out = []
    for line in (E / "logs/proof-server-all.log").read_text().splitlines():
        match = re.match(r"^(\S+Z) .*POST /prove HTTP/1.1; took ([\d.]+)s", line)
        if match and start <= ts(match.group(1)[:23] + "Z") <= end:
            out.append(round(float(match.group(2)), 2))
    return out


declared = {row["transaction"]: row for row in load("fees/declared-dust-fees.json")["rows"]}


def tx_summary(tx_hash, contract=None):
    tx = load(f"transactions/{tx_hash}.json")
    raw = (E / f"transactions/{tx_hash}.hex").read_text().strip()
    out = {
        "hash": tx["hash"],
        "identifiers": tx["identifiers"],
        "status": tx["transactionResult"]["status"],
        "segments": tx["transactionResult"]["segments"],
        "block": {
            "height": tx["block"]["height"],
            "hash": tx["block"]["hash"],
            "timestamp": tx["block"]["timestampIso"],
        },
        "bytes": tx["rawBytes"],
        "rawSha256": hashlib.sha256(bytes.fromhex(raw)).hexdigest(),
        "rawFile": f"transactions/{tx_hash}.hex",
        "contractActions": tx["contractActions"],
        "fees": {
            "requiredSpeck": tx["fees"]["paidFees"],
            "requiredDust": dust(tx["fees"]["paidFees"]),
            "estimatedSpeck": tx["fees"]["estimatedFees"],
            "declaredDustSpendSpeck": declared[tx_hash]["declaredFeeSpeck"],
            "declaredDustSpendDust": declared[tx_hash]["declaredFeeDust"],
            "note": "required = indexer fees.paidFees; declared = the DUST spend's vFee the wallet declared (and the ledger consumed), see Q28",
        },
        "node": {
            "chain_getBlock": NODE,
            "rawBytesFoundInBlock": tx["nodeCrossCheck"]["rawBytesFoundInBlock"],
            "extrinsicIndex": tx["nodeCrossCheck"]["extrinsicIndex"],
        },
        "finality": tx["finality"],
    }
    if contract is not None:
        events = load(f"events/{tx_hash}.json")
        out["events"] = {
            "file": f"events/{tx_hash}.json",
            "contract": contract,
            "count": events["count"],
            "ids": [event["id"] for event in events["events"]],
        }
    return out


def verification(label):
    path = E / f"verify/{label}.json"
    if not path.exists():
        return None
    report = json.loads(path.read_text())
    log = (E / f"verify/{label}.log").read_text().splitlines()
    return {
        "command": log[0][2:] if log and log[0].startswith("$ ") else None,
        "levelReached": report["level"],
        "requestedLevel": report["requestedLevel"],
        "exitStatus": int(log[-1].split()[-1]) if log and log[-1].startswith("exit status") else None,
        "log": f"verify/{label}.log",
        "report": f"verify/{label}.json",
        "offline": {
            "command": None,
            "log": None,
        },
    }


def message(label):
    hex_text = (E / f"messages/{label}.hex").read_text().strip()
    data = bytes.fromhex(hex_text)
    return {"file": f"messages/{label}.hex", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


vectors = {"m1": "fcde97e961102a0617cdf6d4628d58d425326b6ff634585e130c9a2509da071b",
           "m2": "08028167802fb109b91bd7686d14d91e5f0120a73d516c31ab2514feeb33d208"}

publications = []
for label, record_file, contract, kind, message_label, verify_label, offline_label, prover_log in [
    ("M1", "publications/m1.json", EMITTER, "emitter", "m1", "m1", "offline-m1", "logs/proof-server-deploy-emitter-and-m1.log"),
    ("M2", "publications/m2.json", EMITTER, "emitter", "m2", "m2", "offline-m2", "logs/proof-server-m2.log"),
    ("M3 (M1 again)", "publications/m3.json", EMITTER, "emitter", "m1", "m3", None, "logs/proof-server-m3.log"),
    ("Consumer M1", "publications/consumer-m1.json", CONSUMER, "consumer", "m1", "consumer-m1", "offline-consumer-m1", "logs/proof-server-consumer-m1.log"),
]:
    saved = load(record_file)
    record = saved["record"]
    tx_hash = saved["inclusion"]["hash"]
    log_file = {"M1": "logs/publish-m1.log", "M2": "logs/publish-m2.log", "M3 (M1 again)": "logs/publish-m3.log",
                "Consumer M1": "logs/publish-consumer-m1.log"}[label]
    marks = log_marks(log_file)
    item = {
        "label": label,
        "kind": kind,
        "contract": contract,
        "message": message(message_label),
        "parts": len(record["tailsHex"]),
        "requestId": record["requestIdHex"],
        "requestIdEqualsGoldenVector": record["requestIdHex"] == vectors.get(message_label, record["requestIdHex"]),
        "segment": record["segment"],
        "intentHash": record["intentHash"],
        "pinnedBlock": {"height": record["blockHeight"], "hash": record["blockHash"]},
        "ttl": record["ttl"],
        "finalizedRecord": record_file,
        "savedFinalizedBytesEqualOnChain": saved["inclusion"]["rawHex"] == record["transactionHex"],
        "mergedByOthers": saved["merged"],
        "cliVerifiedFromRawBytes": saved["verified"],
        "normalizedCostLive": saved["normalizedCost"],
        "transaction": tx_summary(tx_hash, contract),
        "timingsSeconds": {
            "walletSyncRestored": seconds(marks, "opening wallet", "wallet synced"),
            "build": seconds(marks, "wallet synced", "built"),
            "finalize(prove+balance)": seconds(marks, "built", "finalized"),
            "proveRequestsSeconds (emitPart proofs, then the DUST-spend proof)": proofs(marks),
            "submitReturnedAfter": seconds(marks, "finalized", "submitted"),
            "indexerSawItAfterSubmitReturn": seconds(marks, "submitted", "included"),
            "clock": "host clock; chain block timestamps run ~14 s behind",
        },
        "cliLog": log_file,
        "verification": verification(verify_label),
    }
    if offline_label:
        offline = verification(offline_label)
        item["verification"]["offline"] = {"command": offline["command"], "levelReached": offline["levelReached"],
                                           "exitStatus": offline["exitStatus"], "log": offline["log"]}
    publications.append(item)

merge = load("q26/merge-sealed-live.json")
q26 = {
    "question": "Q26: can intents be added to an already sealed (proven, bound) transaction, and does stagenet accept it?",
    "answer": "yes: two fee-less sealed publications were merged, the wallet added a fee intent after sealing, and stagenet included the result with status SUCCESS",
    "record": "q26/merge-sealed-live.json",
    "dryRuns": ["q26/merge-sealed-dry-run-attempt1-guard.json", "q26/merge-sealed-dry-run-attempt2-validate.json", "q26/merge-sealed-dry-run.json"],
    "sealed": {
        key: {
            "message": message("q26-a" if key == "A" else "q26-b"),
            "parts": merge[src]["parts"],
            "requestId": merge[src]["requestIdHex"],
            "segment": merge[src]["segment"],
            "sealedTransactionHash": merge[src]["transactionHash"],
            "identifiers": merge[src]["identifiers"],
            "intentHash": merge[src]["intentHash"],
            "sealedBytes": len(merge[src]["transactionHex"]) // 2,
            "verification": verification("q26-a" if key == "A" else "q26-b"),
        }
        for key, src in (("A", "sealedA"), ("B", "sealedB"))
    },
    "mergedWithoutFee": {k: merge["merged"][k] for k in ("transactionHash", "identifiers", "segments")},
    "final": {k: merge["final"][k] for k in ("transactionHash", "identifiers", "segments", "bytes", "normalizedCost")},
    "offlineChecks": merge["checks"],
    "advisories": merge["advisories"],
    "timingsMs": merge["timings"],
    "transaction": tx_summary(merge["inclusion"]["hash"], EMITTER),
    "onChainBytesEqualSubmitted": merge["inclusion"]["rawEqualsSubmitted"],
    "containment": merge["contained"],
    "locatePublication": merge["locatePublication"],
    "verification": verification("q26-merged-both"),
    "decisions": ["Q27 (guard refuses same-emitter calls in another intent; by design)"],
}

deploy_e = load("deploy-emitter.json")
deploy_c = load("deploy-consumer.json")
state_e = load("contracts/emitter-state-after-deploy.json")["data"]["contract"]
state_c = load("contracts/consumer-state-after-deploy.json")["data"]["contract"]


def contract_entry(label, deploy, state, log_file):
    return {
        "label": label,
        "address": deploy["address"],
        "access": deploy["access"],
        "operations": deploy["operations"],
        "verifierKeySha256": deploy["verifierKeySha256"],
        "maintenanceAuthority": {
            "threshold": state["maintenanceAuthority"]["threshold"],
            "counter": state["maintenanceAuthority"]["counter"],
            "committee": state["maintenanceAuthority"]["committee"],
            "recordedVerifyingKey": deploy["maintenanceVerifyingKey"],
        },
        **({"emitterAuthority": deploy["emitterAuthority"]} if "emitterAuthority" in deploy else {}),
        "addressRecordedBeforeSubmission": True,
        "cliStage": deploy["stage"],
        "record": "deploy-emitter.json" if label == "reference emitter" else "deploy-consumer.json",
        "stateAfterDeploy": "contracts/emitter-state-after-deploy.hex" if label == "reference emitter" else "contracts/consumer-state-after-deploy.hex",
        "deployTransaction": tx_summary(deploy["inclusion"]["hash"]),
        "pinnedBlock": {"height": deploy["finalized"]["blockHeight"], "hash": deploy["finalized"]["blockHash"]},
        "cliLog": log_file,
    }


register = load("register-consumer-m1.json")
release = load("release-consumer-m1.json")
funding_before = load("wallet/funding-2026-09-23T1407Z.json")
limit = load("live-limit/fit.json")
rejections = load("rejections/local-stages.json")
replay = load("rejections/replay-m3.json")
params = load("ledger-parameters/latest-block.json")["data"]["block"]
params_bytes = bytes.fromhex(params["ledgerParameters"])
probe = load("probe/node-rpc.json")

manifest = {
    "schema": "compact-multi-segment-emit/stagenet-evidence/1",
    "run": "P3 live stagenet demonstration, 2026-09-23 (UTC)",
    "network": {
        "name": "stagenet",
        "rpc": NODE,
        "indexer": INDEXER,
        "indexerWs": "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
        "system_version": probe["system_version"]["result"],
        "system_chain": probe["system_chain"]["result"],
        "midnight_ledgerVersion": probe["midnight_ledgerVersion"]["result"],
        "specVersion": probe["state_getRuntimeVersion.specVersion"],
        "probe": "probe/node-rpc.json",
        "ledgerParameters": {
            "block": params["height"],
            "blockHash": params["hash"],
            "bytes": len(params_bytes),
            "sha256": hashlib.sha256(params_bytes).hexdigest(),
            "hex": f"ledger-parameters/{params['height']}.hex",
            "text": f"ledger-parameters/{params['height']}.txt",
            "blockLimits": {"read_time": "2 s", "compute_time": "2 s", "block_usage": 1000000, "bytes_written": 50000, "bytes_churned": 50000000},
            "transaction_byte_limit": 1048576,
        },
    },
    "source": {
        "repository": "https://github.com/acedward/compact-multi-segment-emit",
        "commit": "c4b9b75f705a7409d7b7817d8243bcc61a19e5ad",
        "branch": "p3-stagenet (worktree); the library and CLI code used were exactly this commit (P3 added only scripts/p3/ and evidence/)",
        "dirtyDuringRun": False,
        "fixesAfterTheRun": [
            "81ae288 CLI: flush stdout and stderr before exiting (a --json report above 64 KiB was cut; no recorded result depends on it: records were written with --out/--record-out)"
        ],
    },
    "toolchain": {
        "compactc": "0.34.0 (runtime 0.19.0, ledger-9.1.0.0-rc.3, zkir-v3 3.0.0-rc.2, --feature-zkir-v3)",
        "@midnight-ntwrk/compact-runtime": "0.19.0",
        # The live run of 2026-09-23 used Yarn at c4b9b75; the repository moved to npm afterwards.
        "@midnightntwrk/ledger-v9": "1.0.0-rc.3 (single copy, yarn why)",
        "@midnightntwrk/onchain-runtime-v4": "4.0.0-rc.3",
        "midnight-js": "5.0.0-beta.7 (types, http-client-proof-provider, node-zk-config-provider)",
        "wallet-sdk-facade": "5.0.0-beta.2 (shielded/unshielded 4.0.0-beta.2, dust 5.0.0-beta.2, abstractions 3.0.0-beta.0, hd 3.1.0-beta.1)",
        "node": "node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 (Node 24.21.0), Yarn 4.17.1",
        "proofServer": {
            "image": "midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b",
            "platform": "linux/arm64 (image id sha256:38a819ea...)",
            "version": "9.0.0-rc.6", "proofVersions": ["V2", "V3"],
            "mode": "parameter fetching on (downloaded and verified k=10..15 and the Zswap/DUST keys from https://srs.midnight.network/), job capacity 32, published on 127.0.0.1 only",
            "log": "logs/proof-server-all.log",
        },
        "decisions": "Q19 (SDK set), Q20 (explicit ContractDeploy), Q24/Q25 (sync, cache), Q27, Q28",
    },
    "circuits": {
        "note": "K/rows provisional (Q16); verifier keys are the committed ones (scripts/keys.sh verify reproduced them in this run's baseline check)",
        "emitter": {"emitPart": {"k": 17, "rows": 86450, "verifierSha256": deploy_e["verifierKeySha256"]["emitPart"]},
                    "sha256sums": "contracts/keys/emitter/SHA256SUMS"},
        "consumer": {"k/rows": {"emitPart": "17/86473", "register1": "14/12038", "register2": "15/20089", "register3": "15/26292",
                                "register5": "16/40546", "announce": "13/3986", "release": "13/3979"},
                     "verifierSha256": deploy_c["verifierKeySha256"], "sha256sums": "examples/consumer/keys/SHA256SUMS"},
    },
    "wallet": {
        "unshieldedAddress": funding_before["identity"]["unshieldedAddress"],
        "shieldedAddress": funding_before["identity"]["shieldedAddress"],
        "dustAddress": funding_before["identity"]["dustAddress"],
        "coinPublicKey": funding_before["identity"]["coinPublicKey"],
        "before": {"at": "2026-09-23T14:07:24Z", "nightStar": funding_before["balances"]["night"], "dustSpeck": funding_before["balances"]["dust"],
                   "dustRegisteredUtxos": sum(1 for u in funding_before["balances"]["nightUtxos"] if u["registeredForDustGeneration"]),
                   "firstCompleteSyncSeconds": 100, "report": "wallet/funding-2026-09-23T1407Z.json"},
        "after": {"at": "2026-09-23T14:47:28Z", "nightStar": "10000000000", "dustSpeck": "44522585945802522094"},
        "restoredSyncSeconds": 15,
    },
    "contracts": [
        contract_entry("reference emitter", deploy_e, state_e, "logs/deploy-emitter.log"),
        contract_entry("consumer (MessageRegistry)", deploy_c, state_c, "logs/deploy-consumer.log"),
    ],
    "publications": publications,
    "registration": {
        "contract": CONSUMER, "circuit": register["circuit"], "requestId": register["requestId"], "parts": register["parts"],
        "ownerCommitment": register["ownerCommitment"], "record": "register-consumer-m1.json",
        "transaction": tx_summary(register["inclusion"]["hash"], CONSUMER),
        "note": "its own transaction, 15 blocks before the consumer publication; the CLI checked the public registry entry after inclusion",
    },
    "release": {
        "contract": CONSUMER, "circuit": "release", "requestId": release["requestId"], "record": "release-consumer-m1.json",
        "transaction": tx_summary(release["inclusion"]["hash"], CONSUMER),
        "registryHoldsRequestAfter": release["registryHoldsRequestAfter"],
    },
    "q26Merge": q26,
    "liveLimit": {
        "binding": limit["binding"],
        "computedLiveFitParts": limit["computedLiveFitParts"],
        "perDimension": limit["perDimension"],
        "size": limit["size"],
        "points": [{"parts": p["parts"], "bytes": p["bytes"], "normalized": p["recomputed"], "file": p["file"].replace("/evidence/", "")} for p in limit["points"]],
        "largestSubmittedParts": 5,
        "largestProvenAndBalancedParts": 33,
        "dryRuns": {"8 parts": "live-limit/dry-8parts.json", "33 parts": "live-limit/dry-33parts.json"},
        "note": "33 parts is the one-block fit under LedgerParameters.initialParameters(); stagenet's block_usage limit is 5x larger",
    },
    "rejections": {
        "record": "rejections/local-stages.json",
        "allPass": rejections["allPass"],
        "submittedAnything": rejections["submittedAnything"],
        "cases": [{"label": c["label"], "expectedStage": c.get("expectedStage"), "observed": c.get("message") or c.get("results"), "pass": c["pass"]} for c in rejections["cases"]],
        "replay": {"record": "rejections/replay-m3.json", "replayed": replay["replayedTransactionHash"], "ttl": replay["ttl"],
                   "attemptedAt": replay["attemptedAt"], "refused": replay["outcome"]["refused"],
                   "nodeAnswer": "RpcError: 1012: Transaction is temporarily banned",
                   "indexerCopiesAfter": replay["indexerCopiesAfter"],
                   "note": "the node refused the replay at submission; nothing was included, no fee; this is not a rollback"},
    },
    "walletFreeVerification": {
        "runLog": "verify/run.log",
        "script": "scripts/p3/verify-all.sh",
        "environment": "fresh Docker volumes, clean public clone at c4b9b75, no secret mounted, no CMSE_* variable",
        "negative": verification("negative-m1-tx-at-consumer"),
    },
    "totals": {
        "transactions": 9,
        "requiredFeesDust": dust(sum(int(load(f"transactions/{h}.json")["fees"]["paidFees"]) for h in declared)),
        "declaredDustConsumed": load("fees/declared-dust-fees.json")["totalDeclaredDust"],
        "feesFile": "fees/declared-dust-fees.json",
    },
}
(E / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

# ---------------------------------------------------------------------------------------
# README "Live on stagenet" material
# ---------------------------------------------------------------------------------------
rows = []
for p in publications:
    t = p["transaction"]
    rows.append(
        f"| {p['label']} | `{p['contract'][:8]}…` | {p['message']['bytes']} B / {p['parts']} | `{p['requestId'][:16]}…` | "
        f"`{t['hash']}` | {t['block']['height']} | {', '.join(str(i) for i in t['events']['ids'])} | "
        f"{float(t['fees']['requiredDust']):.4f} / {float(t['fees']['declaredDustSpendDust']):.2f} |"
    )
t = q26["transaction"]
for key in ("A", "B"):
    s = q26["sealed"][key]
    rows.append(
        f"| Q26 merge {key} | `{EMITTER[:8]}…` | {s['message']['bytes']} B / {s['parts']} | `{s['requestId'][:16]}…` | "
        f"`{t['hash']}` | {t['block']['height']} | {', '.join(str(i) for i in t['events']['ids'])} (both) | "
        f"{float(t['fees']['requiredDust']):.4f} / {float(t['fees']['declaredDustSpendDust']):.2f} (both) |"
    )
lines = [
    "# Live on stagenet — material for the README section",
    "",
    "Generated by `scripts/p3/manifest.py` from the public evidence in this directory (run of 2026-09-23 UTC, node `"
    + manifest["network"]["system_version"] + "`, ledger parameters of block "
    + str(params["height"]) + "). Full data: `evidence/stagenet/manifest.json`.",
    "",
    "## Contracts",
    "",
    "| Contract | Address | Deploy transaction | Block | Verifier key (emitPart, SHA-256) |",
    "|---|---|---|---|---|",
]
for c in manifest["contracts"]:
    lines.append(
        f"| {c['label']} | `{c['address']}` | `{c['deployTransaction']['hash']}` | {c['deployTransaction']['block']['height']} | `{c['verifierKeySha256']['emitPart']}` |"
    )
lines += [
    "",
    "## Publications",
    "",
    "Fees: required (indexer `paidFees`) / DUST consumed (the wallet's declared fee with `feeBlocksMargin` 100, Q28), in DUST.",
    "",
    "| Publication | Contract | Size / parts | Request ID | Transaction | Block | Event ids | Fee required / consumed |",
    "|---|---|---|---|---|---|---|---|",
    *rows,
    "",
    f"Consumer registration (own, earlier transaction): `{manifest['registration']['transaction']['hash']}` (block {manifest['registration']['transaction']['block']['height']}); "
    f"owner-only release (later transaction): `{manifest['release']['transaction']['hash']}` (block {manifest['release']['transaction']['block']['height']}).",
    "",
    "M1 and M3 carry the same message: the same request ID, two separate complete groups in two transactions. "
    "Q26 merge: A and B were proven and bound without fees, merged, and a fee intent was added after sealing; stagenet included it with status SUCCESS.",
    "",
    f"Live one-block fit (FR-006): {limit['computedLiveFitParts']} parts computed (binding dimension: block usage, "
    f"{limit['perDimension']['blockUsage']['perPart']:.6f} of a block per part); largest submitted 5 parts; largest proven and balanced 33 parts (0.198 of a block).",
    "",
    "## Verify (no wallet, no secret)",
    "",
    "```sh",
]
for label in ("m1", "m2", "m3", "q26-a", "q26-b", "consumer-m1"):
    v = verification(label)
    lines.append(v["command"].replace("cmse verify", "node dist/cli/main.js verify"))
lines += [
    "```",
    "",
    "Each prints `verified up to level 3` and exits 0 (logs in `evidence/stagenet/verify/`). "
    "Offline, from the saved bytes: add `--raw-file evidence/stagenet/transactions/<hash>.hex --status SUCCESS --state-file evidence/stagenet/contracts/<contract>-state-after-deploy.hex` instead of the network lookup.",
    "",
]
(E / "live-section.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"publications": len(publications), "manifest": str(E / "manifest.json"), "liveSection": str(E / "live-section.md")}))
