import fs from "fs";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import generator from "@babel/generator";
import vm from "vm";
import { JSDOM } from "jsdom";

const generate = generator.default;

function createObfuscatedContext(filePath) {
  const fileContent = fs.readFileSync(filePath, "utf-8");

  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: "https://delta.com/",
    referrer: "https://delta.com/",
    contentType: "text/html",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    runScripts: "dangerously",
    resources: "usable",
  });

  const context = dom.getInternalVMContext();

  Object.assign(dom.window, {
    Buffer: Buffer,
    process: process,
    console: console,
  });

  const ast = parser.parse(fileContent, {});
  let expressionStatement = ast.program.body[1].expression.callee.body.body;

  const statementTypes = [
    { type: t.isVariableDeclaration },
    { type: t.isFunctionDeclaration },
    { type: t.isExpressionStatement },
    {
      type: (s) => t.isReturnStatement(s) && t.isCallExpression(s.argument),
      isReturn: true,
    },
  ];

  statementTypes.forEach(({ type, isReturn }) => {
    expressionStatement.forEach((statement) => {
      if (type(statement)) {
        try {
          const code = isReturn
            ? generate(statement.argument).code
            : generate(statement).code;
          vm.runInContext(code, context);
        } catch (error) { }
      }
    });
  });

  return context;
}
export default createObfuscatedContext;