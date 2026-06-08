# The Akamai Sensor v3 `CS` Virtual Machine

Some of the most sensitive logic in the sensor is not emitted as JavaScript at
all. Instead it is compiled to bytecode for a small stack machine — the `CS`
class — and shipped as base64 strings:

```js
var fqj = new CS();
fqj["k"](M6j, "BwAAAjXIBwAAANzILQ…", 168);
```

`k(target, base64, magic)` loads and runs one VM program against `target` (the
object whose `getCv` / `setCv` / `getCd` / `signals` / … the program reads and
writes). This document describes the VM as reversed from `out.js`, and the
decompiler in [src/vm-decompiler.cjs](src/vm-decompiler.cjs) implements it.

## Loading a program (`k` / `P0`)

1. `bytes = atob(base64)` as an array of char codes.
2. `checksum = bytes.reduce((a, b) => a ^ b, 0)` — XOR of every byte.
3. `LO = (checksum + magic) % 256`.
4. Every opcode handler is installed at byte value `(OPID + LO) % 256`, where the
   `OPID`s are fixed constants computed in the VM's setup code.
5. The dispatch loop runs from `ip = 0` to `ip = bytes.length`, fetching one
   opcode byte at a time and calling its handler.

**The `magic` number is a per-program nonce chosen so that `LO` is constant.**
Across all 19 programs in `out.js`, `LO == 67`: each `magic` satisfies
`magic ≡ (67 − checksum) (mod 256)`. So the opcode layout is identical for every
program in a given sensor build; the trailing number just cancels out the
program's own checksum.

To decode a byte `B` back to an operation: `OPID ≡ (B − LO) (mod 256)`.

## Operand readers

After an opcode byte, operands are read with these primitives:

| reader | bytes | meaning |
| ------ | ----- | ------- |
| `fF()` | 1 | unsigned byte (small int / flag / arg count) |
| `BO()` | 4 | big-endian uint32 (jump target, 32-bit int literal) |
| `WL()` | 2 + N | 16-bit BE length prefix, then N bytes as a string |
| `NO()` | 8 | big-endian IEEE-754 double (float literal) |

## Execution model

- **Operand stack** (`this[QH]`) — all computation happens here.
- **Registers** (`this[vC]`) — holds the instruction pointer (`LJ.h`).
- **Scope chain** (`this[c0]`, a `qh` helper with its own stack) — `SCOPE_PUSH`
  pushes a fresh `{}` frame, `SCOPE_POP` drops one; `LOAD`/`STORE` resolve names
  against this chain, falling back to the `target` object and globals.
- **References** — `MEMBER` and `LOAD` push *reference cells* (`{get t, set t}`)
  so that `STORE` and `INCDEC` can write back through them. Method calls rebind
  `this` via a `Proxy` set up by `MEMBER` (when its flag is 0).
- **Subroutines** — `FUNC` bodies and `TRY`/`catch`/`finally` bodies are separate
  instruction regions, each terminated by `RET` (the byte `LJ.K`, which the
  dispatch loop treats as "stop"). They are reached out-of-band (a closure call,
  or the `TRY` opcode setting `ip`), and the main code `JMP`s over them.

## Opcode table (byte values shown for `LO = 67`)

| byte | name | operands | effect |
| ---- | ---- | -------- | ------ |
| 0x2d | `PUSH_U8`    | u8      | push a 1-byte int |
| 0x83 | `PUSH_I32`   | u32     | push a 4-byte int |
| 0x99 | `PUSH_F64`   | f64     | push a double |
| 0xee | `PUSH_STR`   | str     | push a string |
| 0xf0 | `PUSH_BOOL`  | u8      | push `!!byte` |
| 0xa0 | `PUSH_UNDEF` | —       | push `undefined` |
| 0x89 | `LOAD`       | str     | resolve an identifier → push reference |
| 0x02 | `MEMBER`     | u8      | `key=pop, obj=pop` → push ref `obj[key]`; flag 0 keeps `this` for a method call |
| 0xfc | `STORE`      | u8      | `ref=pop, val=pop` → `ref = val`; flag pushes the result |
| 0x38 | `INCDEC`     | u8      | `ref=pop`; mode 0 `x++`, 1 `++x`, ≥2 statement `x++` |
| 0x50 | `TYPEOF`     | —       | `typeof pop` |
| 0xd8 | `NOT`        | —       | `!pop` |
| 0xa7 | `NEG`        | —       | `-pop` |
| 0x74 | `ADD` | — | `+` |
| 0x36 | `SUB` | — | `-` |
| 0x94 | `MUL` | — | `*` |
| 0xd1 | `MOD` | — | `%` |
| 0xeb | `SHL` | — | `<<` |
| 0x30 | `LE`  | — | `<=` |
| 0x2e | `LT`  | — | `<` |
| 0x9c | `GT`  | — | `>` |
| 0x97 | `GE`  | — | `>=` |
| 0x3c | `SEQ` | — | `===` |
| 0x2b | `SNE` | — | `!==` |
| 0x98 | `IN`  | — | `in` |
| 0xaa | `AND` | — | `&&` (lazily pops 1 or 2) |
| 0x07 | `JMP` | u32 | `ip = addr` |
| 0x33 | `JF`  | u8, u32 | flag, addr; if `!cond` → `ip = addr`. flag≠0 **peeks** (short-circuit) |
| 0xde | `JT`  | u8, u32 | flag, addr; if `cond` → `ip = addr`. flag≠0 **peeks** |
| 0xf6 | `HALT` | — | clear stack, end top-level |
| 0xc7 | `TRY`  | u8 | pop finally/catch/try addresses, run them as sub-regions |
| 0xc8 | `SCOPE_PUSH` | — | enter a lexical frame |
| 0xf1 | `SCOPE_POP`  | — | leave a lexical frame |
| 0xaf | `CALL` | u8, u8, u8 | pushFlag, newFlag, argc; stack `[…argval, argtag, callee]` |
| 0x72 | `FUNC` | u8, u8, u32 | captureThis, argc, bodyAddr → push a closure |
| 0x4e | `OBJECT` | u8 | build an object literal from N stack entries |
| 0x5a | `SPREAD` | — | collect call/array spread elements |
| 0x61 | `RET` | — | subroutine terminator (`LJ.K`); ends a FUNC/TRY body |

### Notes on the trickier opcodes

- **`CALL`** pops the callee first, then for each argument a *tag* byte (0 =
  normal, 1 = spread) followed by the value. The call's `this` is the object
  bound by a preceding `MEMBER` (flag 0), else the program `target`.
- **`&&` / peek-jumps** — short-circuit `A && B` compiles to
  `<A>; JF flag=1 Lx; <B>; Lx: AND`. The `JF` *peeks* (leaves `A`), and `AND`
  pops one or two operands depending on `A`'s truthiness. The decompiler treats
  peek-jumps as no-ops and folds the pattern back into `(A && B)`.
- **Ternaries / values across jumps** — a value computed in one branch and
  consumed after the merge is carried between basic blocks as an `st<n>` temp.

## Per-build variation (why the table is derived, not hard-coded)

Every fetched sensor is freshly generated. Across builds the following all
change, so nothing about the byte values can be assumed:

| what | reference build (`out.js` orig) | `delta.js` |
| ---- | ------------------------------- | ---------- |
| invocation method | `["k"]` | `["R"]` |
| bytecode prefix | `BwAA…` | `XQAA…` |
| `LO` (constant per build) | 67 | 95 |
| every identifier / OPID name | `jJ`, `qC`, … | `rm`, `rj`, … |
| numeric OPID values | `{237, 243, …}` | `{226, 195, …}` |
| operation set | has `typeof`, no `||` | has `||`; another build has bitwise `^ >>> >> | &` and no `typeof` |

`qJ` (256) and the operation *semantics* are stable; only the encoding moves.
[src/analyze-vm.cjs](src/analyze-vm.cjs) recovers each file's table by:

1. collecting operator-helper functions (`function f(a,b){return a OP b}` → `OP`);
2. identifying the operand-reader / pop / stack method keys by their bodies
   (u8 = `this[a][this[b][c]++]`, u32 = 4× u8, str = length-prefixed
   `fromCharCode` loop, f64 = `toString(2)`/`parseInt`);
3. evaluating the constant block that defines the OPID names (chosen by name
   coverage, to skip decoy re-randomised blocks) and reading `qJ` from the `sT`
   modulus;
4. feature-classifying every `OBJ[OBJ[sT](OPID)] = function…` handler to a
   canonical operation, then `byte = (OPID + LO) % qJ`.

Validated to fully resolve the opcode table for both `out.js` and `delta.js`,
with all 19 programs in each decoding and decompiling cleanly.
