#!/bin/node

import deobfuscate from "./src/deobfuscator.js";
import fs from "fs";

const [, , ...args] = process.argv;

function help() {
  console.error("Usage: node run.js <input_file> <output_file>");
  process.exit(1);
}

try {
  if (args.length !== 2) help();

  const [input, output] = args;

  if (!input || !output) help();
  if (!fs.existsSync(input)) help();

  const result = deobfuscate(input);

  if (typeof result !== "string") help();

  fs.writeFileSync(output, result);
  console.log("[deobfuscation] Completed");
  console.log(`[deobfuscation] File saved to ${output}`);
} catch {
  help();
}