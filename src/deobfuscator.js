import traverseModule from "@babel/traverse";
import * as parser from "@babel/parser";
import generator from "@babel/generator";
import * as t from "@babel/types";
import fs from "fs";
import vm from "vm";

import createObfuscatedContext from "./context_setup.js";

const traverse = traverseModule.default;
const generate = generator.default;

function replace_stubs(ast) {
  console.log("[replace_stubs] starting...");
  const stubMap = new Map();

  traverse(ast, {
    VariableDeclaration(path) {
      const decl = path.node.declarations[0];
      if (!decl || !decl.init) return;
      const init = decl.init;
      if (init.type !== "FunctionExpression") return;
      if (init.body.body.length !== 1) return;
      if (init.params.length !== 1 && init.params.length !== 2) return;

      const returnStatement = init.body.body[0];
      if (returnStatement.type !== "ReturnStatement") return;

      const arg = returnStatement.argument;
      const paramNames = init.params.map((p) => p.name);
      const name = decl.id.name;

      if (arg.type === "BinaryExpression") {
        if (arg.left.type !== "Identifier" || arg.right.type !== "Identifier") return;
        if (arg.left.name !== paramNames[0] || arg.right.name !== paramNames[1]) return;
        stubMap.set(name, { type: "binary", operator: arg.operator });
        console.log(`[replace_stubs]   found binary stub: ${name} → (a ${arg.operator} b)`);
        path.remove();
      } else if (arg.type === "UnaryExpression") {
        if (arg.argument.type !== "Identifier") return;
        if (arg.argument.name !== paramNames[0]) return;
        stubMap.set(name, { type: "unary", operator: arg.operator });
        console.log(`[replace_stubs]   found unary stub:  ${name} → (${arg.operator}a)`);
        path.remove();
      }
    },
  });

  console.log(`[replace_stubs] ${stubMap.size} stub(s) collected — inlining call sites...`);
  let inlined = 0;

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== "Identifier") return;

      const stub = stubMap.get(callee.name);
      if (!stub) return;

      const callNode = path.node;

      if (stub.type === "binary") {
        if (callNode.arguments.length !== 2) return;
        const [left, right] = callNode.arguments;
        callNode.type = "BinaryExpression";
        callNode.operator = stub.operator;
        callNode.left = left;
        callNode.right = right;
        delete callNode.callee;
        delete callNode.arguments;
        inlined++;
      } else if (stub.type === "unary") {
        if (callNode.arguments.length !== 1) return;
        const [argument] = callNode.arguments;
        callNode.type = "UnaryExpression";
        callNode.operator = stub.operator;
        callNode.prefix = true;
        callNode.argument = argument;
        delete callNode.callee;
        delete callNode.arguments;
        inlined++;
      }
    },
  });

  console.log(`[replace_stubs] done → ${stubMap.size} stub(s) removed, ${inlined} call site(s) inlined`);
}

function replace_static_vars(ast) {
  console.log("[static_vars] Replacing");
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
    }
  });

  traverse(ast, {
    VariableDeclaration(path) {
      if (path.findParent(p => p.isSwitchStatement())) return;

      for (const dec of path.get('declarations')) {
        const name = dec.node.id.name;
        const binding = path.scope.getBinding(name);
        if (!binding) continue;

        for (const violation of binding.constantViolations) {
          try {
            const codeToRun = generate(violation.node.right).code;

            const value = vm.runInNewContext(codeToRun);

            let literal = t.numericLiteral(value);

            for (const ref of binding.referencePaths) {
              ref.replaceWith(literal);
            }
          } catch { }
        }
      }
    }
  });

}

function replace_arr_calls(ast) {
  if (!ast) throw new Error("replace_arr_calls: ast is required");

  function get_arr(name) {
    if (!name || typeof name !== "string") return undefined;

    let arr;
    traverse(ast, {
      FunctionDeclaration(path) {
        if (!path.node.id || path.node.id.name !== name) return;

        const body = path.node.body?.body;
        if (!body || body.length === 0) return;

        const declaration = body[0]?.declarations?.[0]?.init;
        if (!declaration) return;

        try {
          const code = generate(declaration).code;
          arr = eval(code);
        } catch (e) { }
      },
    });

    return arr;
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.getFunctionParent()?.getFunctionParent?.()) return;

      const body = path.node.body?.body;
      if (!body || body.length !== 1) return;

      const arg = body[0]?.argument;
      if (!arg) return;

      if (arg.type !== "MemberExpression") return;

      const callExpr = arg.object;
      if (!callExpr || callExpr.type !== "CallExpression") return;

      const calleeName = callExpr.callee?.name;
      if (!calleeName) return;

      const arr = get_arr(calleeName);
      if (!Array.isArray(arr)) return;

      const funcName = path.node.id?.name;
      if (!funcName) return;

      const binding = path.scope.getBinding(funcName);
      if (!binding) return;

      for (const reference of binding.referencePaths) {
        const parentNode = reference.parentPath?.node;
        if (!parentNode) continue;

        if (parentNode.type !== "CallExpression") continue;

        const args = parentNode.arguments;
        if (!args || args.length === 0) continue;

        const indexArg = args[0];
        if (indexArg?.type !== "NumericLiteral") continue;

        const index = indexArg.value;
        if (index < 0 || index >= arr.length) continue;

        if (typeof arr[index] !== "string") continue;

        try {
          reference.parentPath.replaceWith(t.stringLiteral(arr[index]));
        } catch (e) { }
      }

      try {
        path.remove();
      } catch (e) { }
    },
  });
}

function flatten(ast) {
  let totalFlattened = 0;

  function N7F(WKF) {
    WKF = WKF ? WKF : ~WKF;
    var qkF = WKF << 1 & 4095;
    if ((WKF >> 9 ^ WKF >> 6 ^ WKF) & 1) {
      qkF++;
    }
    return qkF;
  }
  function v8(JEF) {
    var VEF = JEF;
    var NKF;
    do {
      NKF = N7F(VEF) % 1000;
      VEF = NKF;
    } while (NKF == JEF);
    return NKF;
  }
  function DN(Cd5, zwF) {
    var IkF = function () { };
    IkF["prototype"]["constructor"] = Cd5;
    IkF["prototype"]["set"] = function (lAF) {
      var NBF;
      return NBF = this["sjs_r"] = zwF(lAF), NBF;
    };
    IkF["prototype"]["valueOf"] = function () {
      var qcF;
      return qcF = this["sjs_r"] = zwF(this["sjs_r"]), qcF;
    };
    var RAF;
    return RAF = new IkF(), RAF;
  }

  traverse(ast, {
    SwitchStatement(path) {
      if (path.findParent(e => e.isSwitchStatement())) return;


      const parent = path.getFunctionParent();
      if (!parent) return;
      const index = parent.node.params[0];
      if (!index) return;
      const binding = parent.scope.getBinding(index.name);
      if (!binding) return;

      const fnNames = new Set();
      if (parent.node.id?.name) fnNames.add(parent.node.id.name);
      if (t.isVariableDeclarator(parent.parent)) {
        if (t.isIdentifier(parent.parent.id)) {
          fnNames.add(parent.parent.id.name);
        }
      }
      if (t.isAssignmentExpression(parent.parent)) {
        if (t.isIdentifier(parent.parent.left)) {
          fnNames.add(parent.parent.left.name);
        }
      }

      if (fnNames.size === 0) return;

      let case_tests = [];
      const get_indices = {
        CallExpression(callPath) {
          const callee = callPath.node.callee;
          let targetName = "";
          let isAppliedOrCalled = false;

          if (callee.type === "Identifier") {
            targetName = callee.name;
          } else if (
            callee.type === "MemberExpression" &&
            callee.property.type === "Identifier" &&
            (callee.property.name === "call" || callee.property.name === "apply")
          ) {
            if (t.isIdentifier(callee.object)) {
              targetName = callee.object.name;
            }
            isAppliedOrCalled = true;
          }

          if (!fnNames.has(targetName)) return;

          const args = callPath.node.arguments;
          if (isAppliedOrCalled) {
            if (args.length >= 2) {
              const valNode = args[1];
              if (callee.property.name === "apply" && valNode.type === "ArrayExpression") {
                if (valNode.elements[0]?.type === "NumericLiteral") {
                  case_tests.push(valNode.elements[0].value);
                }
              } else if (valNode.type === "NumericLiteral") {
                case_tests.push(valNode.value);
              }
            }
          } else {
            if (args[0]?.type === "NumericLiteral") {
              case_tests.push(args[0].value);
            }
          }
        },
      };

      traverse(ast, get_indices);
      case_tests = [...new Set(case_tests)];

      if (case_tests.length === 0) return;

      const index_references = [...(binding.constantViolations || [])];
      const ifBlocks = [];

      let p, n, k;
      if (path.node.discriminant.type == "BinaryExpression") {
        p = path.getFunctionParent();
        n = p.node.body.body[1].declarations[0].init.arguments[0].arguments[0].value;
        if (p.node.body.body[3].expression.arguments[0].type == "BinaryExpression") {
          k = p.node.body.body[3].expression.arguments[0].right.value;
        } else { k = 0; }
      }

      for (const case_test of case_tests) {
        var wII, E6I;
        if (path.node.discriminant.type == "BinaryExpression") {
          wII = DN(new Number(n), v8);
          E6I = wII;
        }


        const ctx = vm.createContext({ [index.name]: case_test });
        const blockStmts = [];

        if (path.node.discriminant.type == "BinaryExpression") {
          wII.set(case_test + k);
        }

        while (true) {
          var cur_index_value, cur_case_path;
          if (path.node.discriminant.type == "BinaryExpression") {
            E6I + vm.runInContext(index.name, ctx);
            cur_index_value = E6I + vm.runInContext(index.name, ctx);
          } else { cur_index_value = vm.runInContext(index.name, ctx); }
          cur_case_path = path.get('cases').find(casePath => {
            const testNode = casePath.node.test;
            return testNode && testNode.value === cur_index_value;
          });
          if (!cur_case_path) break;

          for (const stmt of cur_case_path.node.consequent) {
            if (stmt.type === 'BreakStatement') continue;

            const isIndexMutation = index_references.some(ref => {
              const refStmt = ref.findParent(p => p.isStatement());
              return refStmt && refStmt.node === stmt;
            });

            if (!isIndexMutation) {
              if (t.isBlockStatement(stmt)) {
                blockStmts.push(...stmt.body.map(s => t.cloneNode(s, true)));
              } else {
                blockStmts.push(t.cloneNode(stmt, true));
              }
            }
          }

          const cur_index_path = index_references.find(ref => {
            const parentCase = ref.findParent(e => e.isSwitchCase());
            return parentCase && parentCase.node === cur_case_path.node;
          });
          if (!cur_index_path) break;

          try {
            vm.runInContext(generate(cur_index_path.node).code, ctx);
          } catch {
            break;
          }

          const new_index_value = vm.runInContext(index.name, ctx);
          if (new_index_value === cur_index_value) break;
        }


        if (blockStmts.length > 0) {
          ifBlocks.push({ test: case_test, stmts: blockStmts });
        }
      }

      if (ifBlocks.length === 0) {
        path.remove();
        return;
      }

      const ifStatements = ifBlocks.map(({ test, stmts }) =>
        t.ifStatement(
          t.binaryExpression(
            '===',
            t.identifier(index.name),
            t.numericLiteral(test)
          ),
          t.blockStatement(stmts)
        )
      );

      const funcBody = parent.get('body');
      funcBody.get('body').forEach(s => s.remove());
      funcBody.unshiftContainer('body', ifStatements);

      totalFlattened++;
      console.log(`[flatten] ${[...fnNames].join(' / ')} (index: ${index.name}, Cases: ${case_tests})`);
    },
  });

  console.log(`[flatten] done → ${totalFlattened} function(s) flattened `);
}

function remove_safe_typeof_check(ast) {
  traverse(ast, {
    ConditionalExpression(path) {
      const { test, consequent, alternate } = path.node;

      if (!test || test.type !== "BinaryExpression") return;

      const left = test.left;
      if (!left || left.type !== "UnaryExpression") return;
      if (left.operator !== "typeof") return;

      const arg = left.argument;

      if (
        !arg ||
        arg.type !== "MemberExpression" ||
        !arg.computed ||
        arg.object.type !== "CallExpression" ||
        arg.object.callee.type !== "Identifier" ||
        arg.property.type !== "StringLiteral"
      ) return;

      if (test.operator === "===") {
        path.replaceWith(alternate);
      } else {
        path.replaceWith(consequent);
      }
    },
  });
}

function replace_function_calls(ast) {
  console.log("[function_replacement] Started");
  const replacement_cache = new Map();
  const REPLACED = Symbol("replaced");
  var replaced_fns = [];

  function build_alias_map(ast) {
    const alias_map = new Map();

    traverse(ast, {
      VariableDeclarator(path) {

        if (!t.isFunctionExpression(path.node.init)) return;

        const var_name = path.node.id?.name;
        const func_id = path.node.init.id?.name;
        if (!var_name || !func_id) return;


        alias_map.set(func_id, var_name);
        alias_map.set(var_name, var_name);
      }
    });

    return alias_map;
  }

  function get_function_replacement(f_name, t_case) {
    const cache_key = `${f_name}:${t_case}`;
    if (replacement_cache.has(cache_key)) return replacement_cache.get(cache_key);

    let t_case_path;
    traverse(ast, {

      FunctionDeclaration(path) {
        if (path.node.id?.name !== f_name) return;
        path.traverse({
          IfStatement(casePath) {
            if (!casePath.node.test) return;
            const caseValue = casePath.node.test.right.value;
            if (caseValue !== t_case) return;
            t_case_path = casePath;
            casePath.stop();
          },
        });
        if (t_case_path) path.stop();
      },
      VariableDeclaration(path) {
        const decl = path.node.declarations[0];
        if (decl?.id?.name !== f_name) return;
        path.traverse({
          IfStatement(casePath) {
            if (!casePath.node.test) return;
            const caseValue = casePath.node.test.right.value;
            if (caseValue !== t_case) return;
            t_case_path = casePath;
            casePath.stop();
          },
        });
        if (t_case_path) path.stop();
      },
    });

    if (!t_case_path) return null;

    let return_node, to_be_replaced, skip_index;

    t_case_path.traverse({
      AssignmentExpression: {
        enter(p) {
          const left = p.get("left");
          if (!left.isMemberExpression()) return;
          const obj = left.get("object");
          if (!obj.isCallExpression()) return;
          const callee = obj.get("callee");
          if (!callee.isIdentifier()) return;
          to_be_replaced = callee.node.name;
        },
        exit(p) {
          if (return_node && to_be_replaced) {
            p.stop();
          }
        }
      },

      ConditionalExpression(p) {
        const test = p.node.test;
        if (!t.isUnaryExpression(test, { operator: "!" })) return;
        const arg = test.argument;
        if (!t.isBinaryExpression(arg, { operator: "-" })) return;
        if (!t.isNumericLiteral(arg.right)) return;
        skip_index = arg.right.value;
      },

      FunctionExpression(p) {
        if (!p.parentPath.isReturnStatement()) return;
        return_node = p;
      }
    });

    const result = { return_node, to_be_replaced, skip_index };
    replacement_cache.set(cache_key, result);
    return result;
  }

  const function_map = build_alias_map(ast);
  function replace_args(o_args, r_node) {
    const cloned_node = t.cloneDeep(r_node.node);
    const wrapped = t.file(t.program([t.expressionStatement(cloned_node)]));
    let result_node = cloned_node;


    traverse(wrapped, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (!t.isMemberExpression(callee)) return;
        if (!t.isIdentifier(callee.property)) return;
        if (!["call", "apply"].includes(callee.property.name)) return;

        const method = callee.property.name;
        const original_callee = callee.object;
        const args = p.node.arguments;

        if (method === "call") {
          p.replaceWith(t.callExpression(original_callee, args.slice(1)));
        } else if (method === "apply") {
          const arr_arg = args[1];
          if (!arr_arg) {
            p.replaceWith(t.callExpression(original_callee, []));
            return;
          }
          if (!t.isArrayExpression(arr_arg)) return;
          p.replaceWith(t.callExpression(original_callee, arr_arg.elements));
        }
      }
    });


    traverse(wrapped, {
      FunctionExpression(p) {
        const bindings = p.node.params.map(param => p.scope.getBinding(param.name));
        for (const [index, binding] of bindings.entries()) {
          if (!binding) continue;
          const arg = o_args[index];
          if (!arg) continue;
          for (const reference of binding.referencePaths) {
            reference.replaceWith(t.cloneDeep(arg));
          }
        }
        p.scope.crawl();

        const body = p.node.body.body;
        const first_var = body.find(s =>
          t.isVariableDeclaration(s) &&
          s.declarations[0]?.init
        );

        if (first_var) {
          result_node = first_var.declarations[0].init;
        } else {
          const ret = body.find(s => t.isReturnStatement(s));
          result_node = ret ? ret.argument : p.node.body;
        }

        p.stop();
      }
    });


    if (t.isCallExpression(result_node) && t.isIdentifier(result_node.callee)) {
      const old_name = result_node.callee.name;
      const new_name = function_map.get(old_name);
      if (new_name) {
        result_node.callee = t.identifier(new_name);
        replaced_fns.push(new_name);
      } else {
        replaced_fns.push(old_name);
      }
    }

    result_node[REPLACED] = true;
    return result_node;
  }

  function getCoreCallee(callee) {
    if (
      t.isCallExpression(callee.object) &&
      t.isIdentifier(callee.object.callee)
    ) {
      return callee;
    }

    if (
      t.isIdentifier(callee.property) &&
      ["call", "apply"].includes(callee.property.name) &&
      t.isMemberExpression(callee.object)
    ) {
      const inner = callee.object;
      if (
        t.isCallExpression(inner.object) &&
        t.isIdentifier(inner.object.callee)
      ) {
        return inner;
      }
    }

    return null;
  }

  function extract_args(r_path, callee) {
    const is_call_or_apply =
      t.isIdentifier(callee.property) &&
      ["call", "apply"].includes(callee.property.name);

    if (!is_call_or_apply) {
      return r_path.node.arguments;
    }

    const raw_args = r_path.node.arguments.slice(1);

    if (callee.property.name === "apply") {
      const arr_arg = raw_args[0];
      if (!arr_arg) return null;
      if (t.isArrayExpression(arr_arg)) {
        return arr_arg.elements;
      }
      return null;
    }

    return raw_args;
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.getFunctionParent()?.getFunctionParent()) return;

      const first = path.node.body.body[0];
      if (!first || first.type !== "VariableDeclaration") return;

      const decl = first.declarations[0];
      if (!decl || decl.type !== "VariableDeclarator") return;
      if (!decl.init || decl.init.type !== "ArrayExpression") return;

      const arr = eval(generate(decl.init).code);
      const function_name = path.node.id.name;
      const binding = path.scope.getBinding(function_name);
      if (!binding) return;


      const replacements = [];
      for (const reference of binding.referencePaths) {
        const parent = reference.parentPath?.parentPath;
        if (!parent?.isArrayExpression()) continue;

        const call = parent.findParent(p => p.isCallExpression());
        if (!call) continue;

        let t_case;
        const callee = call.node.callee;

        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "call"
        ) {
          t_case = call.node.arguments[1]?.value;
        } else {
          t_case = call.node.arguments[0]?.value;
        }

        let fn_name;
        if (callee.type === "Identifier") {
          fn_name = callee.name;
        } else if (callee.type === "MemberExpression") {
          if (callee.object.type === "Identifier") {
            fn_name = callee.object.name;
          }
        }

        if (!fn_name || t_case == null) continue;

        const replacement = get_function_replacement(fn_name, t_case);
        if (!replacement?.return_node || !replacement?.to_be_replaced) continue;

        replacements.push({ replacement, arr });
      }


      traverse(ast, {
        CallExpression(r_path) {

          if (r_path.node[REPLACED]) return;

          const callee = r_path.node.callee;
          if (!t.isMemberExpression(callee)) return;

          const core = getCoreCallee(callee);
          if (!core) return;
          if (!t.isStringLiteral(core.property)) return;

          for (const { replacement, arr } of replacements) {
            if (core.object.callee.name !== replacement.to_be_replaced) continue;

            const idx = arr.indexOf(core.property.value);
            if (idx === -1 || idx === replacement.skip_index) continue;

            const o_args = extract_args(r_path, callee);
            if (!o_args || o_args.length === 0) continue;


            const result = replace_args(o_args, replacement.return_node);
            r_path.replaceWith(result);
            break;
          }
        },
      });
    },
  });

  return Array.from(new Set(replaced_fns));
}

function replace_functions_with_string(ast, functions, context, stack_var) {
  console.log("[string_replacement] This may take some time");
  function isPrintableASCII(str) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x20 || c > 0x7E) return false;
    }
    return true;
  }
  function get_stack_push(path) {
    const funcParent = path.getFunctionParent();
    if (!funcParent) return null;
    let result = null;
    funcParent.traverse({
      CallExpression(innerPath) {
        if (innerPath.getFunctionParent() !== funcParent) return;
        if (innerPath.node === path.node) {
          innerPath.stop();
          return;
        }
        const callee = innerPath.node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === stack_var &&
          callee.property.type === "Identifier" &&
          callee.property.name === "push"
        ) {
          result = innerPath;
        }
      }
    });
    return result;
  }

  vm.runInContext(`var ${stack_var} = [];`, context);

  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee.type !== "Identifier") return;
      if (!functions.includes(path.node.callee.name)) return;

      const function_call = generate(path.node).code;
      const stack_push = get_stack_push(path);
      if (!stack_push) return;

      const stack_push_code = generate(stack_push.node).code;
      vm.runInContext(stack_push_code, context);

      try {
        const str = vm.runInContext(function_call, context);
        if (isPrintableASCII(str)) path.replaceWith(t.stringLiteral(str));
      } catch { }
    }
  });
}

function get_push_target(ast) {
  const push_counts = new Map();

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!t.isIdentifier(callee.object)) return;
      if (!t.isIdentifier(callee.property)) return;
      if (callee.property.name !== "push") return;

      const name = callee.object.name;
      push_counts.set(name, (push_counts.get(name) ?? 0) + 1);
    }
  });

  if (push_counts.size === 0) return null;


  return [...push_counts.entries()].reduce((a, b) => b[1] > a[1] ? b : a)[0];
}

function deobfuscate(filePath) {
  let file, ast;
  try {
    file = fs.readFileSync(filePath, "utf-8");
    ast = parser.parse(file);
  } catch {
    console.log("[error] Enter a valid file.");
  }

  try {
    replace_stubs(ast);
    replace_static_vars(ast);
    replace_static_vars(ast);
    flatten(ast);

    replace_arr_calls(ast);
    remove_safe_typeof_check(ast);

    const replaced = replace_function_calls(ast);
    const ctx = createObfuscatedContext(filePath);
    const st = get_push_target(ast);
    replace_functions_with_string(ast, replaced, ctx, st);

  } catch (e) {
    console.log("[error] Invalid/Unsupported Akamai JS file.: ", e)
    return null;
  }

  return generate(ast).code;
}

export default deobfuscate;
