// =============================================================================
// Akamai Sensor v3 "CS" VM decompiler
// -----------------------------------------------------------------------------
// The sensor embeds small programs for a stack-based virtual machine. They are
// invoked like:
//
//     var fqj = new CS();
//     fqj["k"](targetObject, "<base64 bytecode>", 168);
//
// `k(target, base64, magic)` does:
//   1. bytes   = atob(base64).split('').map(charCodeAt)
//   2. checksum = bytes.reduce(xor, 0)
//   3. LO      = (checksum + magic) % 256          // per-program opcode shift
//   4. installs every opcode handler at byte (OPID + LO) % 256
//   5. runs the dispatch loop from ip=0 until ip >= bytes.length
//
// So the opcode byte for a given operation is remapped on every call by `LO`,
// which is derived from the program's own checksum plus the trailing magic
// number. This module reverses all of that: it reproduces the byte->operation
// map, disassembles the linear instruction stream, and runs an abstract stack
// interpreter to reconstruct readable pseudo-JavaScript.
//
// All of the constants below were lifted directly from the deobfuscated VM in
// out.js (the giant constant block around lines 1083-1201 and the opcode
// handler bodies). See OPS for the per-opcode provenance.
// =============================================================================

'use strict';

const MOD = 256; // qJ

// -----------------------------------------------------------------------------
// Operand readers (mirror the VM's internal byte-fetch helpers)
//   fF()  -> 1 byte                                   (this[WF][ip++])
//   BO()  -> 4 bytes big-endian uint32                (jump targets / int lit)
//   WL()  -> 2-byte BE length prefix + that many bytes as a string
//   NO()  -> 8 bytes big-endian IEEE-754 double       (float literal)
// -----------------------------------------------------------------------------
class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.ip = 0;
  }
  eof() { return this.ip >= this.b.length; }
  u8() { return this.b[this.ip++]; }
  u32() {
    const b = this.b;
    const v = ((b[this.ip] << 24) | (b[this.ip + 1] << 16) | (b[this.ip + 2] << 8) | b[this.ip + 3]) >>> 0;
    this.ip += 4;
    return v;
  }
  str() {
    const len = (this.b[this.ip] << 8) | this.b[this.ip + 1];
    this.ip += 2;
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.b[this.ip++]);
    return s;
  }
  f64() {
    const buf = Buffer.from(this.b.slice(this.ip, this.ip + 8));
    this.ip += 8;
    return buf.readDoubleBE(0);
  }
}

// -----------------------------------------------------------------------------
// Opcode table. Keys are the canonical OPID value mod 256 (computed from the
// constant block in out.js). `ops` lists the operands consumed from the byte
// stream after the opcode. `kind`/`op` drive the decompiler.
// -----------------------------------------------------------------------------
// operand spec tokens: 'u8' | 'u32' | 'str' | 'f64' (read in this order)
const OPS = {
  // ---- literals --------------------------------------------------------------
  234: { name: 'PUSH_U8',    ops: ['u8'],  kind: 'lit' },            // l0:  push fF()
  64:  { name: 'PUSH_I32',   ops: ['u32'], kind: 'lit' },            // v0:  push BO()
  86:  { name: 'PUSH_F64',   ops: ['f64'], kind: 'lit' },            // hV:  push NO()
  171: { name: 'PUSH_STR',   ops: ['str'], kind: 'litstr' },         // z0:  push WL()
  173: { name: 'PUSH_BOOL',  ops: ['u8'],  kind: 'litbool' },        // WL:  push !!fF()
  93:  { name: 'PUSH_UNDEF', ops: [],      kind: 'litundef' },       // Ng:  push undefined

  // ---- variables / members ---------------------------------------------------
  70:  { name: 'LOAD',       ops: ['str'], kind: 'load' },           // pF:  push resolve(WL())  (identifier lookup)
  191: { name: 'MEMBER',     ops: ['u8'],  kind: 'member' },         // TH:  key=pop, obj=pop -> push ref(obj[key]); u8=keepThis flag
  185: { name: 'STORE',      ops: ['u8'],  kind: 'store' },          // L1:  ref=pop, val=pop -> ref<-val; u8=push-result flag
  245: { name: 'INCDEC',     ops: ['u8'],  kind: 'incdec' },         // q:   ref=pop; u8 mode (0 post / 1 pre / >=2 plain ++)

  // ---- unary -----------------------------------------------------------------
  13:  { name: 'TYPEOF',     ops: [], kind: 'unary', op: 'typeof ' }, // vH
  149: { name: 'NOT',        ops: [], kind: 'unary', op: '!' },       // dk
  100: { name: 'NEG',        ops: [], kind: 'unary', op: '-' },       // tT: push((-1) * pop)

  // ---- binary ----------------------------------------------------------------
  49:  { name: 'ADD',  ops: [], kind: 'bin', op: '+'   }, // zJ  lF
  243: { name: 'SUB',  ops: [], kind: 'bin', op: '-'   }, // qC  sk
  81:  { name: 'MUL',  ops: [], kind: 'bin', op: '*'   }, // B1  Cv
  142: { name: 'MOD',  ops: [], kind: 'bin', op: '%'   }, // z1  V1
  168: { name: 'SHL',  ops: [], kind: 'bin', op: '<<'  }, // wg  YF
  237: { name: 'LE',   ops: [], kind: 'bin', op: '<='  }, // jJ  KL
  235: { name: 'LT',   ops: [], kind: 'bin', op: '<'   }, // Hg  fv
  89:  { name: 'GT',   ops: [], kind: 'bin', op: '>'   }, // pv  JJ
  84:  { name: 'GE',   ops: [], kind: 'bin', op: '>='  }, // zv  I6
  249: { name: 'SEQ',  ops: [], kind: 'bin', op: '===' }, // PL  mF
  232: { name: 'SNE',  ops: [], kind: 'bin', op: '!==' }, // bF  fk
  85:  { name: 'IN',   ops: [], kind: 'bin', op: 'in'  }, // BV  f6
  103: { name: 'AND',  ops: [], kind: 'bin', op: '&&'  }, // QH  &&

  // ---- control flow ----------------------------------------------------------
  196: { name: 'JMP',     ops: ['u32'],       kind: 'jmp'  },        // M0:  ip = BO()
  240: { name: 'JF',      ops: ['u8', 'u32'], kind: 'jf'   },        // jF:  flag, addr; if(!cond) ip=addr
  155: { name: 'JT',      ops: ['u8', 'u32'], kind: 'jt'   },        // GT:  flag, addr; if(cond)  ip=addr
  179: { name: 'HALT',    ops: [],            kind: 'halt' },        // jv:  clear stack, ip=end
  132: { name: 'TRY',     ops: ['u8'],        kind: 'try'  },        // WJ:  flag; pops finally,catch,try addrs
  133: { name: 'SCOPE_PUSH', ops: [],         kind: 'scope' },       // fh:  push new lexical frame {}
  174: { name: 'SCOPE_POP',  ops: [],         kind: 'scope' },       // Uh:  pop lexical frame

  // ---- calls / constructs ----------------------------------------------------
  108: { name: 'CALL',   ops: ['u8', 'u8', 'u8'], kind: 'call' },    // EJ:  pushFlag, newFlag, argc
  47:  { name: 'FUNC',   ops: ['u8', 'u8', 'u32'], kind: 'func' },   // cV:  captureThis, nargs, bodyAddr
  11:  { name: 'OBJECT', ops: ['u8'],         kind: 'object' },      // U:   entryCount (consumes stack)
  23:  { name: 'SPREAD', ops: [],             kind: 'spread' },      // Bk:  count=pop; collect args into temp

  // ---- subroutine terminator (LJ.K) -----------------------------------------
  // Not a real handler: the MN() dispatch loop runs `while (op != LJ.K)`, so this
  // byte is fetched and ends the current sub-execution (a FUNC body or try
  // block). It is always the last byte of a function body. byte=(30+LO)%256=0x61.
  30:  { name: 'RET',    ops: [],             kind: 'end' },
};

// quick lookup name -> canonical id (handy for debugging)
const NAME2ID = {};
for (const id in OPS) NAME2ID[OPS[id].name] = +id;

// -----------------------------------------------------------------------------
// SEM: per-operation semantics, keyed by canonical operation NAME (not by byte
// value). This is the invariant part of the VM — operand layout + how the
// decompiler renders it. Opcode BYTE values differ per build and are supplied
// separately via a "table" ({ qJ, ops: {OP: opidValue} }) so the same decompiler
// works on any variant (see analyze-vm.cjs, which derives that table per file).
// -----------------------------------------------------------------------------
const SEM = {};
for (const id in OPS) { const o = OPS[id]; SEM[o.name] = { ops: o.ops, kind: o.kind, op: o.op }; }
// binary operators that some builds use but the reference build did not
const EXTRA_BIN = {
  ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%', SHL: '<<', SHR: '>>', USHR: '>>>',
  BAND: '&', BOR: '|', BXOR: '^', LE: '<=', LT: '<', GT: '>', GE: '>=',
  SEQ: '===', SNE: '!==', EQ: '==', NE: '!=', IN: 'in', INSTANCEOF: 'instanceof', AND: '&&', OR: '||',
};
for (const name in EXTRA_BIN) if (!SEM[name]) SEM[name] = { ops: [], kind: 'bin', op: EXTRA_BIN[name] };
// unary operators some builds use
for (const [name, op] of [['BNOT', '~'], ['UPLUS', '+'], ['TYPEOF', 'typeof '], ['NOT', '!'], ['NEG', '-']])
  if (!SEM[name]) SEM[name] = { ops: [], kind: 'unary', op };
if (!SEM.RET) SEM.RET = { ops: [], kind: 'end' };

// The reference (original) build's opcode table, so callers that don't supply a
// derived table keep working on the programs this tool was first built against.
const DEFAULT_TABLE = { qJ: MOD, ops: {} };
for (const id in OPS) DEFAULT_TABLE.ops[OPS[id].name] = +id;

// -----------------------------------------------------------------------------
// Program: base64 + magic (+ opcode table) -> bytes, checksum, LO, byte->op map
// -----------------------------------------------------------------------------
function decodeProgram(b64, magic, table = DEFAULT_TABLE) {
  const raw = Buffer.from(b64, 'base64');
  const bytes = Array.from(raw);
  const qJ = table.qJ || MOD;
  let checksum = 0;
  for (const x of bytes) checksum ^= x;
  const LO = ((checksum + magic) % qJ + qJ) % qJ;

  // byte -> operation name:  byte = (OPID + LO) % qJ
  const byte2op = {};
  for (const op in table.ops) {
    const byteVal = ((table.ops[op] % qJ) + qJ + LO) % qJ;
    byte2op[byteVal] = op;
  }
  return { bytes, checksum, LO, qJ, byte2op };
}

// -----------------------------------------------------------------------------
// Linear disassembler: walk the byte stream, decode each instruction.
// Returns a list of { addr, byte, id, op, operands:[...] } plus the set of
// jump-target addresses (for labelling).
// -----------------------------------------------------------------------------
function disassemble(prog) {
  const { bytes, byte2op } = prog;
  const r = new Reader(bytes);
  const insns = [];
  const targets = new Set();
  const byAddr = {};

  while (!r.eof()) {
    const addr = r.ip;
    const byte = r.u8();
    // Any byte without a handler is the subroutine terminator (LJ.K / RET): the
    // dispatch loop stops on it, so it is never installed as an opcode.
    const name = byte2op[byte] || 'RET';
    const spec = SEM[name];

    const operands = [];
    for (const t of spec.ops) {
      if (t === 'u8') operands.push(r.u8());
      else if (t === 'u32') operands.push(r.u32());
      else if (t === 'str') operands.push(r.str());
      else if (t === 'f64') operands.push(r.f64());
    }

    const insn = { addr, byte, name, kind: spec.kind, op: spec.op, operands, size: r.ip - addr };
    insns.push(insn);
    byAddr[addr] = insn;

    // collect jump targets (last operand is the address for jmp/jf/jt; func body addr)
    if (spec.kind === 'jmp') targets.add(operands[0]);
    else if (spec.kind === 'jf' || spec.kind === 'jt') targets.add(operands[1]);
    else if (spec.kind === 'func') targets.add(operands[2]);
  }

  return { insns, targets, byAddr };
}

// -----------------------------------------------------------------------------
// Pretty-print the linear disassembly.
// -----------------------------------------------------------------------------
function formatDisassembly(prog, dis) {
  const { insns, targets } = dis;
  const lines = [];
  lines.push(`; checksum=0x${prog.checksum.toString(16)} magic-derived LO=${prog.LO} bytes=${prog.bytes.length}`);
  for (const ins of insns) {
    const label = targets.has(ins.addr) ? `L${ins.addr}:` : '';
    const spec = SEM[ins.name];
    const operandStr = ins.operands.map((o, i) => {
      const t = spec.ops[i];
      if (t === 'u32' && (ins.kind === 'jmp' || ins.kind === 'jf' || ins.kind === 'jt' || ins.kind === 'func')) {
        return `L${o}`;
      }
      if (t === 'str') return JSON.stringify(o);
      return String(o);
    }).join(', ');
    const addrCol = `${String(ins.addr).padStart(5)}`;
    const labelCol = label.padStart(0).padEnd(8);
    lines.push(`${addrCol}  ${labelCol}${ins.name.padEnd(11)} ${operandStr}`);
  }
  return lines.join('\n');
}

// =============================================================================
// Decompiler: abstract-stack interpretation -> readable pseudo-JavaScript
// -----------------------------------------------------------------------------
// The VM is a stack machine, so we reconstruct expressions by replaying each
// instruction against an abstract operand stack of expression strings. Control
// flow that the structurer cannot fold is emitted faithfully as labelled
// `goto`/`if (...) goto` so the output is never a lie about what the code does.
// Function bodies are recovered from the `JMP over body … FUNC body,addr` idiom
// and inlined as nested function expressions.
// =============================================================================

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// Build the structural model.
//
// The VM executes several independent instruction regions, each terminated by
// RET (the LJ.K byte) and entered out-of-band:
//   * the program entry (address 0), run by the top-level `k` loop;
//   * FUNC bodies, entered when the closure is invoked (operand 2 = body addr);
//   * TRY / CATCH / FINALLY bodies, entered by the TRY opcode, whose three body
//     addresses are the three PUSH_I32 literals immediately preceding it.
//
// We discover every entry, then flood-fill intra-region control flow (jumps and
// fall-through, but NOT into nested FUNC/TRY bodies) so each instruction is
// assigned to exactly one region. Each region is decompiled with its own CFG.
function analyze(dis) {
  const { insns, byAddr } = dis;
  const idxByAddr = {};
  insns.forEach((ins, i) => { idxByAddr[ins.addr] = i; });

  // FUNC body entries
  const funcByAddr = {};      // FUNC opcode addr -> { entry, argc }
  for (const ins of insns) {
    if (ins.kind === 'func') funcByAddr[ins.addr] = { entry: ins.operands[2], argc: ins.operands[1], captureThis: ins.operands[0] };
  }

  // TRY body entries: the three int literals pushed just before each TRY.
  // Stack order at TRY: try=top, catch, finally(bottom)  ->  pushed finally,catch,try.
  const tryByAddr = {};       // TRY opcode addr -> { tryE, catchE, finallyE }
  for (let i = 0; i < insns.length; i++) {
    if (insns[i].kind !== 'try') continue;
    const lits = [];
    for (let j = i - 1; j >= 0 && lits.length < 3; j--) {
      if (insns[j].name === 'PUSH_I32' || insns[j].name === 'PUSH_U8') lits.push(insns[j].operands[0]);
      else break;
    }
    if (lits.length === 3) tryByAddr[insns[i].addr] = { tryE: lits[0], catchE: lits[1], finallyE: lits[2] };
  }

  // region entry points
  const entries = new Set([insns[0].addr]);
  for (const a in funcByAddr) entries.add(funcByAddr[a].entry);
  for (const a in tryByAddr) { const t = tryByAddr[a]; entries.add(t.tryE); entries.add(t.catchE); entries.add(t.finallyE); }

  // flood-fill: assign each instruction to a region entry
  const regionOf = {};        // instr addr -> region entry addr
  const succAddrs = (ins) => {
    const out = [];
    const next = byAddr[ins.addr + ins.size];
    if (ins.kind === 'jmp') { if (byAddr[ins.operands[0]]) out.push(ins.operands[0]); }
    else if ((ins.kind === 'jf' || ins.kind === 'jt')) {
      if (ins.operands[0] === 0) { if (byAddr[ins.operands[1]]) out.push(ins.operands[1]); if (next) out.push(next.addr); }
      else if (next) out.push(next.addr);     // peek branch: short-circuit, falls through
    } else if (ins.kind === 'halt' || ins.kind === 'end') { /* no successors */ }
    else if (next) out.push(next.addr);
    return out;
  };
  for (const entry of entries) {
    const stack = [entry];
    while (stack.length) {
      const a = stack.pop();
      const ins = byAddr[a];
      if (!ins || regionOf[a] !== undefined) continue;
      if (entries.has(a) && a !== entry) continue;   // another region's entry
      regionOf[a] = entry;
      for (const s of succAddrs(ins)) if (regionOf[s] === undefined) stack.push(s);
    }
  }

  return { idxByAddr, funcByAddr, tryByAddr, entries, regionOf, byAddr };
}

function isIdent(strLit) {
  // strLit is a JSON-quoted string; check the inner value is an identifier
  if (strLit.length >= 2 && strLit[0] === '"') {
    const inner = strLit.slice(1, -1);
    return IDENT_RE.test(inner);
  }
  return false;
}
function memberExpr(obj, keyExpr) {
  if (isIdent(keyExpr)) return `${obj}.${keyExpr.slice(1, -1)}`;
  return `${obj}[${keyExpr}]`;
}
function lvalue(nameExpr) {
  // STORE target: a PUSH_STR string literal -> bare identifier; else as-is (member ref)
  if (isIdent(nameExpr)) return nameExpr.slice(1, -1);
  return nameExpr;
}

// A jf/jt with the PEEK flag (operand 0 != 0) leaves its condition on the stack;
// it is the VM's short-circuit && / || connector, not real control flow. We keep
// it inside the basic block (a no-op that preserves the value) so the downstream
// AND/combiner folds it into `(A && B)`. Only the POP form (flag 0) is a branch.
function isTerminator(ins) {
  if (ins.kind === 'jmp' || ins.kind === 'halt' || ins.kind === 'end') return true;
  if (ins.kind === 'jf' || ins.kind === 'jt') return ins.operands[0] === 0;
  return false;
}

// Apply one non-terminator instruction to the abstract stack, optionally
// emitting a statement. Terminators (jmp/jf/jt/halt/end) are handled by the
// block driver so it can materialise live stack values before the branch.
function stepInsn(ins, stack, emit, ctx) {
  const pop = () => (stack.length ? stack.pop() : '<?>');
  switch (ins.kind) {
    case 'lit':      stack.push(String(ins.operands[0])); break;
    case 'litstr':   stack.push(JSON.stringify(ins.operands[0])); break;
    case 'litbool':  stack.push(ins.operands[0] ? 'true' : 'false'); break;
    case 'litundef': stack.push('undefined'); break;
    case 'load':     stack.push(ins.operands[0]); break;

    case 'member': { const key = pop(); const obj = pop(); stack.push(memberExpr(obj, key)); break; }
    case 'bin':    { const a = pop(); const b = pop(); stack.push(`(${a} ${ins.op} ${b})`); break; }
    case 'unary':  stack.push(`${ins.op}${pop()}`); break;

    case 'incdec': {
      const ref = pop();
      const mode = ins.operands[0];
      if (mode >= 2) emit(`${ref}++;`);                 // statement form
      else stack.push(mode === 1 ? `++${ref}` : `${ref}++`);
      break;
    }
    case 'store': {
      const name = pop();
      const val = pop();
      const lv = lvalue(name);
      if (ins.operands[0]) stack.push(`(${lv} = ${val})`);
      else emit(`${lv} = ${val};`);
      break;
    }
    case 'call': {
      // stack: [argVal_1, tag_1, ..., argVal_n, tag_n, callee]  (callee on top)
      const [pushFlag, newFlag, argc] = ins.operands;
      const callee = pop();
      const args = [];
      for (let i = 0; i < argc; i++) { const tag = pop(); const v = pop(); args.push(tag === '1' ? '...' + v : v); }
      args.reverse();
      const call = `${newFlag ? 'new ' : ''}${callee}(${args.join(', ')})`;
      if (pushFlag) stack.push(call);
      else emit(`${call};`);
      break;
    }
    case 'func': {
      if (ctx.depth) { stack.push('§fn'); break; }       // depth pass: skip recursion
      const f = ctx.model.funcByAddr[ins.addr];
      const argc = ins.operands[1];
      // body entry stack (bottom->top): [arg{n-1}..arg0, __argc__]; SPREAD pops the
      // marker, then each STORE binds a parameter to arg0, arg1, ... in order
      const seed = [];
      for (let i = argc - 1; i >= 0; i--) seed.push('arg' + i);
      seed.push('__argc__');
      const body = f ? decompileRegion(ctx.prog, ctx.dis, ctx.model, f.entry, seed, ctx.indent.v + 1) : ['/* unresolved body */'];
      const header = `function (${Array.from({ length: argc }, (_, i) => 'arg' + i).join(', ')}) {`;
      stack.push([header, ...body, '  '.repeat(ctx.indent.v) + '}'].join('\n'));
      break;
    }
    case 'object': {
      const n = ins.operands[0];
      const parts = [];
      for (let i = 0; i < n && stack.length; i++) parts.unshift(pop());
      stack.push(`{ /*${n} entries*/ ${parts.join(', ')} }`);
      break;
    }
    case 'spread': if (stack.length) stack.pop(); break;  // arg-count marker
    case 'jf':
    case 'jt':
      // only reaches here in PEEK form (short-circuit): leave the value in place
      break;
    case 'try': {
      pop(); pop(); pop();                                // the three body addresses
      if (ctx.depth) break;
      const t = ctx.model.tryByAddr[ins.addr];
      // catch body starts with the caught error already on the stack (seed = 1)
      const sub = (e, seed) => (e !== undefined && ctx.model.regionOf[e] === e)
        ? decompileRegion(ctx.prog, ctx.dis, ctx.model, e, seed, ctx.indent.v + 1)
        : ['  '.repeat(ctx.indent.v + 1) + '/* unresolved */'];
      if (!t) { emit('/* TRY (unresolved targets) */'); break; }
      emit('try {');
      sub(t.tryE, 0).forEach(ctx.pushRaw);
      emit('} catch (err) {');
      sub(t.catchE, ['err']).forEach(ctx.pushRaw);
      emit('} finally {');
      sub(t.finallyE, 0).forEach(ctx.pushRaw);
      emit('}');
      break;
    }
    case 'scope':
      if (ins.name === 'SCOPE_PUSH') { emit('{'); ctx.indent.v++; }
      else { ctx.indent.v = Math.max(0, ctx.indent.v - 1); emit('}'); }
      break;
    default:
      emit(`/* ${ins.name} ${ins.operands.join(',')} */`);
  }
}

// net stack-length change of a terminator (for depth propagation)
function termDelta(ins) {
  if (ins.kind === 'jf' || ins.kind === 'jt') return ins.operands[0] ? 0 : -1; // peek vs pop
  return 0;
}

// Decompile one region (identified by its entry address) using a basic-block
// CFG so that stack values which live across jumps (ternaries, short-circuits,
// try-values) are carried between blocks as `st<depth>` temps instead of
// underflowing. `seedDepth` pre-loads the entry stack: FUNC bodies start with
// argc args + an arg-count marker; CATCH bodies start with the caught error.
function decompileRegion(prog, dis, model, entry, seedDepth, indent0) {
  const { insns } = dis;

  const regionInsns = insns
    .filter(ins => model.regionOf[ins.addr] === entry)
    .sort((a, b) => a.addr - b.addr);
  if (!regionInsns.length) return [];

  const addrSet = new Set(regionInsns.map(i => i.addr));
  // suppress a JMP whose target is simply the next instruction in this region
  // (the "skip over an embedded body" idiom leaves these behind)
  const nextAddrInRegion = (i) => regionInsns[i + 1] ? regionInsns[i + 1].addr : undefined;
  const jumpTarget = (ins) => ins.kind === 'jmp' ? ins.operands[0]
    : (ins.kind === 'jf' || ins.kind === 'jt') ? ins.operands[1] : undefined;

  // --- leaders / basic blocks ------------------------------------------------
  const leaders = new Set([regionInsns[0].addr]);
  regionInsns.forEach((ins, i) => {
    if (isTerminator(ins)) {
      const next = regionInsns[i + 1];
      if (next) leaders.add(next.addr);
      const t = jumpTarget(ins);
      if (t !== undefined && addrSet.has(t)) leaders.add(t);
    }
  });
  const blocks = [];
  let cur = null;
  for (const ins of regionInsns) {
    if (leaders.has(ins.addr)) { cur = { addr: ins.addr, insns: [] }; blocks.push(cur); }
    cur.insns.push(ins);
  }
  const blockByAddr = {};
  blocks.forEach(b => { blockByAddr[b.addr] = b; });

  // labels actually referenced by a jump (keeps the listing uncluttered)
  const referenced = new Set();
  for (const ins of regionInsns) { const t = jumpTarget(ins); if (t !== undefined) referenced.add(t); }

  // --- successors ------------------------------------------------------------
  blocks.forEach((b, bi) => {
    const last = b.insns[b.insns.length - 1];
    b.term = isTerminator(last) ? last : null;
    const fall = blocks[bi + 1] ? blocks[bi + 1].addr : undefined;
    if (!b.term) { b.succ = fall !== undefined ? [fall] : []; return; }
    switch (b.term.kind) {
      case 'jmp': { const t = b.term.operands[0]; b.succ = addrSet.has(t) ? [t] : []; break; }
      case 'jf':
      case 'jt': {
        const t = b.term.operands[1]; const s = [];
        if (addrSet.has(t)) s.push(t);
        if (fall !== undefined) s.push(fall);
        b.succ = s; break;
      }
      default: b.succ = []; // halt / end
    }
  });

  // --- entry-depth propagation (BFS) -----------------------------------------
  const ctxDepth = { prog, dis, model, indent: { v: 0 }, depth: true };
  const simulateDepth = (block, entryDepth) => {
    const st = Array.from({ length: entryDepth }, (_, i) => '§' + i);
    for (const ins of block.insns) {
      if (ins === block.term) { for (let k = 0; k < -termDelta(ins); k++) st.pop(); }
      else stepInsn(ins, st, () => {}, ctxDepth);
    }
    return st.length;
  };
  // seedDepth may be a number (anonymous st* slots) or an array of slot names
  const seedNames = Array.isArray(seedDepth) ? seedDepth : null;
  blocks[0].entryDepth = seedNames ? seedNames.length : (seedDepth || 0);
  const wl = [blocks[0]];
  while (wl.length) {
    const b = wl.shift();
    const exit = simulateDepth(b, b.entryDepth);
    b.exitDepth = exit;
    for (const s of b.succ) {
      const sb = blockByAddr[s];
      if (sb && sb.entryDepth === undefined) { sb.entryDepth = exit; wl.push(sb); }
    }
  }
  for (const b of blocks) if (b.entryDepth === undefined) b.entryDepth = 0; // unreachable

  // --- emission --------------------------------------------------------------
  const out = [];
  const indent = { v: indent0 };
  const pad = () => '  '.repeat(indent.v);
  const emit = (s) => out.push(pad() + s);
  const ctx = { prog, dis, model, indent, depth: false, out, emit, pushRaw: (l) => out.push(l) };

  const materialise = (stack, depth) => {
    // make sure successors can read st0..st{depth-1}; reassign any non-temp slot
    for (let i = 0; i < depth; i++) {
      const want = 'st' + i;
      if (stack[i] !== want) { emit(`${want} = ${stack[i] === undefined ? 'undefined' : stack[i]};`); }
    }
  };

  blocks.forEach((b, bi) => {
    if (referenced.has(b.addr)) emit(`L${b.addr}:`);
    const stack = Array.from({ length: b.entryDepth }, (_, i) =>
      (b === blocks[0] && seedNames) ? seedNames[i] : 'st' + i);

    const body = b.term ? b.insns.slice(0, -1) : b.insns;
    for (const ins of body) stepInsn(ins, stack, emit, ctx);

    if (!b.term) { materialise(stack, b.exitDepth); return; }
    const nextBlockAddr = blocks[bi + 1] ? blocks[bi + 1].addr : undefined;
    switch (b.term.kind) {
      case 'jmp':
        materialise(stack, b.exitDepth);
        // a goto straight to the following block is redundant (skip-idiom leftover)
        if (b.term.operands[0] !== nextBlockAddr) emit(`goto L${b.term.operands[0]};`);
        break;
      case 'jf': {
        const cond = b.term.operands[0] ? (stack.length ? stack[stack.length - 1] : '<?>') : stack.pop();
        materialise(stack, b.exitDepth);
        emit(`if (!(${cond})) goto L${b.term.operands[1]};`);
        break;
      }
      case 'jt': {
        const cond = b.term.operands[0] ? (stack.length ? stack[stack.length - 1] : '<?>') : stack.pop();
        materialise(stack, b.exitDepth);
        emit(`if (${cond}) goto L${b.term.operands[1]};`);
        break;
      }
      case 'halt': emit('return;   // HALT'); break;
      case 'end':  emit(stack.length ? `return ${stack.pop()};` : 'return;'); break;
    }
  });
  return out;
}

function decompile(prog) {
  const dis = disassemble(prog);
  const model = analyze(dis);
  const header = `// checksum=0x${prog.checksum.toString(16)}  LO=${prog.LO}  bytes=${prog.bytes.length}`;
  const body = decompileRegion(prog, dis, model, dis.insns[0].addr, 0, 0);
  return [header, ...body].join('\n');
}

module.exports = {
  OPS, SEM, NAME2ID, MOD, DEFAULT_TABLE, Reader,
  decodeProgram, disassemble, formatDisassembly,
  analyze, decompileRegion, decompile,
};

// -----------------------------------------------------------------------------
// CLI:  node src/vm-decompiler.cjs <base64> <magic> [--asm|--dec] [--from <file>]
//   --from <file>  derive the opcode table from <file> (a dynamic variant);
//                  without it the original reference build's table is assumed.
// -----------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args.find(a => a === '--asm' || a === '--dec') || '--dec';
  const fromIdx = args.indexOf('--from');
  const fromFile = fromIdx !== -1 ? args[fromIdx + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && !(fromIdx !== -1 && i === fromIdx + 1));
  const [b64, magicStr] = positional;
  if (!b64 || magicStr === undefined) {
    console.error('Usage: node src/vm-decompiler.cjs <base64> <magic> [--asm|--dec] [--from <file>]');
    process.exit(1);
  }
  let table = DEFAULT_TABLE;
  if (fromFile) {
    const { deriveTable } = require('./analyze-vm.cjs');
    table = deriveTable(require('fs').readFileSync(fromFile, 'utf8'));
  }
  const prog = decodeProgram(b64, parseInt(magicStr, 10), table);
  if (mode === '--asm') console.log(formatDisassembly(prog, disassemble(prog)));
  else console.log(decompile(prog));
}
