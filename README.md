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


