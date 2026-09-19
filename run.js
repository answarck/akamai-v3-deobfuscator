#!/bin/node

import deobfuscate from "./src/deobfuscator.js";
import fs from "fs";

const VM_MODES = ["dec", "asm", "both", "none"];

function help() {
  console.error("Usage: node run.js <input_file> <output_file> [--vm=dec|asm|both|none]");
  console.error("  --vm  view of the embedded VM programs written as comments above each");
  console.error("        invocation: dec (pseudo-JavaScript, default), asm (disassembly),");
  console.error("        both, or none to skip the VM step");
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
let vm = "dec";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--vm=")) vm = a.slice("--vm=".length);
  else if (a === "--vm") vm = args[++i];
  else if (a.startsWith("--")) help();
  else positional.push(a);
}
if (!VM_MODES.includes(vm)) help();

try {
  if (positional.length !== 2) help();

  const [input, output] = positional;

  if (!input || !output) help();
  if (!fs.existsSync(input)) help();

  const result = deobfuscate(input, { vm });

  if (typeof result !== "string") help();

  fs.writeFileSync(output, result);
  console.log("[deobfuscation] Completed");
  console.log(`[deobfuscation] File saved to ${output}`);
} catch {
  help();
}
