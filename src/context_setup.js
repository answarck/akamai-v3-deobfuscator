// Robust execution-context builder for Akamai v3 string deobfuscation.
//
// The sensor's string tables and decoder functions live as closure-locals
// inside the top-level IIFE. To evaluate a decoder call (e.g. `qtj(123)`) we
// must materialise every one of those declarations as a real, callable global
// inside a VM context.
//
// The previous implementation was brittle in two ways:
//   * it hard-coded `ast.program.body[1]` to find the IIFE — when the IIFE sits
//     at a different index (it is at body[0] here) that read is `undefined` and
//     the whole context comes back EMPTY, so every decode silently fails;
//   * it re-ran the body statements grouped by node type in separate
//     `runInContext` calls, which throws away JavaScript hoisting and the
//     original statement order, so interdependent definitions never resolve.
//
// This version instead:
//   1. Locates the sensor IIFE by searching the AST (never by a fixed index).
//   2. Replays the IIFE body as ONE program so hoisting + ordering are intact,
//      with every non-function statement individually guarded so a single
//      runtime failure cannot abort the rest of the setup.
//   3. Installs forgiving browser/global stubs so setup code that touches
//      window/document/navigator/etc. runs instead of throwing.
//   4. Replays *verbatim source slices* (never Babel-regenerated code) and
//      binds the sensor IIFE under its own name as a non-global. The decoder
//      key offset (`Av()`) is derived from a hash of the IIFE's own
//      `Function.prototype.toString()` and from `typeof window[<name>]`, so
//      any reformatting, or a shim function under that name, silently yields
//      a wrong offset and every decoded string comes out as garbage.

import fs from "fs";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import vm from "vm";


// Locate the main sensor IIFE and return its callee (the function node whose
// body holds the string tables + decoders). Searches the AST rather than
// indexing a fixed position, so it survives leading directives/vars/comments.
function findSensorFunction(ast) {
  // Preferred shape: a top-level immediately-invoked function expression,
  // possibly wrapped in a unary (`!function(){}()`) or sequence expression.
  for (const stmt of ast.program.body) {
    let expr = t.isExpressionStatement(stmt) ? stmt.expression : stmt;
    if (t.isUnaryExpression(expr)) expr = expr.argument;
    if (t.isSequenceExpression(expr)) expr = expr.expressions[expr.expressions.length - 1];
    if (
      t.isCallExpression(expr) &&
      (t.isFunctionExpression(expr.callee) || t.isArrowFunctionExpression(expr.callee)) &&
      t.isBlockStatement(expr.callee.body)
    ) {
      return expr.callee;
    }
  }

  // Fallback: the sensor function dwarfs everything else, so pick the function
  // with the largest body anywhere in the tree.
  let best = null;
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (
      (t.isFunctionExpression(node) || t.isFunctionDeclaration(node)) &&
      t.isBlockStatement(node.body) &&
      (!best || node.body.body.length > best.body.body.length)
    ) {
      best = node;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      walk(node[key]);
    }
  })(ast.program);

  return best;
}

// A recursive, side-effect-free stand-in for browser host objects. Any property
// access, call, or construction returns the same stub, and it coerces to "" / 0,
// so setup code that probes window/document/navigator never throws.
function createPermissiveStub() {
  const target = function () {};
  const stub = new Proxy(target, {
    get(obj, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return undefined;
      if (prop === "toString" || prop === "valueOf") return () => "";
      if (Reflect.has(obj, prop)) return obj[prop];
      return stub;
    },
    set() { return true; },
    has() { return true; },
    apply() { return stub; },
    construct() { return stub; },
  });
  return stub;
}

// Wrap a statement so a runtime failure during replay can't abort the rest of
// the program. `var` bindings still hoist to context scope; only the
// initialiser is guarded.
function guard(stmtSource) {
  return `try {\n${stmtSource}\n} catch (__ctxErr) {}`;
}

// Build a VM context in which every top-level declaration of `fnNode` (a
// function node parsed from `source`) is a callable global, with the
// function's bootstrap (`return …`) executed so lazily-initialised state is
// primed. Used for the sensor IIFE, and for any nested function that hashes
// its own source (the embedded `QS` VM does).
function createFunctionContext(source, fnNode) {
  const stub = createPermissiveStub();
  const sandbox = {
    // Common host globals the sensor probes during bootstrap. Anything not
    // listed simply stays undefined; the bootstrap is run defensively so a
    // missing name can't prevent the decode state from being installed.
    window: stub, self: stub, top: stub, parent: stub, frames: stub,
    document: stub, navigator: stub, location: stub, screen: stub,
    history: stub, localStorage: stub, sessionStorage: stub,
    performance: stub, crypto: stub, frameElement: stub,
    Document: stub, Window: stub, Element: stub, Node: stub, Event: stub,
    HTMLElement: stub, XMLHttpRequest: stub, FileReader: stub, Image: stub,
    MutationObserver: stub, WebSocket: stub, Worker: stub, Promise: Promise,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} },
    setTimeout() { return 0; }, clearTimeout() {},
    setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    fetch() { return Promise.resolve(stub); },
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window = sandbox;

  const context = vm.createContext(sandbox);

  // Split the IIFE body into definitions and the trailing bootstrap. The string
  // decoders are flattened VM interpreters whose numeric state (V6, JS, KC, …)
  // is only computed as a side effect of the IIFE's `return <bootstrap>` call —
  // so we must *run* that bootstrap, not drop it, or every decoder throws on
  // uninitialised state.
  const slice = (node) => source.slice(node.start, node.end);
  const defs = [];
  const bootstraps = [];
  for (const s of fnNode.body.body) {
    if (t.isReturnStatement(s)) {
      if (s.argument) bootstraps.push(slice(s.argument));
      continue;
    }
    defs.push(t.isFunctionDeclaration(s) ? slice(s) : guard(slice(s)));
  }

  // 0. The sensor keeps a reference to itself (`Ix()["E0"] = wVrtcwPkkm`) and
  //    derives decoder constants from a hash of its own `toString()` and from
  //    `typeof window[<name>]`. So the binding must (a) be the byte-exact
  //    original function text, (b) carry the original name, and (c) NOT be a
  //    property of the global object. A top-level `let` gives exactly that.
  if (fnNode.id?.name) {
    try {
      vm.runInContext(`let ${fnNode.id.name} = ${slice(fnNode)};`, context, { timeout: 15000 });
    } catch {}
  }

  // 1. Install every declaration as a context global (hoisting + order intact).
  try {
    vm.runInContext(defs.join("\n"), context, { timeout: 15000 });
  } catch {
    // Hoisted declarations are already installed even if a later statement
    // aborts, so we can still proceed.
  }

  // 2. Prime interpreter state by running the bootstrap(s). These intentionally
  //    run the real sensor entrypoint; it will throw or be cut short once it
  //    reaches genuinely browser-bound work, but by then the decode constants
  //    are already initialised. The timeout guards against headless hangs.
  for (const expr of bootstraps) {
    try {
      vm.runInContext(expr + ";", context, { timeout: 10000 });
    } catch {
      // Expected: bootstrap aborts at browser-bound work after priming state.
    }
  }

  return context;
}

function createObfuscatedContext(filePath) {
  const source = fs.readFileSync(filePath, "utf-8");
  const ast = parser.parse(source);

  const sensorFn = findSensorFunction(ast);
  if (!sensorFn) {
    throw new Error("[context_setup] could not locate the sensor IIFE in " + filePath);
  }

  return createFunctionContext(source, sensorFn);
}

export { createFunctionContext, findSensorFunction };
export default createObfuscatedContext;
