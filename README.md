# Akamai v3 Deobfuscator

This repository contains script for deobfuscating Akamai Sensor v3 JavaScript. The tool focuses on reversing obfuscation patterns such as control-flow flattening, stub functions, encoded arrays, and runtime-generated values. And also this script doesn't account for VM based obfuscation, I'm working on that.

---

## Install dependencies

```bash
npm install
```

---

## Usage

Run the deobfuscator with:

```bash
node run.js <input_file> <output_file>
```

---

## VM decompiler

Part of the sensor's logic is compiled to bytecode for an embedded stack machine
and shipped as base64. After deobfuscation these appear as:

```js
var fqj = new CS();
fqj["k"](target, "BwAAAjXIBwAAANzILQ…", 168);   // CS().k(target, bytecode, magic)
```

[src/vm-decompiler.cjs](src/vm-decompiler.cjs) reverses that VM: it reproduces
the per-program opcode mapping, disassembles the instruction stream, and runs an
abstract stack interpreter to reconstruct readable pseudo-JavaScript (functions,
`try/catch/finally`, loops, member calls, short-circuits, ternaries). The VM is
documented in [VM.md](VM.md).

### Dynamic by design

The sensor is re-generated on every fetch: identifiers, the numeric opcode ids,
the modulus `qJ`, the magic number and even the invocation method name (`k`,
`R`, …) all change, and different builds ship different operation *sets* (one
build has bitwise `^`/`>>>` opcodes, another has `typeof`/`||`). So the opcode
table is **not hard-coded** — [src/analyze-vm.cjs](src/analyze-vm.cjs) derives it
from each file by structural analysis: it resolves the operator-helper functions
and operand readers, evaluates the file's own constant block, and classifies
every opcode handler. `extract-vm.cjs` runs this automatically.

```bash
# inspect the derived opcode table for a file
node src/analyze-vm.cjs src/delta.js

# find + decompile every embedded program (table auto-derived from the file)
node src/extract-vm.cjs src/delta.js --list
node src/extract-vm.cjs src/delta.js --dec            # all programs
node src/extract-vm.cjs src/delta.js --index 10 --asm # one program, disassembly
node src/extract-vm.cjs src/delta.js --both           # disassembly + decompilation

# decompile a single base64 program; --from derives the table from that build
node src/vm-decompiler.cjs "<base64>" <magic> --from src/delta.js
node src/vm-decompiler.cjs "<base64>" <magic>          # original reference build
```

Example output — an anti-debug timing/challenge routine:

```js
try {
  if ((document.createElement("p").nodeType !== undefined)) goto L11;  // hook check
  // L11:
  IK.setCv((7 * (((IK.getCv() % 1001234) + 17 + ("0x" + IK.getCc().substring(1, 7))) - 11 - …)));
} catch (err) {
  IK.setCv((IK.getCv() + 76));
  IK.setCd(IK.getCd() ? IK.getCd() : (IK.getCd() + "err#"));
} finally { … }
```

> Branches the structurer can't fold are kept as labelled `goto` / `if (…) goto`
> so the output never misrepresents control flow; values living across a branch
> are shown as `st<n>` temporaries.


