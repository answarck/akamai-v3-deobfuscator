// =============================================================================
// analyze-vm.cjs — derive the CS-VM opcode table from a (deobfuscated) sensor
// file by structural analysis, so the decompiler works on dynamic variants
// where every identifier, constant value and opcode id has been re-randomised.
//
// The VM *design* is invariant across builds (same ~38 operations, same operand
// readers, same dispatch); only names, the numeric OPID values and the magic
// change. This module recovers, for a given file:
//
//   * the modulus qJ (the opcode space size, normally 256);
//   * operator helper functions      (name -> JS operator);
//   * the operand-reader method keys (u8 / u32 / str / f64) and pop/stack keys;
//   * every opcode handler, classified to a canonical operation, with its OPID
//     numeric value read from the file's own constant block.
//
// Output feeds vm-decompiler.cjs: { qJ, ops: {OP: opidValue}, operands: {OP:[…]} }.
// =============================================================================

'use strict';

const parser = require('@babel/parser');
const traverseMod = require('@babel/traverse');
const traverse = traverseMod.default || traverseMod;
const vm = require('vm');

// ---------------------------------------------------------------------------
// small AST helpers
// ---------------------------------------------------------------------------
const isThis = (n) => n && n.type === 'ThisExpression';
// this[KEY]  ->  KEY (identifier name) or null
function thisKey(n) {
  if (n && n.type === 'MemberExpression' && isThis(n.object) && n.computed && n.property.type === 'Identifier') {
    return n.property.name;
  }
  return null;
}
// callee of a CallExpression as a plain name, when it's an identifier
const calleeName = (n) => (n && n.type === 'CallExpression' && n.callee.type === 'Identifier') ? n.callee.name : null;
// X[KEY]()  ->  KEY   (instance method call; X is `this` or the local install var,
// which both reference the VM instance — so don't require ThisExpression)
function thisCallKey(n) {
  if (n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.computed &&
      n.callee.property.type === 'Identifier') {
    return n.callee.property.name;
  }
  return null;
}
function fnBody(fn) { return fn && (fn.type === 'FunctionExpression' || fn.type === 'FunctionDeclaration' || fn.type === 'ArrowFunctionExpression') ? fn.body : null; }

const FN_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);
// count occurrences of a predicate inside an AST subtree.
// `local` = do not descend into nested function bodies (so a handler's own
// operand reads / IP writes are not confused with those of a closure it builds).
function countNodes(node, pred, local) {
  let n = 0;
  (function walk(x, top) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(c => walk(c, top));
    if (local && !top && FN_TYPES.has(x.type)) return;
    if (x.type && pred(x)) n++;
    for (const k in x) { if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments') continue; walk(x[k], false); }
  })(node, true);
  return n;
}
function findNode(node, pred, local) {
  let found = null;
  (function walk(x, top) {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(c => walk(c, top));
    if (local && !top && FN_TYPES.has(x.type)) return;
    if (x.type && pred(x)) { found = x; return; }
    for (const k in x) { if (k === 'loc' || k === 'start' || k === 'end') continue; walk(x[k], false); }
  })(node, true);
  return found;
}

const BIN_OPS = new Set(['+', '-', '*', '/', '%', '<<', '>>', '>>>', '&', '|', '^', '==', '===', '!=', '!==', '<', '<=', '>', '>=', 'in', 'instanceof']);
const UN_OPS = new Set(['!', '-', '~', '+', 'typeof', 'void']);

// ---------------------------------------------------------------------------
// 1. operator helper functions:  function f(a,b){ return a OP b }  /  f(a){ return OP a }
// ---------------------------------------------------------------------------
function collectOperatorHelpers(ast) {
  const ops = {}; // name -> { arity, op, logical }
  const consider = (name, fn) => {
    if (!name || !fn) return;
    const body = fnBody(fn);
    if (!body || body.type !== 'BlockStatement' || body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== 'ReturnStatement' || !ret.argument) return;
    const e = ret.argument;
    const params = fn.params;
    if (params.length === 2 && (e.type === 'BinaryExpression' || e.type === 'LogicalExpression') &&
        e.left.type === 'Identifier' && e.right.type === 'Identifier') {
      ops[name] = { arity: 2, op: e.operator, logical: e.type === 'LogicalExpression' };
    } else if (params.length === 1 && e.type === 'UnaryExpression' && e.argument.type === 'Identifier' && UN_OPS.has(e.operator)) {
      ops[name] = { arity: 1, op: e.operator };
    }
  };
  traverse(ast, {
    FunctionDeclaration(p) { consider(p.node.id && p.node.id.name, p.node); },
    AssignmentExpression(p) {
      if (p.node.left.type === 'Identifier') consider(p.node.left.name, p.node.right);
    },
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier' && p.node.init) consider(p.node.id.name, p.node.init);
    },
  });
  return ops;
}

// ---------------------------------------------------------------------------
// 2. internal method roles: scan `OBJ[KEY] = function(){…}` (KEY identifier) and
//    classify the body. Returns { roleByKey, stackKey, regSetKey, ipMemberObj }.
// ---------------------------------------------------------------------------
function collectMethodRoles(ast) {
  const installs = []; // { key, fn }
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right } = p.node;
      if (left.type !== 'MemberExpression' || !left.computed) return;
      if (left.property.type !== 'Identifier') return;
      if (!(right.type === 'FunctionExpression' || right.type === 'ArrowFunctionExpression')) return;
      installs.push({ key: left.property.name, fn: right });
    },
  });

  const roleByKey = {};
  // byte reader:  return this[A][ this[B][C]++ ]
  for (const { key, fn } of installs) {
    const body = fnBody(fn);
    if (!body || body.type !== 'BlockStatement') continue;
    const ret = body.body.find(s => s.type === 'ReturnStatement');
    if (ret && ret.argument && ret.argument.type === 'MemberExpression' && ret.argument.computed &&
        ret.argument.property.type === 'UpdateExpression') {
      roleByKey[key] = 'u8';
    }
  }
  const u8Key = Object.keys(roleByKey).find(k => roleByKey[k] === 'u8');

  // stack key: the this[K] with the most .push/.pop member calls
  const pushPop = {};
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee;
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' &&
          (c.property.name === 'push' || c.property.name === 'pop')) {
        const k = thisKey(c.object);
        if (k) pushPop[k] = (pushPop[k] || 0) + 1;
      }
    },
  });
  const stackKey = Object.entries(pushPop).sort((a, b) => b[1] - a[1])[0]?.[0];

  for (const { key, fn } of installs) {
    if (roleByKey[key]) continue;
    const body = fnBody(fn);
    if (!body) continue;
    const callsU8 = u8Key ? countNodes(body, n => thisCallKey(n) === u8Key) : 0;
    const hasFromCharCode = !!findNode(body, n => n.type === 'MemberExpression' && n.property && n.property.name === 'fromCharCode');
    const hasToStringRadix = !!findNode(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
      n.callee.property && n.callee.property.name === 'toString');
    const hasParseInt = !!findNode(body, n => calleeName(n) === 'parseInt');
    const hasLoop = !!findNode(body, n => n.type === 'ForStatement' || n.type === 'WhileStatement' || n.type === 'ForOfStatement');
    const hasPop = !!findNode(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
      n.callee.property && n.callee.property.name === 'pop');
    const hasTernary = !!findNode(body, n => n.type === 'ConditionalExpression');

    if (hasFromCharCode && hasLoop) roleByKey[key] = 'str';
    else if (hasToStringRadix && hasParseInt) roleByKey[key] = 'f64';
    else if (callsU8 >= 4 && !hasLoop) roleByKey[key] = 'u32';
    else if (hasPop && hasTernary && fn.params.length === 1) roleByKey[key] = 'pop';       // d6
  }

  // resolve (jv): function(x){ return helper(typeof x, _) ? x.q : x }
  // load (hL): function(a){ return f.call(this[c0], a, this) }
  // regSet (q): function(a,b){ this[regs][a] = b }
  let regSetKey, loadKey, rnKey;
  for (const { key, fn } of installs) {
    if (roleByKey[key]) continue;
    const body = fnBody(fn);
    if (!body || body.type !== 'BlockStatement') continue;
    // regSet: this[X][param0] = param1
    if (fn.params.length === 2 && body.body.length === 1 && body.body[0].type === 'ExpressionStatement') {
      const a = body.body[0].expression;
      if (a.type === 'AssignmentExpression' && a.left.type === 'MemberExpression' && a.left.computed &&
          a.left.object.type === 'MemberExpression' && isThis(a.left.object.object)) {
        roleByKey[key] = 'regSet'; regSetKey = key; continue;
      }
    }
    // load: return _.call(this[_], param, this)
    const ret = body.body.find(s => s.type === 'ReturnStatement');
    if (ret && ret.argument && ret.argument.type === 'CallExpression' &&
        ret.argument.callee.type === 'MemberExpression' && ret.argument.callee.property &&
        ret.argument.callee.property.name === 'call' && fn.params.length === 1) {
      roleByKey[key] = 'load'; loadKey = key; continue;
    }
    // RN: function(a,b,c){ if (helper(typeof a,_)) { c ? push : … } else { _.call(…) } }
    if (fn.params.length === 3) { roleByKey[key] = 'rn'; rnKey = key; continue; }
  }

  return { roleByKey, stackKey, regSetKey, loadKey, rnKey, u8Key, installs };
}

// ---------------------------------------------------------------------------
// 3. opcode handler installs:  OBJ[OBJ[ST](OPID)] = function(){…}
// ---------------------------------------------------------------------------
function collectHandlers(ast) {
  const handlers = []; // { opid, fn, stKey }
  let stKey;
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right } = p.node;
      if (left.type !== 'MemberExpression' || !left.computed) return;
      if (!(right.type === 'FunctionExpression' || right.type === 'ArrowFunctionExpression')) return;
      // property must be  OBJ[ST](OPID)
      const prop = left.property;
      if (prop.type !== 'CallExpression') return;
      if (prop.callee.type !== 'MemberExpression' || !prop.callee.computed) return;
      if (prop.callee.property.type !== 'Identifier') return;
      if (prop.arguments.length !== 1 || prop.arguments[0].type !== 'Identifier') return;
      stKey = prop.callee.property.name;            // the sT method key
      handlers.push({ opid: prop.arguments[0].name, fn: right });
    },
  });
  return { handlers, stKey };
}

// ---------------------------------------------------------------------------
// 4. constant block: longest run of consecutive pure-arithmetic assignments
// ---------------------------------------------------------------------------
function isPureArith(node) {
  let ok = true;
  (function walk(x) {
    if (!ok || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(walk);
    switch (x.type) {
      case 'NumericLiteral': case 'Identifier': break;
      case 'BinaryExpression': walk(x.left); walk(x.right); break;
      case 'UnaryExpression': walk(x.argument); break;
      case 'ArrayExpression': if (x.elements.length) ok = false; break;
      case 'ParenthesizedExpression': walk(x.expression); break;
      default: ok = false;
    }
  })(node);
  return ok;
}
function evalConstantBlock(ast, wantedNames) {
  // Score a run by how many of the wanted names (opcode ids) it defines; this
  // disambiguates the real opcode constant block from decoy re-randomised
  // assignments of the same names elsewhere in the program.
  const want = new Set(wantedNames || []);
  const score = (run) => {
    if (!want.size) return run.length;
    let s = 0; for (const a of run) if (want.has(a.left.name)) s++;
    return s * 100000 + run.length;
  };
  let best = [], bestScore = -1;
  const considerSeq = (stmts) => {
    let run = [];
    const flush = () => { if (run.length) { const sc = score(run); if (sc > bestScore) { bestScore = sc; best = run.slice(); } } run = []; };
    for (const s of stmts) {
      const ok = s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
        s.expression.operator === '=' && s.expression.left.type === 'Identifier' && isPureArith(s.expression.right);
      if (ok) run.push(s.expression);
      else flush();
    }
    flush();
  };
  traverse(ast, { BlockStatement(p) { considerSeq(p.node.body); }, Program(p) { considerSeq(p.node.body); } });

  // build code text and eval
  const sandbox = {};
  vm.createContext(sandbox);
  const lines = best.map(a => {
    const name = a.left.name;
    return `${name} = ${exprToSource(a.right)};`;
  });
  try { vm.runInContext(lines.join('\n'), sandbox); } catch (e) { /* partial */ }
  return sandbox;
}
// minimal expression printer for pure-arith nodes (avoids pulling in @babel/generator here)
function exprToSource(n) {
  switch (n.type) {
    case 'NumericLiteral': return String(n.value);
    case 'Identifier': return n.name;
    case 'BinaryExpression': return `(${exprToSource(n.left)} ${n.operator} ${exprToSource(n.right)})`;
    case 'UnaryExpression': return `${n.operator}${n.prefix === false ? '' : ''}(${exprToSource(n.argument)})`;
    case 'ArrayExpression': return '[]';
    case 'ParenthesizedExpression': return `(${exprToSource(n.expression)})`;
    default: return '0';
  }
}

// ---------------------------------------------------------------------------
// 5. classify one handler -> { op, operands:[…] }
// ---------------------------------------------------------------------------
function classifyHandler(fn, ctx) {
  const { roleByKey, stackKey, regSetKey, loadKey, opHelpers } = ctx;
  const body = fnBody(fn);
  if (!body) return null;

  // operand readers consumed, in source order — handler-LOCAL only (do not look
  // inside closures the handler pushes, e.g. FUNC bodies)
  const readers = [];
  (function walkReaders(x, top) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(c => walkReaders(c, top));
    if (!top && FN_TYPES.has(x.type)) return;
    if (x.type === 'CallExpression') {
      const k = thisCallKey(x);
      const role = k && roleByKey[k];
      if (role === 'u8' || role === 'u32' || role === 'str' || role === 'f64') readers.push(role);
    }
    for (const key in x) { if (key === 'loc' || key === 'start' || key === 'end') continue; walkReaders(x[key], false); }
  })(body, true);

  const popCount = countNodes(body, n => thisCallKey(n) && roleByKey[thisCallKey(n)] === 'pop', true);
  const rawPop = countNodes(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
    thisKey(n.callee.object) === stackKey && n.callee.property && n.callee.property.name === 'pop', true);
  const hasProxy = !!findNode(body, n => n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Proxy', true);
  const hasApply = !!findNode(body, n => n.type === 'MemberExpression' && n.property && n.property.name === 'apply', true);
  const pushesFn = !!findNode(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
    thisKey(n.callee.object) === stackKey && n.callee.property && n.callee.property.name === 'push' &&
    n.arguments[0] && (n.arguments[0].type === 'FunctionExpression' || n.arguments[0].type === 'ArrowFunctionExpression'), true);
  const writesIP = !!findNode(body, n => thisCallKey(n) === regSetKey && n.type === 'CallExpression', true);
  const clearsStack = !!findNode(body, n => n.type === 'AssignmentExpression' && thisKey(n.left) === stackKey &&
    n.right.type === 'ArrayExpression', true);
  const hasUpdate = !!findNode(body, n => n.type === 'UpdateExpression', true);
  const hasFor = !!findNode(body, n => n.type === 'ForStatement' || n.type === 'ForOfStatement', true);
  const hasWhile = !!findNode(body, n => n.type === 'WhileStatement', true);
  const hasSwitch = !!findNode(body, n => n.type === 'SwitchStatement', true);

  // the single push(ARG), if any
  const pushCall = findNode(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
    thisKey(n.callee.object) === stackKey && n.callee.property && n.callee.property.name === 'push');
  const pushArg = pushCall && pushCall.arguments[0];

  const helperOpOf = (node) => {
    if (node && node.type === 'CallExpression' && node.callee.type === 'Identifier' && opHelpers[node.callee.name]) {
      return opHelpers[node.callee.name];
    }
    return null;
  };

  // --- calls / constructs (check FUNC first: it builds a closure that itself
  //     writes IP and reads bytes, which must not be mistaken for a jump) ----
  if (pushesFn) return { op: 'FUNC', operands: ['u8', 'u8', 'u32'] };
  if (findNode(body, n => n.type === 'TryStatement', true)) return { op: 'TRY', operands: ['u8'] };
  if (hasApply && readers.filter(r => r === 'u8').length >= 3 && hasFor) return { op: 'CALL', operands: ['u8', 'u8', 'u8'] };

  // --- control flow ---------------------------------------------------------
  if (clearsStack && writesIP) return { op: 'HALT', operands: [] };
  if (writesIP && readers.length === 1 && readers[0] === 'u32' && !findNode(body, n => n.type === 'IfStatement', true))
    return { op: 'JMP', operands: ['u32'] };
  if (writesIP && readers.includes('u32') && readers.includes('u8')) {
    // conditional: JF if the tested condition is negated (mk/!), JT otherwise
    const negated = !!findNode(body, n => (n.type === 'UnaryExpression' && n.operator === '!') ||
      (n.type === 'CallExpression' && n.callee.type === 'Identifier' && opHelpers[n.callee.name] && opHelpers[n.callee.name].op === '!'), true);
    return { op: negated ? 'JF' : 'JT', operands: ['u8', 'u32'] };
  }
  if (hasWhile && hasSwitch && readers[0] === 'u8') return { op: 'OBJECT', operands: ['u8'] };
  if (hasFor && rawPop >= 1 && !pushCall && readers.length === 0) return { op: 'SPREAD', operands: [] };
  if (hasProxy && hasUpdate) return { op: 'INCDEC', operands: ['u8'] };

  // --- store (RN(stack.pop(), pop(), u8())) ---------------------------------
  if (ctx.rnKey && findNode(body, n => thisCallKey(n) === ctx.rnKey) && readers[0] === 'u8' && !pushCall)
    return { op: 'STORE', operands: ['u8'] };

  // --- member: 2 pops, reads 1 u8 flag, pushes a ref (not an operator) ------
  if (pushArg && popCount === 2 && readers.length === 1 && readers[0] === 'u8' && !helperOpOf(pushArg))
    return { op: 'MEMBER', operands: ['u8'] };

  // --- pushes -------------------------------------------------------------
  if (pushArg) {
    // literal readers
    if (pushArg.type === 'CallExpression' && roleByKey[thisCallKey(pushArg)]) {
      const r = roleByKey[thisCallKey(pushArg)];
      if (r === 'u8') return { op: 'PUSH_U8', operands: ['u8'] };
      if (r === 'u32') return { op: 'PUSH_I32', operands: ['u32'] };
      if (r === 'str') return { op: 'PUSH_STR', operands: ['str'] };
      if (r === 'f64') return { op: 'PUSH_F64', operands: ['f64'] };
    }
    // boolean: push( u8() ? _ : _ )
    if (pushArg.type === 'ConditionalExpression' && readers[0] === 'u8') return { op: 'PUSH_BOOL', operands: ['u8'] };
    // undefined: push( mkref(undefined) )
    if (pushArg.type === 'CallExpression' && pushArg.arguments[0] &&
        pushArg.arguments[0].type === 'Identifier' && pushArg.arguments[0].name === 'undefined')
      return { op: 'PUSH_UNDEF', operands: [] };
    // load: push( load(str()) )
    if (pushArg.type === 'CallExpression' && thisCallKey(pushArg) === loadKey) return { op: 'LOAD', operands: ['str'] };
    // logical AND/OR: push(pop && pop) / push(pop || pop)
    if (pushArg.type === 'LogicalExpression') return { op: pushArg.operator === '||' ? 'OR' : 'AND', operands: [] };
    // binary op via helper: push(HELPER(a,b))
    const h = helperOpOf(pushArg);
    if (h) {
      if (h.arity === 2 && popCount === 2) return { op: binOpName(h.op), operands: [] };
      if (h.arity === 2 && popCount === 1) return { op: 'NEG', operands: [] };   // (-1)*pop
      if (h.arity === 1 && popCount === 1) return { op: unOpName(h.op), operands: [] };
    }
    // typeof / unary operators expressed directly
    if (pushArg.type === 'UnaryExpression' && popCount === 1) return { op: unOpName(pushArg.operator), operands: [] };
  }

  // --- scope push / pop: single call to a 0-arg helper on this[c0] ----------
  // these call a helper that either does stack[len]={} (push) or stack.pop() (pop)
  const helperCall = findNode(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
    n.callee.property && n.callee.property.name === 'call');
  if (helperCall && readers.length === 0 && !pushCall) {
    const helperFn = ctx.helperFnByName[helperCall.callee.object && helperCall.callee.object.name];
    return { op: scopeKind(helperFn, ctx), operands: [] };
  }

  return null;
}

function binOpName(op) {
  return ({ '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '<<': 'SHL', '>>': 'SHR', '>>>': 'USHR',
    '&': 'BAND', '|': 'BOR', '^': 'BXOR', '<=': 'LE', '<': 'LT', '>': 'GT', '>=': 'GE',
    '===': 'SEQ', '!==': 'SNE', '==': 'EQ', '!=': 'NE', 'in': 'IN', 'instanceof': 'INSTANCEOF', '&&': 'AND', '||': 'OR' })[op] || ('BIN' + op);
}
function unOpName(op) { return ({ 'typeof': 'TYPEOF', '!': 'NOT', '-': 'NEG', '~': 'BNOT', '+': 'UPLUS' })[op] || ('UN' + op); }

// scope helper: distinguish enter (assigns {} into stack) vs leave (stack.pop)
function scopeKind(helperFn, ctx) {
  if (!helperFn) return 'SCOPE';
  const body = fnBody(helperFn);
  if (body && findNode(body, n => n.type === 'ObjectExpression')) return 'SCOPE_PUSH';
  if (body && findNode(body, n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
    n.callee.property && n.callee.property.name === 'pop')) return 'SCOPE_POP';
  return 'SCOPE';
}

// index all top-level function names -> node, so scope helpers can be inspected
function indexFunctions(ast) {
  const byName = {};
  traverse(ast, {
    FunctionDeclaration(p) { if (p.node.id) byName[p.node.id.name] = p.node; },
    AssignmentExpression(p) {
      if (p.node.left.type === 'Identifier' && (p.node.right.type === 'FunctionExpression' || p.node.right.type === 'ArrowFunctionExpression'))
        byName[p.node.left.name] = p.node.right;
    },
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier' && p.node.init &&
        (p.node.init.type === 'FunctionExpression' || p.node.init.type === 'ArrowFunctionExpression'))
        byName[p.node.id.name] = p.node.init;
    },
  });
  return byName;
}

// ---------------------------------------------------------------------------
// top-level: derive the opcode table for a file's source
// ---------------------------------------------------------------------------
function deriveTable(src) {
  const ast = parser.parse(src, { errorRecovery: true });

  const opHelpers = collectOperatorHelpers(ast);
  const roles = collectMethodRoles(ast);
  const { handlers, stKey } = collectHandlers(ast);
  const helperFnByName = indexFunctions(ast);
  // evaluate the constant block that actually defines the opcode ids (+ qJ)
  const consts = evalConstantBlock(ast, handlers.map(h => h.opid));

  // qJ: from the sT method  function(A){ return MOD(ADD(A, _), QJ) }
  let qJ = 256;
  const stInstall = roles.installs.find(i => i.key === stKey);
  if (stInstall) {
    const body = fnBody(stInstall.fn);
    const ret = body && body.body.find(s => s.type === 'ReturnStatement');
    // ret.argument = MODHELPER( ADDHELPER(A, field), QJ )
    if (ret && ret.argument && ret.argument.type === 'CallExpression' && ret.argument.arguments[1] &&
        ret.argument.arguments[1].type === 'Identifier') {
      const qjName = ret.argument.arguments[1].name;
      if (consts[qjName] != null) qJ = consts[qjName];
    }
  }

  const ctx = { ...roles, opHelpers, helperFnByName, stKey };
  const ops = {};          // OP -> opid numeric value
  const operands = {};     // OP -> operand spec
  const unresolved = [];
  const all = [];          // every handler classification (for diagnostics)
  const collisions = [];
  for (const h of handlers) {
    const cls = classifyHandler(h.fn, ctx);
    const opidVal = consts[h.opid];
    if (!cls || opidVal == null) { unresolved.push({ opid: h.opid, cls }); continue; }
    const byteVal = ((opidVal % qJ) + qJ) % qJ;
    all.push({ opid: h.opid, op: cls.op, value: byteVal });
    if (ops[cls.op] !== undefined) collisions.push({ op: cls.op, opids: [h.opid] });
    ops[cls.op] = byteVal;
    operands[cls.op] = cls.operands;
  }

  return { qJ, ops, operands, unresolved, all, collisions, meta: { handlerCount: handlers.length, opHelpers, roles: roles.roleByKey, stackKey: roles.stackKey } };
}

module.exports = { deriveTable };

// ---------------------------------------------------------------------------
// debug CLI:  node src/analyze-vm.cjs <file>
// ---------------------------------------------------------------------------
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) { console.error('Usage: node src/analyze-vm.cjs <file>'); process.exit(1); }
  const table = deriveTable(fs.readFileSync(file, 'utf8'));
  console.log('qJ =', table.qJ);
  console.log('handlers =', table.meta.handlerCount, ' resolved ops =', Object.keys(table.ops).length);
  console.log('stackKey =', table.meta.stackKey);
  console.log('\nOP -> opid(value)  operands');
  for (const op of Object.keys(table.ops).sort()) {
    console.log(`  ${op.padEnd(11)} ${String(table.ops[op]).padStart(3)}   [${table.operands[op].join(',')}]`);
  }
  if (table.unresolved.length) {
    console.log('\nUNRESOLVED:', table.unresolved.map(u => u.opid + (u.cls ? '=' + u.cls.op : '')).join(', '));
  }
}
