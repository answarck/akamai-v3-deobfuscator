#!/usr/bin/env node
// =============================================================================
// extract-vm.cjs — find every embedded "CS" VM program in a (deobfuscated)
// Akamai sensor file and disassemble / decompile each one.
//
// It scans for the invocation idiom
//
//     <vm>["k"](<target>, "<base64 bytecode>", <magic>)
//     <vm>.k(<target>, "<base64 bytecode>", <magic>)
//
// and runs each program through src/vm-decompiler.cjs.
//
// Usage:
//   node src/extract-vm.cjs <file> [--asm|--dec|--both] [--index N] [--list]
//
//   --dec    (default) reconstructed pseudo-JavaScript
//   --asm    linear disassembly
//   --both   both views
//   --index  only process the Nth program (0-based)
//   --list   just list the programs found (index, line, target, magic, size)
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { decodeProgram, disassemble, formatDisassembly, decompile } = require('./vm-decompiler.cjs');

function findPrograms(src) {
  // Match the VM invocation by its signature rather than a fixed method name
  // (the method is `k` in some builds, `R` in others, …):
  //     <obj>["<method>"]( <target> , "<base64>" , <magic> )
  //     <obj>.<method>(    <target> , "<base64>" , <magic> )
  const re = /([A-Za-z0-9_$]+(?:\["[A-Za-z0-9_$]+"\]|\.[A-Za-z0-9_$]+))\(\s*([A-Za-z0-9_$]+)\s*,\s*"([A-Za-z0-9+/=]{32,})"\s*,\s*(\d+)\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ index: out.length, line, callee: m[1], target: m[2], b64: m[3], magic: +m[4] });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const flags = new Set(args.filter(a => a.startsWith('--') && !a.startsWith('--index')));
  const idxArg = args.find(a => a.startsWith('--index'));
  const only = idxArg ? parseInt((idxArg.split('=')[1] ?? args[args.indexOf(idxArg) + 1]), 10) : undefined;

  if (!file) {
    console.error('Usage: node src/extract-vm.cjs <file> [--asm|--dec|--both] [--index N] [--list]');
    process.exit(1);
  }
  const src = fs.readFileSync(path.resolve(file), 'utf8');
  let progs = findPrograms(src);
  if (only !== undefined && !Number.isNaN(only)) progs = progs.filter(p => p.index === only);

  // Derive this file's opcode table (opcode ids + qJ are re-randomised per build).
  const { deriveTable } = require('./analyze-vm.cjs');
  const table = deriveTable(src);
  const resolved = Object.keys(table.ops).length;
  if (resolved < 30) console.error(`[extract-vm] warning: only ${resolved} opcodes resolved — table may be incomplete`);

  if (flags.has('--list')) {
    console.log(`# ${progs.length} VM program(s) in ${file}   (qJ=${table.qJ}, ${resolved} opcodes derived)`);
    for (const p of progs) {
      const bytes = Buffer.from(p.b64, 'base64').length;
      console.log(`  [${p.index}] line ${p.line}  call=${p.callee}  target=${p.target}  magic=${p.magic}  bytes=${bytes}`);
    }
    return;
  }

  const mode = flags.has('--asm') ? 'asm' : flags.has('--both') ? 'both' : 'dec';
  for (const p of progs) {
    const prog = decodeProgram(p.b64, p.magic, table);
    console.log(`\n// ========================================================================`);
    console.log(`// program #${p.index}  (${path.basename(file)} line ${p.line})  target=${p.target}  magic=${p.magic}`);
    console.log(`// ========================================================================`);
    if (mode === 'asm' || mode === 'both') console.log(formatDisassembly(prog, disassemble(prog)));
    if (mode === 'both') console.log('\n// --- decompiled ---');
    if (mode === 'dec' || mode === 'both') console.log(decompile(prog));
  }
}

main();
