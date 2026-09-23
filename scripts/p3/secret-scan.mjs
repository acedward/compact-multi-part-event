// P3 secret scan (P3.9): count occurrences of the run's secrets in the files that were
// written, WITHOUT printing any secret or any match. Only counts and file names are shown.
//
// usage: node scripts/p3/secret-scan.mjs --mnemonic <file> --witness <file>...
//          --signing-key <file>... --scan <file or directory>...
//
// Needles, all derived in memory: the normalized mnemonic phrase and its BIP-39 seed
// (hex, upper-case hex, base64, raw bytes); each 32-byte witness secret and each
// maintenance signing key (hex, upper-case hex, base64, raw bytes). Every scanned file is
// also checked for runs of 12 or more consecutive English BIP-39 words.
import { Buffer } from "node:buffer";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const argv = process.argv.slice(2);
const lists = { mnemonic: [], witness: [], "signing-key": [], scan: [] };
let current;
for (const item of argv) {
  if (item.startsWith("--")) {
    current = item.slice(2);
    if (!(current in lists)) throw new Error(`unknown option ${item}`);
  } else if (current !== undefined) {
    lists[current].push(item);
  }
}

const needles = [];
const addBytes = (label, bytes) => {
  const hex = Buffer.from(bytes).toString("hex");
  needles.push({ label: `${label} (raw bytes)`, bytes: Buffer.from(bytes) });
  needles.push({ label: `${label} (hex)`, bytes: Buffer.from(hex) });
  needles.push({ label: `${label} (upper-case hex)`, bytes: Buffer.from(hex.toUpperCase()) });
  needles.push({
    label: `${label} (base64)`,
    bytes: Buffer.from(Buffer.from(bytes).toString("base64")),
  });
};
for (const [index, file] of lists.mnemonic.entries()) {
  const phrase = readFileSync(file, "utf8").trim().split(/\s+/u).join(" ").toLowerCase();
  needles.push({ label: `mnemonic ${String(index)} (phrase)`, bytes: Buffer.from(phrase) });
  const words = phrase.split(" ");
  // Any 4 consecutive words of the phrase (catches partial copies).
  for (let start = 0; start + 4 <= words.length; start += 1) {
    needles.push({
      label: `mnemonic ${String(index)} (4-word window)`,
      bytes: Buffer.from(words.slice(start, start + 4).join(" ")),
    });
  }
  addBytes(`mnemonic ${String(index)} seed`, mnemonicToSeedSync(phrase));
}
for (const [index, file] of lists.witness.entries()) {
  addBytes(
    `witness secret ${String(index)}`,
    Buffer.from(readFileSync(file, "utf8").trim(), "hex"),
  );
}
for (const [index, file] of lists["signing-key"].entries()) {
  const { value } = JSON.parse(readFileSync(file, "utf8"));
  addBytes(`signing key ${String(index)}`, Buffer.from(value, "hex"));
}

const english = new Set(wordlist);
const files = [];
const walk = (path) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name === ".git" || name === ".cache") continue;
      walk(join(path, name));
    }
  } else if (stats.isFile()) {
    files.push(path);
  }
};
for (const root of lists.scan) walk(root);

const count = (haystack, needle) => {
  let found = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found += 1;
  }
  return found;
};
const perLabel = new Map();
const flagged = [];
let wordRuns = 0;
for (const file of files) {
  const content = readFileSync(file);
  let hits = 0;
  for (const needle of needles) {
    const found = count(content, needle.bytes);
    if (found > 0) {
      hits += found;
      const kind = needle.label.replace(/ \d+ /u, " ");
      perLabel.set(kind, (perLabel.get(kind) ?? 0) + found);
    }
  }
  let run = 0;
  let longest = 0;
  for (const word of content
    .toString("latin1")
    .toLowerCase()
    .split(/[^a-z]+/u)) {
    if (word === "") continue;
    run = english.has(word) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  if (longest >= 12) wordRuns += 1;
  if (hits > 0 || longest >= 12) {
    flagged.push({ file, secretOccurrences: hits, longestBip39WordRun: longest });
  }
}

console.log(
  JSON.stringify(
    {
      scannedFiles: files.length,
      needleKinds: [...new Set(needles.map((needle) => needle.label.replace(/ \d+ /u, " ")))]
        .length,
      secretOccurrences: [...perLabel.values()].reduce((a, b) => a + b, 0),
      occurrencesByKind: Object.fromEntries(perLabel),
      filesWithBip39WordRunsOf12OrMore: wordRuns,
      flaggedFiles: flagged,
    },
    null,
    2,
  ),
);
process.exit(flagged.length === 0 ? 0 : 1);
