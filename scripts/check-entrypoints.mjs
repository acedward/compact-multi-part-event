// Import the built codec entry point (`npm run build` first) and record every module
// Node resolves while loading it. The codec must reach only Node built-ins and its
// own files: no ledger, runtime, wallet, network, prover or generated contract code.
import { registerHooks } from "node:module";

const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.push(result.url);
    return result;
  },
});

const entry = new URL("../dist/codec/index.js", import.meta.url);
const codecDir = new URL("../dist/codec/", import.meta.url).href;
await import(entry.href);

const outside = resolved.filter((url) => !url.startsWith("node:") && !url.startsWith(codecDir));
if (outside.length > 0) {
  console.error(`codec entry point loaded modules outside dist/codec/:\n${outside.join("\n")}`);
  process.exit(1);
}
console.log(
  `codec entry point loaded ${String(resolved.length)} modules, all node: built-ins or dist/codec/`,
);
