# Akamai v3 Deobfuscator

This repository contains script for deobfuscating Akamai Sensor v3 JavaScript. The tool focuses on reversing obfuscation patterns such as control-flow flattening, stub functions, encoded arrays, and runtime-generated values.

Both Akamai script flavours are handled by the same command, the input type is detected automatically.

---

## Disclaimer

This project is provided for **educational and research purposes only**.  The author accepts no responsibility for any misuse of this code. Use it at your own risk.

---

## Install dependencies

```bash
npm install
```

---

## Usage

Run the deobfuscator with:

```bash
node run.js <input_file> <output_file> [--vm=dec|asm|both|none]
```

Every embedded VM program is decompiled and written as a comment above the statement that invokes it. `--vm` picks the view: `dec` (pseudo-JavaScript, default), `asm` (disassembly), `both`, or `none` to skip the step.

The decompiler (`src/vm/`) can also be run on an already deobfuscated file:

```bash
node src/vm/extract-vm.js <deobfuscated_file> [--asm|--dec|--both|--list]
```


