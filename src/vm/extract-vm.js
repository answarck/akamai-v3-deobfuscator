// =============================================================================
// extract-vm.js — find every embedded "CS" VM program in a deobfuscated Akamai
// script and disassemble / decompile each one.
// (integrated from the standalone akamai-vm-decompiler project)
//
// The script invokes a program as
//
//     <vm>["k"](<target>, "<base64 bytecode>", <magic>)
//
// where the method name differs per build (`k`, `Z`, `R`, `o`, …). Programs
// are located in the AST by that call shape, the build's own opcode table is
// derived from the script text (analyze-vm.js) and each program is run through
// vm-decompiler.js.
//
// Also usable on its own against an already deobfuscated file:
//   node src/vm/extract-vm.js <file> [--asm|--dec|--both] [--list]
// =============================================================================

import fs from "fs";
import { pathToFileURL } from "url";
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import { deriveTable } from "./analyze-vm.js";
import { decodeProgram, disassemble, formatDisassembly, decompile } from "./vm-decompiler.js";

const traverse = traverseModule.default;

// Below this many resolved opcodes the derived table is unusable and the
// "decompilation" would be noise (every byte reads as RET).
export const MIN_OPCODES = 30;

const B64_RE = /^[A-Za-z0-9+/=]{32,}$/;

function memberText(callee) {
  const obj = callee.object.name;
  const p = callee.property;
  if (!callee.computed) return `${obj}.${p.name}`;
  if (t.isStringLiteral(p)) return `${obj}[${JSON.stringify(p.value)}]`;
  if (t.isNumericLiteral(p)) return `${obj}[${p.value}]`;
  if (t.isIdentifier(p)) return `${obj}[${p.name}]`;
  return `${obj}[…]`;
}

// Every VM invocation in `ast`, in source order. Each entry carries the path of
// the enclosing statement so a caller can attach the result next to it.
export function findPrograms(ast) {
  const programs = [];
  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object)) return;
      if (args.length !== 3) return;
      const [target, b64, magic] = args;
      if (!t.isIdentifier(target) || !t.isStringLiteral(b64) || !t.isNumericLiteral(magic)) return;
      if (!B64_RE.test(b64.value)) return;
      const statement = path.getStatementParent();
      if (!statement) return;
      programs.push({
        index: programs.length,
        line: path.node.loc?.start.line ?? null,
        callee: memberText(callee),
        target: target.name,
        b64: b64.value,
        magic: magic.value,
        statement,
      });
    },
  });
  return programs;
}

// One decoded program in the requested view: "dec" (pseudo-JavaScript, the
// default), "asm" (linear disassembly) or "both".
export function renderProgram(prog, mode = "dec") {
  const parts = [];
  if (mode === "asm" || mode === "both") parts.push(formatDisassembly(prog, disassemble(prog)));
  if (mode === "both") parts.push("", "--- decompiled ---");
  if (mode === "dec" || mode === "both") parts.push(decompile(prog));
  return parts.join("\n");
}

// Decompile every program in `ast`. `source` is the script text the AST
// corresponds to; the opcode table is derived from it. Programs are always
// listed (bytes / checksum / LO); `text` is only set when the table is usable.
export function decompilePrograms(ast, source, mode = "dec") {
  const programs = findPrograms(ast);
  if (programs.length === 0) return { programs, table: null, resolved: 0 };

  const table = deriveTable(source);
  const resolved = Object.keys(table.ops).length;
  for (const p of programs) {
    const prog = decodeProgram(p.b64, p.magic, table);
    p.bytes = prog.bytes.length;
    p.checksum = prog.checksum;
    p.LO = prog.LO;
    if (resolved < MIN_OPCODES) continue;
    try {
      p.text = renderProgram(prog, mode);
    } catch (err) {
      p.error = err.message;
    }
  }
  return { programs, table, resolved };
}

export function programHeader(p) {
  return `VM program #${p.index}: ${p.callee}(${p.target}, …)  magic=${p.magic}  bytes=${p.bytes}  checksum=0x${p.checksum.toString(16)}  LO=${p.LO}`;
}

// ---- CLI --------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: node src/vm/extract-vm.js <file> [--asm|--dec|--both] [--list]");
    process.exit(1);
  }
  const src = fs.readFileSync(file, "utf-8");
  const ast = parser.parse(src, { errorRecovery: true });
  const mode = args.includes("--asm") ? "asm" : args.includes("--both") ? "both" : "dec";
  const { programs, table, resolved } = decompilePrograms(ast, src, mode);
  if (programs.length && resolved < MIN_OPCODES) {
    console.error(`[extract-vm] warning: only ${resolved} opcodes resolved — table may be incomplete`);
  }

  if (args.includes("--list")) {
    console.log(`# ${programs.length} VM program(s) in ${file}   (qJ=${table?.qJ ?? "?"}, ${resolved} opcodes derived)`);
    for (const p of programs) {
      console.log(`  [${p.index}] line ${p.line}  call=${p.callee}  target=${p.target}  magic=${p.magic}  bytes=${p.bytes}`);
    }
    return;
  }
  for (const p of programs) {
    console.log("\n// ========================================================================");
    console.log(`// ${programHeader(p)}`);
    console.log("// ========================================================================");
    console.log(p.text ?? `// ${p.error ?? "decompilation skipped: opcode table could not be derived from this build"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
